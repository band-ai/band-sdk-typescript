import type { AgentToolsRestApi } from "../client/rest/types";
import { DEFAULT_REQUEST_OPTIONS } from "../client/rest/requestOptions";
import type { AdapterToolsProtocol, AgentToolsCapabilities } from "../contracts/protocols";
import type { MetadataMap, ParticipantRecord } from "../contracts/dtos";
import { mapParticipantRecord } from "./tools/ContactCallbackTools";
import { UnsupportedFeatureError } from "../core/errors";
import type { ConversationContext, PlatformMessage } from "./types";
import { AgentTools } from "./tools/AgentTools";
import { MessageRetryTracker } from "./retryTracker";
import { buildParticipantsMessage } from "./formatters";

export type ExecutionState = "starting" | "idle" | "processing";

interface ExecutionContextLink {
  rest: AgentToolsRestApi;
  capabilities?: Partial<AgentToolsCapabilities>;
}

export interface ExecutionContextOptions {
  roomId: string;
  link: ExecutionContextLink;
  maxContextMessages: number;
  maxMessageRetries?: number;
  enableContextCache?: boolean;
  contextCacheTtlSeconds?: number;
  enableContextHydration?: boolean;
}

const DEDUP_CACHE_MAX = 500;

export class ExecutionContext {
  public readonly roomId: string;
  public readonly link: ExecutionContextLink;
  private readonly maxContextMessages: number;
  private readonly enableContextCache: boolean;
  private readonly contextCacheTtlMs: number;
  private readonly enableContextHydration: boolean;
  private readonly history: PlatformMessage[] = [];
  private messageIds = new Set<string>();
  private readonly dedupCache = new Map<string, true>();
  private participants: ParticipantRecord[] = [];
  private readonly tools: AgentTools;
  private readonly adapterTools: AdapterToolsProtocol;
  private participantsMessage: string | null = null;
  private lastSentParticipantIds: Set<string> | null = null;
  private contactsMessage: string | null = null;
  private contextCache: ConversationContext | null = null;
  private contextCacheExpiresAt = 0;

  private _state: ExecutionState = "starting";
  private readonly retryTrackerInstance: MessageRetryTracker;
  private _llmInitialized = false;
  private readonly _pendingSystemMessages: string[] = [];

  public constructor(options: ExecutionContextOptions) {
    this.roomId = options.roomId;
    this.link = options.link;
    this.maxContextMessages = options.maxContextMessages;
    this.enableContextCache = options.enableContextCache ?? true;
    this.contextCacheTtlMs = Math.max(0, (options.contextCacheTtlSeconds ?? 300) * 1000);
    this.enableContextHydration = options.enableContextHydration ?? true;
    this.retryTrackerInstance = new MessageRetryTracker(options.maxMessageRetries ?? 1);
    this.tools = new AgentTools({
      roomId: this.roomId,
      rest: this.link.rest,
      participants: this.participants,
      capabilities: this.link.capabilities,
    });
    this.adapterTools = this.tools.getAdapterTools();
  }

  public get state(): ExecutionState {
    return this._state;
  }

  public setState(state: ExecutionState): void {
    this._state = state;
  }

  public getRetryTracker(): MessageRetryTracker {
    return this.retryTrackerInstance;
  }

  public get isLlmInitialized(): boolean {
    return this._llmInitialized;
  }

  public markLlmInitialized(): void {
    this._llmInitialized = true;
  }

  public injectSystemMessage(message: string): void {
    this._pendingSystemMessages.push(message);
  }

  public consumeSystemMessages(): string[] {
    const copy = [...this._pendingSystemMessages];
    this._pendingSystemMessages.length = 0;
    return copy;
  }

  public getTools(): AdapterToolsProtocol {
    return this.adapterTools;
  }

  public hasMessage(messageId: string): boolean {
    return this.messageIds.has(messageId) || this.dedupCache.has(messageId);
  }

  public recordMessage(message: PlatformMessage): void {
    if (this.hasMessage(message.id)) {
      return;
    }

    this.trackDedup(message.id);
    this.history.push(message);
    if (this.history.length > this.maxContextMessages) {
      this.history.splice(0, this.history.length - this.maxContextMessages);
    }
    this.rebuildMessageIds();

    if (this.contextCache) {
      this.contextCache.messages.push(this.toHistoryEntry(message));
      if (this.contextCache.messages.length > this.maxContextMessages) {
        this.contextCache.messages.splice(0, this.contextCache.messages.length - this.maxContextMessages);
      }
      this.contextCache.hydratedAt = new Date();
      this.contextCacheExpiresAt = this.nextCacheExpiry();
    }
  }

  public getRawHistory(): MetadataMap[] {
    return this.history.map((entry) => ({
      id: entry.id,
      room_id: entry.roomId,
      content: entry.content,
      sender_id: entry.senderId,
      sender_type: entry.senderType,
      sender_name: entry.senderName,
      message_type: entry.messageType,
      metadata: entry.metadata,
      created_at: entry.createdAt.toISOString(),
      role: entry.senderType === "User" ? "user" : "assistant",
    }));
  }

  public setParticipants(participants: ParticipantRecord[]): void {
    this.replaceParticipants(participants);
    this.updateCachedParticipants();
  }

  public addParticipant(participant: ParticipantRecord): void {
    const existingIndex = this.participants.findIndex((entry) => entry.id === participant.id);
    if (existingIndex >= 0) {
      this.participants.splice(existingIndex, 1);
    }
    this.participants.push(participant);
    const name = String(participant.name ?? "unknown");
    this.participantsMessage = `${name} joined the room.`;
    this.updateCachedParticipants();
  }

  public removeParticipant(participantId: string): void {
    const removed = this.participants.find((entry) => String(entry.id) === participantId);
    const next = this.participants.filter((entry) => String(entry.id) !== participantId);
    this.replaceParticipants(next);
    if (removed) {
      this.participantsMessage = `${String(removed.name ?? participantId)} left the room.`;
    }
    this.updateCachedParticipants();
  }

  public setContactsMessage(message: string | null): void {
    this.contactsMessage = message;
  }

  public consumeParticipantsMessage(): string | null {
    const currentIds = new Set(this.participants.map((p) => String(p.id)));
    let changed = !this.lastSentParticipantIds
      || currentIds.size !== this.lastSentParticipantIds.size;
    if (!changed) {
      for (const id of currentIds) {
        if (!this.lastSentParticipantIds!.has(id)) {
          changed = true;
          break;
        }
      }
    }

    if (!changed && !this.participantsMessage) {
      return null;
    }

    const parts: string[] = [];
    if (this.participantsMessage) {
      parts.push(this.participantsMessage);
      this.participantsMessage = null;
    }

    if (changed) {
      const asRecords = this.participants.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        handle: p.handle ?? null,
      }));
      parts.push(buildParticipantsMessage(asRecords));
    }

    this.lastSentParticipantIds = currentIds;
    return parts.length > 0 ? parts.join("\n") : null;
  }

  public consumeContactsMessage(): string | null {
    const value = this.contactsMessage;
    this.contactsMessage = null;
    return value;
  }

  public async getHydratedHistory(excludeMessageId?: string): Promise<MetadataMap[]> {
    if (!this.enableContextHydration || !this.link.rest.getChatContext) {
      return this.getRawHistory().filter((entry) => entry.id !== excludeMessageId);
    }

    try {
      const context = await this.hydrateContext();
      return context.messages.filter((entry) => entry.id !== excludeMessageId);
    } catch (error) {
      if (error instanceof UnsupportedFeatureError) {
        return this.getRawHistory().filter((entry) => entry.id !== excludeMessageId);
      }

      throw error;
    }
  }

  public async hydrateContext(forceRefresh = false): Promise<ConversationContext> {
    if (!this.enableContextHydration || !this.link.rest.getChatContext) {
      return this.buildLocalContext();
    }

    if (!forceRefresh && this.enableContextCache && this.contextCache && !this.isCacheExpired()) {
      return this.contextCache;
    }

    try {
      const participants = await this.loadParticipants();
      const messages = await this.loadHydratedMessages();
      const context: ConversationContext = {
        roomId: this.roomId,
        messages,
        participants,
        hydratedAt: new Date(),
      };
      this.contextCache = context;
      this.contextCacheExpiresAt = this.nextCacheExpiry();
      return context;
    } catch (error) {
      if (!(error instanceof UnsupportedFeatureError)) {
        throw error;
      }

      const fallback = this.buildLocalContext();
      this.contextCache = fallback;
      this.contextCacheExpiresAt = this.nextCacheExpiry();
      return fallback;
    }
  }

  private replaceParticipants(participants: ParticipantRecord[]): void {
    this.participants.splice(0, this.participants.length, ...participants);
  }

  private buildLocalContext(): ConversationContext {
    return {
      roomId: this.roomId,
      messages: this.getRawHistory(),
      participants: [...this.participants],
      hydratedAt: new Date(),
    };
  }

  private async loadParticipants(): Promise<ParticipantRecord[]> {
    const participants = await this.link.rest.listChatParticipants(this.roomId, DEFAULT_REQUEST_OPTIONS);
    const normalized = participants.map((participant) => mapParticipantRecord(participant));
    this.replaceParticipants(normalized);
    return [...this.participants];
  }

  private async loadHydratedMessages(): Promise<MetadataMap[]> {
    const messages: MetadataMap[] = [];
    const pageSize = Math.min(Math.max(this.maxContextMessages, 1), 100);
    const maxPages = 100;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.link.rest.getChatContext?.(
        {
          chatId: this.roomId,
          page,
          pageSize,
        },
        DEFAULT_REQUEST_OPTIONS,
      );
      const items = response?.data ?? [];
      messages.push(...items.map((item) => ({
        id: item.id,
        room_id: this.roomId,
        content: item.content,
        sender_id: item.sender_id,
        sender_type: item.sender_type,
        sender_name: item.sender_name ?? null,
        message_type: item.message_type,
        metadata: item.metadata ?? {},
        created_at: item.inserted_at,
        role: item.sender_type === "User" ? "user" : "assistant",
      })));

      const totalPages = response?.metadata?.totalPages;
      if (typeof totalPages === "number" && totalPages > 0 && page >= totalPages) {
        break;
      }
      if ((typeof totalPages !== "number" || totalPages <= 0) && items.length < pageSize) {
        break;
      }
    }

    return messages.slice(-this.maxContextMessages);
  }

  private updateCachedParticipants(): void {
    if (!this.contextCache) {
      return;
    }

    this.contextCache.participants = [...this.participants];
    this.contextCache.hydratedAt = new Date();
    this.contextCacheExpiresAt = this.nextCacheExpiry();
  }

  private isCacheExpired(): boolean {
    return this.contextCacheExpiresAt > 0 && Date.now() >= this.contextCacheExpiresAt;
  }

  private nextCacheExpiry(): number {
    if (!this.enableContextCache || this.contextCacheTtlMs === 0) {
      return 0;
    }

    return Date.now() + this.contextCacheTtlMs;
  }

  private toHistoryEntry(message: PlatformMessage): MetadataMap {
    return {
      id: message.id,
      room_id: message.roomId,
      content: message.content,
      sender_id: message.senderId,
      sender_type: message.senderType,
      sender_name: message.senderName,
      message_type: message.messageType,
      metadata: message.metadata,
      created_at: message.createdAt.toISOString(),
      role: message.senderType === "User" ? "user" : "assistant",
    };
  }

  private rebuildMessageIds(): void {
    this.messageIds = new Set(this.history.map((entry) => entry.id));
  }

  private trackDedup(messageId: string): void {
    this.dedupCache.set(messageId, true);
    if (this.dedupCache.size > DEDUP_CACHE_MAX) {
      const first = this.dedupCache.keys().next();
      if (!first.done) {
        this.dedupCache.delete(first.value);
      }
    }
  }
}

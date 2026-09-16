import { resolveLogger, type Logger } from "../core/logger";
import { SingleFlight } from "../core/singleFlight";
import { Session } from "./Session";
import { FernRestAdapter } from "../client/rest/RestFacade";
import type { FernBandClientLike } from "../client/rest/types";
import type { RestRequestOptions } from "../client/rest/requestOptions";
import {
  fetchPaginated,
  type PaginationOptions,
} from "../client/rest/pagination";
import type {
  PaginatedResponse,
  PlatformChatMessage,
  BandLinkRestApi,
} from "../client/rest/types";
import type { PlatformEvent } from "./events";
import { UnsupportedFeatureError } from "../core/errors";
import { assertCapability } from "../contracts/capabilities";
import type { MetadataMap } from "../contracts/dtos";
import type { PlatformMessageLike as PlatformMessage } from "../contracts/protocols";
import {
  type SupportedSocketEvent,
  payloadSchemas,
} from "./streaming/payloadSchemas";
import { PhoenixChannelsTransport } from "./streaming/PhoenixChannelsTransport";
import type { StreamingTransport } from "./streaming/transport";
import {
  WebSocketDisconnectError,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./streaming/disconnectReason";
import {
  DEFAULT_AGENT_TOOLS_CAPABILITIES,
  type AgentToolsCapabilities,
} from "../contracts/protocols";
import { BandClient } from "@band-ai/rest-client";
import { agentContactsTopic, agentRoomsTopic } from "@band-ai/band-sdk-core";
import { SubscriptionManager } from "./SubscriptionManager";

export interface BandLinkOptions {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  restUrl?: string;
  restApi?: BandLinkRestApi;
  transport?: StreamingTransport;
  logger?: Logger;
  capabilities?: Partial<AgentToolsCapabilities>;
  conflictPolicy?: WebSocketConflictPolicy;
}

const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";

export function deriveDefaultRestUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  const protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  return `${protocol}//${parsed.host}`;
}

interface PendingWaiter {
  resolve: (event: PlatformEvent | null) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export interface MessageMarkOptions {
  bestEffort?: boolean;
}

function toPlatformMessage(
  roomId: string,
  message: PlatformChatMessage,
): PlatformMessage {
  return {
    id: message.id,
    roomId,
    content: message.content,
    senderId: message.sender_id,
    senderType: message.sender_type,
    senderName: message.sender_name ?? null,
    messageType: message.message_type,
    metadata: (message.metadata ?? {}),
    createdAt: new Date(message.inserted_at),
  };
}

export class BandLink implements AsyncIterable<PlatformEvent> {
  public readonly agentId: string;
  private readonly apiKey: string;
  public readonly wsUrl: string;
  public readonly restUrl: string;
  public readonly rest: BandLinkRestApi;
  public readonly capabilities: AgentToolsCapabilities;

  private readonly logger: Logger;
  private readonly transport: StreamingTransport;
  private readonly subscriptionManager: SubscriptionManager;
  private readonly eventQueue: PlatformEvent[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private connected = false;
  private lastDisconnectReason: WebSocketDisconnectReason | null = null;
  private terminalDisconnectError: WebSocketDisconnectError | null = null;
  private readonly connectFlight = new SingleFlight<void>();
  private readonly disconnectFlight = new SingleFlight<void>();
  private readonly session = new Session();

  public constructor(options: BandLinkOptions) {
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
    this.restUrl = options.restUrl ?? deriveDefaultRestUrl(this.wsUrl);
    this.logger = resolveLogger(options.logger);
    this.capabilities = {
      ...DEFAULT_AGENT_TOOLS_CAPABILITIES,
      ...options.capabilities,
    };

    const restApi =
      options.restApi ??
      new FernRestAdapter(
        new BandClient({
          apiKey: this.apiKey,
          baseUrl: this.restUrl,
        }),
      );

    this.rest = restApi;

    this.transport =
      options.transport ??
      new PhoenixChannelsTransport({
        wsUrl: this.wsUrl,
        apiKey: this.apiKey,
        agentId: this.agentId,
        logger: this.logger,
        conflictPolicy: options.conflictPolicy,
        onTerminalDisconnect: (reason) => {
          this.recordDisconnectReason(reason);
        },
      });

    this.subscriptionManager = new SubscriptionManager({
      transport: this.transport,
      logger: this.logger,
    });
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.lastDisconnectReason;
  }

  public async connect(): Promise<void> {
    if (this.disconnectFlight.current) {
      await this.disconnectFlight.current.catch(() => undefined);
    }
    if (this.connected) {
      return;
    }

    await this.connectFlight.run(() => {
      const epoch = this.session.begin();
      return this.connectSession(epoch);
    });
  }

  private async connectSession(epoch: number): Promise<void> {
    this.session.setReconnectObserverTeardown(
      this.transport.onReconnected?.(async (snapshot) => {
        await this.subscriptionManager.reconcileReconnect(snapshot);
        if (this.session.isStale(epoch)) {
          this.logger.debug(
            "Reconnect reconciliation settled after session ended, discarding reconnected event",
          );
          return;
        }
        this.queueEvent({ type: "reconnected", roomId: null, payload: {} });
      }) ?? null,
    );

    try {
      await this.transport.connect();
    } catch (error) {
      this.session.clearReconnectObserver();
      this.session.deactivate();
      this.subscriptionManager.endSession();
      if (error instanceof WebSocketDisconnectError) {
        if (error.reason.retryable) {
          this.lastDisconnectReason = error.reason;
        } else {
          this.recordDisconnectError(error);
        }
      }
      throw error;
    }
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    await this.disconnectFlight.run(() => this.disconnectSession());
  }

  private async disconnectSession(): Promise<void> {
    await this.connectFlight.current?.catch(() => undefined);
    // By now any in-flight connect has fully settled, so the session's own
    // active flag alone reflects whether there is a session to tear down.
    if (!this.session.isActive) {
      return;
    }

    this.session.deactivate();

    try {
      await this.transport.disconnect();
    } finally {
      this.connected = false;
      this.session.clearReconnectObserver();
      this.subscriptionManager.endSession();
    }
  }

  public async runForever(signal: AbortSignal): Promise<void> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    await this.transport.runForever(signal);
  }

  private recordDisconnectReason(reason: WebSocketDisconnectReason): void {
    this.recordDisconnectError(new WebSocketDisconnectError(reason));
  }

  private recordDisconnectError(error: WebSocketDisconnectError): void {
    this.connected = false;
    this.lastDisconnectReason = error.reason;
    this.terminalDisconnectError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  public queueEvent(event: PlatformEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(event);
      return;
    }

    this.eventQueue.push(event);
  }

  public async subscribeAgentRooms(): Promise<void> {
    await this.subscriptionManager.subscribeAgentTopic(agentRoomsTopic(this.agentId), {
      room_added: (payload) => {
        const roomId = typeof payload.id === "string" ? payload.id : "";
        this.emit("room_added", payload, roomId);
      },
      room_removed: (payload) => {
        const roomId = typeof payload.id === "string" ? payload.id : "";
        this.emit("room_removed", payload, roomId);
      },
    });
  }

  public async subscribeRoom(roomId: string): Promise<void> {
    await this.subscriptionManager.subscribeRoom(roomId, {
      chat: {
        message_created: (payload) => {
          this.emit("message_created", payload, roomId);
        },
      },
      participants: {
        participant_added: (payload) => {
          this.emit("participant_added", payload, roomId);
        },
        participant_removed: (payload) => {
          this.emit("participant_removed", payload, roomId);
        },
        room_deleted: (payload) => {
          this.emit("room_deleted", payload, roomId);
        },
      },
    });
  }

  public async unsubscribeRoom(roomId: string): Promise<void> {
    await this.subscriptionManager.unsubscribeRoom(roomId);
  }

  public async subscribeAgentContacts(): Promise<void> {
    assertCapability(this.capabilities, "contacts", "Contacts streaming");
    await this.subscriptionManager.subscribeAgentTopic(agentContactsTopic(this.agentId), {
      contact_request_received: (payload) => {
        this.emit("contact_request_received", payload, null);
      },
      contact_request_updated: (payload) => {
        this.emit("contact_request_updated", payload, null);
      },
      contact_added: (payload) => {
        this.emit("contact_added", payload, null);
      },
      contact_removed: (payload) => {
        this.emit("contact_removed", payload, null);
      },
    });
  }

  public async unsubscribeAgentContacts(): Promise<void> {
    await this.subscriptionManager.unsubscribeAgentTopic(agentContactsTopic(this.agentId));
  }

  public async nextEvent(signal?: AbortSignal): Promise<PlatformEvent | null> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    if (signal?.aborted) {
      return null;
    }

    const queued = this.eventQueue.shift();
    if (queued) {
      return queued;
    }

    return new Promise<PlatformEvent | null>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        finalizeResolve(null);
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const finalizeResolve = (event: PlatformEvent | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(event);
      };
      const finalizeReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const waiter: PendingWaiter = {
        resolve: finalizeResolve,
        reject: finalizeReject,
        cleanup,
      };

      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  public [Symbol.asyncIterator](): AsyncIterator<PlatformEvent> {
    return {
      next: async () => {
        const value = await this.nextEvent();
        if (value === null) {
          return {
            done: true,
            value: undefined,
          } as IteratorReturnResult<undefined>;
        }
        return { done: false, value };
      },
    };
  }

  public async markProcessing(
    roomId: string,
    messageId: string,
    options?: MessageMarkOptions,
  ): Promise<void> {
    await this.markMessageStatus(
      "markProcessing",
      {
        roomId,
        messageId,
      },
      () => this.rest.markMessageProcessing(roomId, messageId),
      options,
    );
  }

  public async markProcessed(
    roomId: string,
    messageId: string,
    options?: MessageMarkOptions,
  ): Promise<void> {
    await this.markMessageStatus(
      "markProcessed",
      {
        roomId,
        messageId,
      },
      () => this.rest.markMessageProcessed(roomId, messageId),
      options,
    );
  }

  public async markFailed(
    roomId: string,
    messageId: string,
    error: string,
    options?: MessageMarkOptions,
  ): Promise<void> {
    const normalizedError = error.trim() || "Unknown error";
    await this.markMessageStatus(
      "markFailed",
      {
        roomId,
        messageId,
        error: normalizedError,
      },
      () => this.rest.markMessageFailed(roomId, messageId, normalizedError),
      options,
    );
  }

  private async markMessageStatus(
    operation: "markProcessing" | "markProcessed" | "markFailed",
    context: {
      roomId: string;
      messageId: string;
      error?: string;
    },
    mark: () => Promise<unknown>,
    options?: MessageMarkOptions,
  ): Promise<void> {
    try {
      await mark();
    } catch (error: unknown) {
      if (!options?.bestEffort) {
        throw error;
      }

      this.logger.warn(`${operation} failed (best-effort)`, {
        ...context,
        error,
      });
    }
  }

  public async getNextMessage(roomId: string): Promise<PlatformMessage | null> {
    try {
      if (!this.rest.getNextMessage) {
        return null;
      }

      const message = await this.rest.getNextMessage({ chatId: roomId });
      return message ? toPlatformMessage(roomId, message) : null;
    } catch (error) {
      if (error instanceof UnsupportedFeatureError) {
        return null;
      }
      throw error;
    }
  }

  public async getStaleProcessingMessages(
    roomId: string,
  ): Promise<PlatformMessage[]> {
    if (!this.rest.listMessages) {
      return [];
    }

    const response = await this.rest.listMessages({
      chatId: roomId,
      page: 1,
      pageSize: 50,
      status: "processing",
    });

    return response.data.map((msg) => toPlatformMessage(roomId, msg));
  }

  public async listChats(
    request: { page: number; pageSize: number },
    requestOptions?: RestRequestOptions,
  ): Promise<PaginatedResponse> {
    if (!this.rest.listChats) {
      throw new UnsupportedFeatureError(
        "Chat listing is not available in current REST adapter",
      );
    }

    return this.rest.listChats(request, requestOptions);
  }

  public async listAllChats(
    options?: PaginationOptions,
    requestOptions?: RestRequestOptions,
  ): Promise<MetadataMap[]> {
    return fetchPaginated({
      fetchPage: ({ page, pageSize }) =>
        this.listChats({ page, pageSize }, requestOptions),
      pageSize: options?.pageSize,
      maxPages: options?.maxPages,
      strategy: options?.strategy,
      metadataValidation: options?.metadataValidation,
    });
  }

  private emit(
    eventType: SupportedSocketEvent,
    payload: Record<string, unknown>,
    roomId: string | null,
  ): void {
    const schema = payloadSchemas[eventType];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn(`Invalid ${eventType} payload, dropping event`, {
        error: parsed.error.message,
        roomId,
      });
      return;
    }

    this.queueEvent({
      type: eventType,
      roomId,
      payload: parsed.data,
      raw: payload,
    } as PlatformEvent);
  }
}

import { resolveLogger, type Logger } from "../core/logger";
import { SingleFlight } from "../core/singleFlight";
import { eitherSignal } from "../core/signals";
import { Session } from "./Session";
import { FernRestAdapter } from "../client/rest/RestFacade";
import { ActivityCapability } from "../client/rest/activityCapability";
import type { ReportActivityOptions, RestRequestOptions } from "../client/rest/requestOptions";
import {
  fetchPaginated,
  type PaginationOptions,
} from "../client/rest/pagination";
import type {
  PaginatedResponse,
  PlatformChatMessage,
  BandLinkRestApi,
} from "../client/rest/types";
import { messageIdOf, type PlatformEvent, type SupportedSocketEvent } from "./events";
import { UnsupportedFeatureError } from "../core/errors";
import { assertCapability, pruneUnsupported } from "../contracts/capabilities";
import type { MetadataMap } from "../contracts/dtos";
import type { LinkDisconnectReason } from "../contracts/events";
import type { PlatformMessageLike as PlatformMessage } from "../contracts/protocols";
import { PhoenixChannelsTransport } from "./streaming/PhoenixChannelsTransport";
import type { StreamingTransport } from "./streaming/transport";
import type {
  WebSocketDisconnectError,
  WebSocketConflictPolicy,
  WebSocketDisconnectReason,
} from "./streaming/disconnectReason";
import {
  DEFAULT_AGENT_TOOLS_CAPABILITIES,
  type AgentToolsCapabilities,
} from "../contracts/protocols";
import { BandClient } from "@band-ai/rest-client";
import {
  agentContactsTopic,
  agentRoomsTopic,
  validateEventPayload,
} from "@band-ai/band-sdk-core";
import { SubscriptionManager } from "./SubscriptionManager";
import { roomIdOfChatTopic } from "./roomTopics";

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

export const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";

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

function validationErrorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const details: Record<string, unknown> = {};
  if ("issues" in error) {
    details.issues = error.issues;
  }
  if ("traceContext" in error) {
    details.traceContext = error.traceContext;
  }
  return details;
}

/** A change in whether this link can reach Band; see `BandLink.onConnectionChange`. */
export type LinkConnectionChange =
  | { connected: true; reconnected: boolean }
  | { connected: false; reason: LinkDisconnectReason };

/** What listeners were last told about reachability (down reasons included). */
type ReportedConnection =
  | { connected: true }
  | { connected: false; reason: LinkDisconnectReason };

export class BandLink implements AsyncIterable<PlatformEvent> {
  public readonly agentId: string;
  private readonly apiKey: string;
  public readonly wsUrl: string;
  public readonly restUrl: string;
  public readonly rest: BandLinkRestApi;
  private _capabilities: AgentToolsCapabilities;

  private readonly logger: Logger;
  private readonly transport: StreamingTransport;
  private readonly subscriptionManager: SubscriptionManager;
  private readonly eventQueue: PlatformEvent[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private connected = false;
  private readonly connectFlight = new SingleFlight<void>();
  /** Aborts the in-flight connect, so a disconnect never waits out a retrying boot. */
  private connectAbort: AbortController | null = null;
  private readonly disconnectFlight = new SingleFlight<void>();
  private readonly session = new Session();
  private readonly connectionListeners = new Set<(change: LinkConnectionChange) => void>();
  /** Last reachability report, so each up and each distinct down reason is told once. */
  private reported: ReportedConnection | null = null;

  public get capabilities(): AgentToolsCapabilities { return this._capabilities; }

  public dropUnsupported(featureFlags?: Readonly<Record<string, boolean>>): void {
    this._capabilities = pruneUnsupported(this._capabilities, featureFlags);
  }

  /**
   * Reports each transition between reaching Band and not: up after a
   * connect or a reconnect, down on a drop the transport retries, a local
   * disconnect, or a session that ended for good. A later down with a
   * different reason is reported even when the link was already down.
   * Returns an unsubscribe function.
   */
  public onConnectionChange(listener: (change: LinkConnectionChange) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private reportConnection(change: LinkConnectionChange): void {
    if (change.connected) {
      if (this.reported?.connected === true) {
        return;
      }
      this.reported = { connected: true };
    } else if (this.reported?.connected === false
      && (this.reported.reason === change.reason || this.reported.reason === "terminal")) {
      // Terminal is the final down; a later local disconnect adds nothing.
      return;
    } else {
      this.reported = { connected: false, reason: change.reason };
    }
    for (const listener of [...this.connectionListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.logger.warn("Connection change listener failed", { error });
      }
    }
  }

  public constructor(options: BandLinkOptions) {
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
    this.restUrl = options.restUrl ?? deriveDefaultRestUrl(this.wsUrl);
    this.logger = resolveLogger(options.logger);
    this._capabilities = {
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
        { activityCapability: new ActivityCapability({ origin: this.restUrl, logger: this.logger }) },
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
      });
    this.transport.onTerminal((error) => this.handleTerminal(error));

    this.subscriptionManager = new SubscriptionManager({
      transport: this.transport,
      logger: this.logger,
    });
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.transport.getDisconnectReason();
  }

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.disconnectFlight.current) {
      await this.disconnectFlight.current.catch(() => undefined);
    }
    if (this.connected) {
      return;
    }

    await this.connectFlight.run(async () => {
      const abort = new AbortController();
      this.connectAbort = abort;
      try {
        await this.connectSession(this.session.begin(), eitherSignal(abort.signal, signal));
      } finally {
        this.connectAbort = null;
      }
    });
  }

  private async connectSession(epoch: number, signal: AbortSignal): Promise<void> {
    // Counts drops for this connect epoch so a reconnect that finishes after a
    // newer drop does not report a stale up.
    let dropGeneration = 0;
    // Per connectSession, not link lifetime: a prior closed/terminal leaves
    // `reported` non-null, but this session still has not told observers it is up.
    let reportedUp = false;
    const stopReconnected = this.transport.onReconnected?.(async (snapshot) => {
      const dropsSeen = dropGeneration;
      await this.subscriptionManager.reconcileReconnect(snapshot);
      if (this.session.isStale(epoch)) {
        this.logger.debug(
          "Reconnect reconciliation settled after session ended, discarding reconnected event",
        );
        return;
      }
      this.queueEvent({ type: "reconnected", roomId: null, payload: {} });
      // Observers hear an up only after this session's first up, and not for
      // a reconcile that a newer drop already made stale.
      if (reportedUp && dropGeneration === dropsSeen) {
        this.reportConnection({ connected: true, reconnected: true });
      }
    });
    const stopRejoined = this.transport.onTopicRejoined?.((topic) => this.queueRejoinCatchUp(topic, epoch));
    const stopDropped = this.transport.onDropped?.(() => {
      if (this.session.isStale(epoch)) {
        return;
      }
      dropGeneration += 1;
      // Observers only learn about downs after this session's first up.
      if (!reportedUp) {
        return;
      }
      this.reportConnection({ connected: false, reason: "dropped" });
    });
    this.session.reconnectObserverTeardown = () => {
      stopReconnected?.();
      stopRejoined?.();
      stopDropped?.();
    };

    try {
      await this.transport.connect(signal);
    } catch (error) {
      this.session.clearReconnectObserver();
      this.session.deactivate();
      // The failed connect may have already opened the socket and joined
      // some channels (e.g. agent_control succeeded but a later step threw)
      // — tear those down too, or they leak until the next successful
      // connect's disconnect() call, orphaned in Phoenix's own reconnect
      // machinery with no session left to own them.
      await this.transport.disconnect().catch(() => undefined);
      this.subscriptionManager.endSession();
      throw error;
    }
    this.connected = true;
    reportedUp = true;
    this.reportConnection({ connected: true, reconnected: false });
  }

  /**
   * A channel that rejoined on a live socket lost whatever was sent while it
   * was gone. The room's own catch-up runs for a chat topic, the whole agent's
   * for `agent_rooms`; any other topic has nothing to sweep.
   */
  private queueRejoinCatchUp(topic: string, epoch: number): void {
    if (this.session.isStale(epoch)) {
      return;
    }
    const roomId = topic === agentRoomsTopic(this.agentId) ? null : roomIdOfChatTopic(topic);
    if (roomId === undefined) {
      return;
    }
    this.logger.debug("rejoin catch-up queued", { topic, roomId });
    this.queueEvent({ type: "reconnected", roomId, payload: {} });
  }

  public async disconnect(): Promise<void> {
    await this.disconnectFlight.run(() => this.disconnectSession());
  }

  private async disconnectSession(): Promise<void> {
    this.connectAbort?.abort();
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
      this.reportConnection({ connected: false, reason: "closed" });
      this.session.clearReconnectObserver();
      this.subscriptionManager.endSession();
    }
  }

  public async runForever(signal: AbortSignal): Promise<void> {
    this.throwIfTerminal();

    await this.transport.runForever(signal);
  }

  private throwIfTerminal(): void {
    const error = this.transport.getTerminalError();
    if (error) {
      throw error;
    }
  }

  /** The transport's session ended for good: nothing more will arrive. */
  private handleTerminal(error: WebSocketDisconnectError): void {
    this.connected = false;
    this.reportConnection({ connected: false, reason: "terminal" });
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
    this.throwIfTerminal();

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

  public async reportActivity(roomId: string, working: boolean, options?: ReportActivityOptions): Promise<{ working: boolean }> {
    if (!this.rest.reportActivity) throw new UnsupportedFeatureError("Activity reporting is not available in current REST adapter");
    return await this.rest.reportActivity(roomId, working, options);
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
    this.logger.debug("platform event received", {
      eventType,
      roomId,
      messageId: messageIdOf({ type: eventType, payload }),
    });
    try {
      const normalizedPayload = validateEventPayload(eventType, payload);
      this.queueEvent({
        type: eventType,
        roomId,
        payload: normalizedPayload,
        raw: payload,
      } as PlatformEvent);
    } catch (error) {
      this.logger.warn(`Invalid ${eventType} payload, dropping event`, {
        ...validationErrorDetails(error),
        roomId,
      });
    }
  }
}

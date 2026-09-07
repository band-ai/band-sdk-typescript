import { TransportError, ValidationError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import { PhoenixChannelsTransport } from "../platform/streaming/PhoenixChannelsTransport";
import type { TopicHandlers } from "../platform/streaming/transport";
import type { WebSocketDisconnectReason } from "../platform/streaming/disconnectReason";
import {
  ActivityState,
  canonicalizeUuid,
  decodeActivitySnapshot,
  decodeActivityStart,
  decodeActivityStop,
} from "./activity";
import {
  isValidRoomId,
  isValidTopicIdentity,
  validateChatPayload,
  validateParticipantMutation,
  validatePresencePayload,
  validateRoomDeletedPayload,
  validateTitlePayload,
} from "./eventValidation";
import type {
  PrincipalRealtimeConnection,
  PrincipalRealtimeEvent,
  PrincipalRealtimeOptions,
  RealtimePrincipal,
} from "./types";

const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

function snapshotPrincipal(principal: RealtimePrincipal): RealtimePrincipal {
  if (principal.kind === "human") {
    if ("conflictPolicy" in principal || "agentId" in principal) {
      throw new ValidationError(
        "Human principal does not accept a conflict policy or agentId",
      );
    }
    if (!isValidTopicIdentity(principal.userId) || !principal.apiKey) {
      throw new ValidationError("Human principal requires userId and apiKey");
    }
    return Object.freeze({
      kind: "human",
      userId: principal.userId.trim(),
      apiKey: principal.apiKey,
    });
  }
  if (principal.kind !== "agent") {
    throw new ValidationError("Unsupported realtime principal");
  }
  const agentId = canonicalizeUuid(principal.agentId);
  if (!agentId || !principal.apiKey) {
    throw new ValidationError("Agent principal requires agentId and apiKey");
  }
  return Object.freeze({
    kind: "agent",
    agentId,
    apiKey: principal.apiKey,
    ...(principal.conflictPolicy
      ? { conflictPolicy: principal.conflictPolicy }
      : {}),
  });
}

export class PrincipalRealtimeConnectionImpl
  implements PrincipalRealtimeConnection
{
  private readonly principal: RealtimePrincipal;
  private readonly logger: Logger;
  private readonly abortSignal?: AbortSignal;
  private readonly transport: PhoenixChannelsTransport;
  private readonly activity = new ActivityState();
  private listener: ((event: PrincipalRealtimeEvent) => void) | null = null;
  private state: "connecting" | "ready" | "unavailable" = "unavailable";
  private selectedRoom: string | null = null;
  private selectionGeneration = 0;
  private socketGeneration = 0;
  private disposed = false;
  private startSucceeded = false;
  private startPromise: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTail: Promise<void> = Promise.resolve();
  private joinAbort: AbortController | null = null;
  private readonly onAbort = (): void => {
    void this.dispose();
  };

  public constructor(options: PrincipalRealtimeOptions) {
    this.principal = snapshotPrincipal(options.principal);
    this.logger = options.logger ?? new NoopLogger();
    this.abortSignal = options.abortSignal;
    const apiKey = this.principal.apiKey;
    const agentId =
      this.principal.kind === "agent" ? this.principal.agentId : undefined;
    const conflictPolicy =
      this.principal.kind === "agent"
        ? this.principal.conflictPolicy
        : undefined;

    this.transport = new PhoenixChannelsTransport({
      wsUrl: options.wsUrl ?? DEFAULT_WS_URL,
      apiKey,
      agentId,
      logger: this.logger,
      conflictPolicy,
      heartbeatIntervalMs: 30_000,
      reconnectAfterMs: () => Number.POSITIVE_INFINITY,
      abortSignal: this.abortSignal,
      onSocketClose: (reason) => {
        this.handleTransportClose(reason);
      },
      onTerminalDisconnect: (reason) => {
        this.markUnavailable(reason);
      },
    });

    this.abortSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  public getState(): "connecting" | "ready" | "unavailable" {
    return this.state;
  }

  public subscribe(
    listener: (event: PrincipalRealtimeEvent) => void,
  ): () => void {
    if (this.listener) {
      throw new ValidationError(
        "Principal realtime connection already has an observer",
      );
    }
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }

  public async start(): Promise<void> {
    this.assertLive();
    if (this.startSucceeded && this.state === "ready") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.connectAndJoin();
    try {
      await this.startPromise;
      this.startSucceeded = true;
    } catch (error) {
      this.startSucceeded = false;
      this.markUnavailable();
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  public async setSelectedRoom(roomId: string | null): Promise<void> {
    this.assertLive();
    if (this.principal.kind === "agent") {
      throw new ValidationError(
        "Agent principal connections cannot select a room",
      );
    }
    if (roomId !== null && !isValidRoomId(roomId)) {
      throw new ValidationError("Invalid selected room id");
    }
    this.selectionGeneration += 1;
    const generation = this.selectionGeneration;
    this.selectionTail = this.selectionTail
      .catch(() => undefined)
      .then(() => this.applySelection(roomId, generation));
    return this.selectionTail;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.socketGeneration += 1;
    this.selectionGeneration += 1;
    this.clearReconnect();
    this.joinAbort?.abort();
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.listener = null;
    this.activity.clear();
    this.selectedRoom = null;
    this.state = "unavailable";
    await this.transport.disconnect().catch(() => undefined);
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private async applySelection(
    roomId: string | null,
    generation: number,
  ): Promise<void> {
    if (generation !== this.selectionGeneration || this.disposed) {
      return;
    }
    const previous = this.selectedRoom;
    this.joinAbort?.abort();
    this.joinAbort = new AbortController();
    await this.leaveRoomTopics(previous);
    if (generation !== this.selectionGeneration) {
      return;
    }
    this.selectedRoom = roomId;
    if (previous !== null) {
      this.activity.clear();
      this.emit({
        type: "room_activity",
        roomId: previous,
        state: "unavailable",
      });
    }
    if (roomId === null || !this.startSucceeded) {
      return;
    }
    await this.joinSelectedRoom(roomId, generation, this.joinAbort.signal);
  }

  private async connectAndJoin(): Promise<void> {
    if (this.abortSignal?.aborted) {
      throw new TransportError("Realtime connection aborted before start");
    }
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.setState("connecting");
    this.emit({ type: "connection", state: "connecting" });
    this.joinAbort?.abort();
    this.joinAbort = new AbortController();
    await this.transport.connect();
    if (this.disposed || generation !== this.socketGeneration) {
      return;
    }
    await this.joinMandatory(generation, this.joinAbort.signal);
    if (this.disposed || generation !== this.socketGeneration) {
      return;
    }
    this.setState("ready");
    this.emit({ type: "connection", state: "ready" });
  }

  private handleTransportClose(reason: WebSocketDisconnectReason | null): void {
    if (this.disposed) {
      return;
    }
    this.markUnavailable(reason ?? undefined);
    if (reason?.retryable === false) {
      return;
    }
    this.socketGeneration += 1;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.abortSignal?.aborted) {
      return;
    }
    this.clearReconnect();
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 30_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, this.reconnectAttempt === 1 ? 0 : delay);
  }

  private async reconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.connectAndJoin();
      this.startSucceeded = true;
      this.reconnectAttempt = 0;
    } catch {
      this.markUnavailable();
      this.scheduleReconnect();
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new TransportError("Realtime connection is disposed");
    }
  }

  private setState(state: "connecting" | "ready" | "unavailable"): void {
    this.state = state;
  }

  private emit(event: PrincipalRealtimeEvent): void {
    if (this.disposed || !this.listener) {
      return;
    }
    try {
      this.listener(event);
    } catch (error) {
      this.logger.error("Realtime observer failed", { error });
    }
  }

  private markUnavailable(reason?: WebSocketDisconnectReason): void {
    this.activity.clear();
    this.setState("unavailable");
    if (this.selectedRoom) {
      this.emit({
        type: "room_activity",
        roomId: this.selectedRoom,
        state: "unavailable",
      });
    }
    this.emit({ type: "connection", state: "unavailable", reason });
  }

  private async joinMandatory(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.principal.kind === "human") {
      await this.joinTopic(
        `user_agents:${this.principal.userId}`,
        this.userAgentHandlers(),
        generation,
        signal,
      );
      if (this.selectedRoom) {
        await this.joinSelectedRoom(
          this.selectedRoom,
          this.selectionGeneration,
          signal,
        );
      }
      return;
    }
    await this.joinTopic(
      `agent_control:${this.principal.agentId}`,
      {},
      generation,
      signal,
    );
  }

  private userAgentHandlers(): TopicHandlers {
    const emitChange = (): void => {
      this.emit({ type: "user_agents_changed" });
    };
    return {
      agent_created: emitChange,
      agent_updated: emitChange,
      agent_deleted: emitChange,
    };
  }

  private async joinSelectedRoom(
    roomId: string,
    selectionGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    const socketGeneration = this.socketGeneration;
    try {
      await this.joinTopic(
        `chat_room:${roomId}`,
        this.chatHandlers(roomId, selectionGeneration),
        socketGeneration,
        signal,
      );
      await this.joinTopic(
        `room_participants:${roomId}`,
        this.participantHandlers(roomId, selectionGeneration),
        socketGeneration,
        signal,
      );
      const payload = await this.joinTopic(
        `room_activity:${roomId}`,
        this.activityHandlers(roomId, selectionGeneration),
        socketGeneration,
        signal,
      );
      if (
        this.disposed ||
        selectionGeneration !== this.selectionGeneration ||
        this.selectedRoom !== roomId
      ) {
        await this.leaveRoomTopics(roomId);
        return;
      }
      this.applyActivitySnapshot(roomId, payload);
    } catch (error) {
      await this.leaveRoomTopics(roomId);
      this.activity.clear();
      this.emit({ type: "room_activity", roomId, state: "unavailable" });
      this.setState("unavailable");
      this.emit({ type: "connection", state: "unavailable" });
      throw error;
    }
  }

  private async leaveRoomTopics(roomId: string | null): Promise<void> {
    if (!roomId) {
      return;
    }
    await Promise.allSettled([
      this.transport.leave(`chat_room:${roomId}`),
      this.transport.leave(`room_participants:${roomId}`),
      this.transport.leave(`room_activity:${roomId}`),
    ]);
  }

  private async joinTopic(
    topic: string,
    handlers: TopicHandlers,
    generation: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const payload = await this.transport.joinWithResponse(
      topic,
      handlers,
      signal,
    );
    if (this.disposed || generation !== this.socketGeneration) {
      await this.transport.leave(topic).catch(() => undefined);
      return undefined;
    }
    return payload;
  }

  private chatHandlers(roomId: string, generation: number): TopicHandlers {
    const kinds = [
      "message_created",
      "message_updated",
      "event_created",
      "message_deleted",
    ] as const;
    const handlers: TopicHandlers = {};
    for (const kind of kinds) {
      handlers[kind] = (payload) => {
        if (!this.isCurrentRoom(roomId, generation)) {
          return;
        }
        if (!validateChatPayload(kind, payload, roomId)) {
          return;
        }
        this.emit({ type: "chat_changed", roomId, kind });
      };
    }
    return handlers;
  }

  private participantHandlers(
    roomId: string,
    generation: number,
  ): TopicHandlers {
    return {
      participant_added: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validateParticipantMutation(payload, roomId, "added")
        ) {
          this.emit({
            type: "participants_changed",
            roomId,
            kind: "added",
          });
        }
      },
      participant_removed: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validateParticipantMutation(payload, roomId, "removed")
        ) {
          this.emit({
            type: "participants_changed",
            roomId,
            kind: "removed",
          });
        }
      },
      agent_connected: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validatePresencePayload("agent_connected", payload, roomId)
        ) {
          this.emit({
            type: "participants_changed",
            roomId,
            kind: "presence_changed",
          });
        }
      },
      agent_disconnected: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validatePresencePayload("agent_disconnected", payload, roomId)
        ) {
          this.emit({
            type: "participants_changed",
            roomId,
            kind: "presence_changed",
          });
        }
      },
      room_title_changed: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validateTitlePayload(payload, roomId)
        ) {
          this.emit({ type: "room_title_changed", roomId });
        }
      },
      room_deleted: (payload) => {
        if (
          this.isCurrentRoom(roomId, generation) &&
          validateRoomDeletedPayload(payload, roomId)
        ) {
          this.activity.clear();
          this.emit({ type: "room_deleted", roomId });
          this.emit({
            type: "room_activity",
            roomId,
            state: "unavailable",
          });
        }
      },
    };
  }

  private activityHandlers(roomId: string, generation: number): TopicHandlers {
    return {
      agent_activity_started: (payload) => {
        if (!this.isCurrentRoom(roomId, generation)) {
          return;
        }
        const execution = decodeActivityStart(payload);
        if (!execution) {
          return;
        }
        const result = this.activity.start(execution);
        if (result === "started") {
          this.emit({
            type: "room_activity",
            roomId,
            state: "started",
            execution,
          });
        } else if (result === "unavailable") {
          this.emit({ type: "room_activity", roomId, state: "unavailable" });
        }
      },
      agent_activity_stopped: (payload) => {
        if (!this.isCurrentRoom(roomId, generation)) {
          return;
        }
        const execution = decodeActivityStop(payload);
        if (!execution) {
          return;
        }
        if (this.activity.stop(execution) === "stopped") {
          this.emit({
            type: "room_activity",
            roomId,
            state: "stopped",
            execution,
          });
        }
      },
    };
  }

  private applyActivitySnapshot(roomId: string, payload: unknown): void {
    const decoded = decodeActivitySnapshot(payload);
    if (decoded.kind === "ready") {
      this.emit({
        type: "room_activity",
        roomId,
        state: "ready",
        snapshot: this.activity.replace(decoded.snapshot),
      });
      return;
    }
    this.activity.clear();
    this.emit({ type: "room_activity", roomId, state: "unavailable" });
  }

  private isCurrentRoom(roomId: string, generation: number): boolean {
    return (
      !this.disposed &&
      this.selectedRoom === roomId &&
      this.selectionGeneration === generation
    );
  }
}

export function createPrincipalRealtimeConnection(
  options: PrincipalRealtimeOptions,
): PrincipalRealtimeConnection {
  return new PrincipalRealtimeConnectionImpl(options);
}

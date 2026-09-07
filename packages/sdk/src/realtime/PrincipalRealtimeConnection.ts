import { TransportError, ValidationError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import { PhoenixChannelsTransport } from "../platform/streaming/PhoenixChannelsTransport";
import type { TopicHandlers } from "../platform/streaming/transport";
import type { WebSocketDisconnectReason } from "../platform/streaming/disconnectReason";
import {
  ActivityState,
  decodeActivitySnapshot,
  decodeActivityStart,
  decodeActivityStop,
} from "./activity";
import {
  isValidRoomId,
  validateChatPayload,
  validateParticipantMutation,
  validatePresencePayload,
  validateRoomDeletedPayload,
  validateTitlePayload,
} from "./eventValidation";
import {
  REALTIME_MAX_REFS,
  type PrincipalRealtimeConnection,
  type PrincipalRealtimeEvent,
  type PrincipalRealtimeOptions,
  type RealtimePrincipal,
} from "./types";

const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";

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
  private joinRef = 0;
  private disposed = false;
  private started = false;
  private readonly onAbort = (): void => {
    void this.dispose();
  };

  public constructor(options: PrincipalRealtimeOptions) {
    this.principal = options.principal;
    this.logger = options.logger ?? new NoopLogger();
    this.abortSignal = options.abortSignal;
    this.assertPrincipal(options.principal);

    const apiKey =
      options.principal.kind === "human"
        ? options.principal.apiKey
        : options.principal.apiKey;
    const agentId =
      options.principal.kind === "agent" ? options.principal.agentId : undefined;
    const conflictPolicy =
      options.principal.kind === "agent"
        ? options.principal.conflictPolicy
        : undefined;

    this.transport = new PhoenixChannelsTransport({
      wsUrl: options.wsUrl ?? DEFAULT_WS_URL,
      apiKey,
      agentId,
      logger: this.logger,
      conflictPolicy,
      heartbeatIntervalMs: 30_000,
      onTerminalDisconnect: (reason) => {
        this.emit({ type: "connection", state: "unavailable", reason });
        this.state = "unavailable";
        this.activity.clear();
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
    if (this.abortSignal?.aborted) {
      throw new TransportError("Realtime connection aborted before start");
    }
    this.started = true;
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.setState("connecting");
    this.emit({ type: "connection", state: "connecting" });
    try {
      await this.transport.connect();
      await this.joinMandatory(generation);
      if (this.disposed || generation !== this.socketGeneration) {
        return;
      }
      this.setState("ready");
      this.emit({ type: "connection", state: "ready" });
    } catch (error) {
      this.markUnavailable();
      throw error;
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
    const previous = this.selectedRoom;
    this.selectionGeneration += 1;
    const generation = this.selectionGeneration;
    await this.leaveRoomTopics(previous);
    this.selectedRoom = roomId;
    if (previous !== null && previous !== roomId) {
      this.activity.clear();
      this.emit({
        type: "room_activity",
        roomId: previous,
        state: "unavailable",
      });
    }
    if (roomId === null) {
      this.activity.clear();
      if (previous !== null) {
        this.emit({
          type: "room_activity",
          roomId: previous,
          state: "unavailable",
        });
      }
      return;
    }
    if (!this.started) {
      return;
    }
    await this.joinSelectedRoom(roomId, generation);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.socketGeneration += 1;
    this.selectionGeneration += 1;
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

  private assertPrincipal(principal: RealtimePrincipal): void {
    if (principal.kind === "human") {
      if (!principal.userId || !principal.apiKey) {
        throw new ValidationError("Human principal requires userId and apiKey");
      }
      if ("conflictPolicy" in principal) {
        throw new ValidationError(
          "Human principal does not accept a conflict policy",
        );
      }
      if ("agentId" in principal) {
        throw new ValidationError("Human principal must not include agentId");
      }
      return;
    }
    if (principal.kind !== "agent" || !principal.agentId || !principal.apiKey) {
      throw new ValidationError("Agent principal requires agentId and apiKey");
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new TransportError("Realtime connection is disposed");
    }
    if (this.joinRef >= REALTIME_MAX_REFS) {
      throw new TransportError("Realtime join ref ceiling reached");
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

  private async joinMandatory(generation: number): Promise<void> {
    if (this.principal.kind === "human") {
      await this.joinTopic(
        `user_agents:${this.principal.userId}`,
        this.userAgentHandlers(),
        generation,
      );
      if (this.selectedRoom) {
        await this.joinSelectedRoom(this.selectedRoom, this.selectionGeneration);
      }
      return;
    }
    await this.joinTopic(
      `agent_control:${this.principal.agentId}`,
      {},
      generation,
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
  ): Promise<void> {
    const socketGeneration = this.socketGeneration;
    await this.joinTopic(
      `chat_room:${roomId}`,
      this.chatHandlers(roomId, selectionGeneration),
      socketGeneration,
    );
    await this.joinTopic(
      `room_participants:${roomId}`,
      this.participantHandlers(roomId, selectionGeneration),
      socketGeneration,
    );
    const payload = await this.joinTopic(
      `room_activity:${roomId}`,
      this.activityHandlers(roomId, selectionGeneration),
      socketGeneration,
    );
    if (
      this.disposed ||
      selectionGeneration !== this.selectionGeneration ||
      this.selectedRoom !== roomId
    ) {
      return;
    }
    this.applyActivitySnapshot(roomId, payload);
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
  ): Promise<unknown> {
    this.joinRef += 1;
    if (this.joinRef > REALTIME_MAX_REFS) {
      throw new TransportError("Realtime join ref ceiling reached");
    }
    const currentJoin = this.joinRef;
    const payload = await this.transport.joinWithResponse(topic, handlers);
    if (this.disposed || generation !== this.socketGeneration) {
      return undefined;
    }
    void currentJoin;
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
          validateParticipantMutation(payload, roomId)
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
          validateParticipantMutation(payload, roomId)
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

import type { Logger } from "../core/logger";
import type {
  WebSocketConflictPolicy,
  WebSocketDisconnectReason,
} from "../platform/streaming/disconnectReason";

export {
  REALTIME_MAX_FRAME_BYTES,
  REALTIME_MAX_PENDING_CONTROLS,
  REALTIME_MAX_REFS,
  REALTIME_WORKING_AGENT_EXECUTION_MAX,
} from "../platform/streaming/resourceLimits";

export type RealtimePrincipal =
  | { kind: "human"; userId: string; apiKey: string }
  | {
      kind: "agent";
      agentId: string;
      apiKey: string;
      conflictPolicy?: WebSocketConflictPolicy;
    };

export type WorkingAgentExecution = Readonly<{
  agentId: string;
  executionId: string;
}>;

export type PrincipalRealtimeOptions = {
  principal: RealtimePrincipal;
  wsUrl?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
};

export type PrincipalRealtimeEvent =
  | {
      type: "connection";
      state: "connecting" | "ready" | "unavailable";
      reason?: WebSocketDisconnectReason;
    }
  | { type: "user_agents_changed" }
  | {
      type: "chat_changed";
      roomId: string;
      kind:
        | "message_created"
        | "message_updated"
        | "event_created"
        | "message_deleted";
    }
  | {
      type: "participants_changed";
      roomId: string;
      kind: "added" | "removed" | "presence_changed";
    }
  | { type: "room_deleted"; roomId: string }
  | { type: "room_title_changed"; roomId: string }
  | {
      type: "room_activity";
      roomId: string;
      state: "ready";
      snapshot: readonly WorkingAgentExecution[];
    }
  | {
      type: "room_activity";
      roomId: string;
      state: "started" | "stopped";
      execution: WorkingAgentExecution;
    }
  | { type: "room_activity"; roomId: string; state: "unavailable" };

export interface PrincipalRealtimeConnection extends AsyncDisposable {
  start(): Promise<void>;
  setSelectedRoom(roomId: string | null): Promise<void>;
  subscribe(listener: (event: PrincipalRealtimeEvent) => void): () => void;
  getState(): "connecting" | "ready" | "unavailable";
  dispose(): Promise<void>;
}

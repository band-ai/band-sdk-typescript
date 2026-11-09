/**
 * What a running agent reports to the process hosting it through
 * `Agent.observe`. Local only: nothing here is posted to a room.
 */
export type AgentEvent =
  /** A turn for `messageId` reached the adapter. */
  | { type: "turn.started"; roomId: string; messageId: string }
  /** The adapter finished the turn without throwing. */
  | { type: "turn.completed"; roomId: string; messageId: string }
  /** The adapter threw; `error` is its message. */
  | { type: "turn.failed"; roomId: string; messageId: string; error: string }
  /** Reasoning text as the agent streams it; consecutive events continue one run. */
  | { type: "thought"; roomId: string; text: string }
  /** Reply text as the agent streams it, before any of it is posted. */
  | { type: "message"; roomId: string; text: string }
  /**
   * The agent started a tool call, reported once per `toolCallId`. `name` is
   * the agent's own tool name when its bridge reports one, else its ACP
   * `kind`; absent when neither is known. A display title is never used: it
   * can hold a whole command line. `input` is the agent's own argument
   * record, as it sent it, when it sends one.
   */
  | { type: "tool.call"; roomId: string; toolCallId: string; name?: string; kind?: string; input?: unknown }
  /** A tool call ended. `output` is its result text. */
  | { type: "tool.result"; roomId: string; toolCallId: string; status: "completed" | "failed"; output: string }
  /** The agent asked for permission to run a tool. */
  | {
      type: "approval.requested";
      roomId: string;
      toolCallId: string;
      toolName: string;
      options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
    }
  /** That request was answered: `selected` with the option chosen, or `cancelled`. */
  | { type: "approval.resolved"; roomId: string; toolCallId: string; outcome: "selected" | "cancelled"; optionId?: string }
  /** The agent joined a room and handles its messages. */
  | { type: "room.joined"; roomId: string }
  /** The agent left a room, or was removed from it. */
  | { type: "room.left"; roomId: string }
  /** The room's agent process could not start; its messages fail until a later start succeeds. */
  | { type: "room.failed"; roomId: string; error: string }
  /** The room's message handling stopped: the room was left or reset, or the agent stopped. */
  | { type: "room.stopped"; roomId: string }
  /** The connection to Band is up; `reconnected` when it came back after a drop. */
  | { type: "link.connected"; reconnected: boolean }
  /**
   * The connection to Band is down: `dropped` while it retries on its own,
   * `closed` by a local disconnect, `terminal` when it ended for good.
   */
  | { type: "link.disconnected"; reason: "dropped" | "closed" | "terminal" };

export type AgentEventType = AgentEvent["type"];

/**
 * Receives each event synchronously, in order, on the code path that produced
 * it, so it should return quickly. A listener that throws or rejects is logged
 * and skipped; it cannot fail the turn or starve the other listeners.
 */
export type AgentEventListener = (event: AgentEvent) => void;

/** Where a component reports events; the runtime fans them out to listeners. */
export type AgentEventSink = (event: AgentEvent) => void;

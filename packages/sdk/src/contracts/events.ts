/**
 * Why a live Band link is down: `dropped` while it retries on its own,
 * `closed` by a local disconnect, `terminal` when it ended for good.
 */
export type LinkDisconnectReason = "dropped" | "closed" | "terminal";

/** How a tool call ended. */
export type ToolCallEndStatus = "completed" | "failed";

/** How a permission request was answered. */
export type ApprovalOutcome = "selected" | "cancelled";

/**
 * Who paused a room: `band`, by an `agent.control` stop or by refusing the
 * agent's writes; or `host`, the process hosting the agent, which no public
 * API pauses with yet.
 */
export type RoomPauseSource = "band" | "host";

/**
 * How a running turn was cut short: `stop` leaves its message for Band to
 * serve again once the room resumes; `interrupt` consumes it.
 */
export type TurnStopMode = "stop" | "interrupt";

/**
 * What a running agent reports to the process hosting it through
 * `Agent.observe`. Local only: nothing here is posted to a room.
 *
 * Pairing rules:
 * - Turns: each `turn.started` ends with one `turn.completed`, `turn.failed`
 *   or `turn.stopped`.
 * - Rooms: each time a joined room's handling starts, one `room.joined`; when
 *   that handling ends, one `room.stopped`. `room.left` follows `room.stopped`
 *   only when membership was lost. Per pause source, `room.paused` and
 *   `room.resumed` alternate.
 * - Link: per connection, one `link.connected`; while down, one
 *   `link.disconnected` per distinct reason (a drop, then a local stop,
 *   reports both); then `link.connected` with `reconnected` once it is back.
 *   Nothing is reported before the first up or after `terminal`.
 * - Tools: one `tool.call` per `toolCallId` within an agent session, then at
 *   most one `tool.result`.
 * - Approvals: one `approval.resolved` per `approval.requested`.
 */
export type AgentEvent =
  /**
   * The runtime is handing the turn for `messageId` to the adapter. The
   * adapter may not hold it yet when this is delivered, so a `cancelTurn`
   * made in response can resolve false.
   */
  | { type: "turn.started"; roomId: string; messageId: string }
  /** The adapter finished the turn without throwing. */
  | { type: "turn.completed"; roomId: string; messageId: string }
  /** The adapter threw; `error` is the thrown error's message, the same label Band records for the message. */
  | { type: "turn.failed"; roomId: string; messageId: string; error: string }
  /**
   * A pause (`stop`) or an interrupt cut the turn short. The runtime no
   * longer waits on it, and nothing it reports afterwards settles the
   * message: `stop` leaves the message for Band to serve again on resume,
   * `interrupt` consumes it. An adapter that can cancel a turn is asked to.
   */
  | { type: "turn.stopped"; roomId: string; messageId: string; mode: TurnStopMode }
  /** Reasoning text as the agent streams it; consecutive events continue one run. */
  | { type: "thought"; roomId: string; text: string }
  /** Reply text as the agent streams it, before any of it is posted. */
  | { type: "message"; roomId: string; text: string }
  /**
   * The agent started a tool call, reported once per `toolCallId`. `name` is
   * ACP's programmatic tool `name` when non-empty, else a bridge `_meta`
   * name, else an MCP server and tool named in its arguments, else ACP
   * `kind`; absent when none is known. A display title is
   * never used: it can hold a whole command line. `input` is the agent's
   * own argument record, as it sent it, when it sends one.
   */
  | { type: "tool.call"; roomId: string; toolCallId: string; name?: string; kind?: string; input?: unknown }
  /** A tool call ended. `output` is its result text. */
  | { type: "tool.result"; roomId: string; toolCallId: string; status: ToolCallEndStatus; output: string }
  /** The agent asked for permission to run a tool. */
  | {
      type: "approval.requested";
      roomId: string;
      toolCallId: string;
      /** Resolved like `tool.call`'s `name`; absent when none is known. */
      toolName?: string;
      options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
    }
  /** That request was answered: `selected` with the option chosen, or `cancelled`. */
  | { type: "approval.resolved"; roomId: string; toolCallId: string; outcome: ApprovalOutcome; optionId?: string }
  /** Handling of a joined room's messages started: on joining it, and again after a reset. */
  | { type: "room.joined"; roomId: string }
  /** The agent is no longer a member of a room. Stopping the agent reports `room.stopped`, not this. */
  | { type: "room.left"; roomId: string }
  /**
   * The room's agent process could not start, or exited on its own; the
   * room's messages fail until a later start succeeds. `error` is the
   * failure's message with its causes, truncated.
   */
  | { type: "room.failed"; roomId: string; error: string }
  /** The room's message handling stopped: the room was left or reset, or the agent stopped. */
  | { type: "room.stopped"; roomId: string }
  /**
   * `messageId` is answered again, and the turn journal shows an earlier,
   * unfinished turn for it began posting replies: Band may already have them,
   * so they may repeat. Each begun reply is reported once: a later repeat is
   * reported again only for replies begun since.
   */
  | { type: "delivery.unrecorded"; roomId: string; messageId: string }
  /**
   * `source` paused the room: no turn starts there, and Band keeps its
   * messages, until every source that paused it resumes it.
   */
  | { type: "room.paused"; roomId: string; source: RoomPauseSource }
  /** `source` lifted its pause; the room catches up once no source pauses it. */
  | { type: "room.resumed"; roomId: string; source: RoomPauseSource }
  /** The connection to Band is up; `reconnected` when it came back after a drop. */
  | { type: "link.connected"; reconnected: boolean }
  /** The connection to Band is down; see `LinkDisconnectReason`. */
  | { type: "link.disconnected"; reason: LinkDisconnectReason };

export type AgentEventType = AgentEvent["type"];

/**
 * Receives each event in emit order, on a microtask after the code that
 * produced it, so a listener may call back into the agent (for example
 * `cancelTurn`) without landing mid-operation; the agent may have moved on by
 * then. A listener added later never sees earlier events, and one removed
 * before delivery is skipped. A listener that throws or rejects is logged and
 * skipped; it cannot fail the turn or starve the other listeners.
 */
export type AgentEventListener = (event: AgentEvent) => void;

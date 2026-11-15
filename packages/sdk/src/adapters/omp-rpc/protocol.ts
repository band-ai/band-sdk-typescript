/**
 * The frames of OMP's native RPC mode (`omp --mode rpc`): one JSON object per
 * line on the child's stdin and stdout. Only what this adapter reads or writes
 * is typed; every other field is ignored.
 */

/** The protocol version this client negotiates; it adds `rpc_chunk` framing. */
export const OMP_RPC_PROTOCOL_VERSION = 2;

/** Upper bounds a `ready` frame may announce; a peer claiming more is refused. */
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

export const OMP_COMMAND = {
  negotiateProtocol: "negotiate_protocol",
  prompt: "prompt",
  /** Ends the running prompt; its `prompt_result` then reports `aborted`. */
  abort: "abort",
  getState: "get_state",
  setHostTools: "set_host_tools",
  /**
   * Moves the process to another persisted session. Unused: each room runs
   * its own process, which serves one session for its whole life. Kept for a
   * variant that would serve several rooms from one process.
   */
  switchSession: "switch_session",
} as const;

/** Frames the child writes that are not events. */
export const OMP_FRAME = {
  ready: "ready",
  response: "response",
  promptResult: "prompt_result",
  sessionSettled: "session_settled",
  hostToolCall: "host_tool_call",
  hostToolCancel: "host_tool_cancel",
  hostToolResult: "host_tool_result",
  uiRequest: "extension_ui_request",
  uiResponse: "extension_ui_response",
  chunk: "rpc_chunk",
  frameError: "rpc_frame_error",
} as const;

/** The agent loop's events, in the order a turn produces them. */
export const OMP_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_stream_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
]);

/** UI requests that only decorate a terminal and need no answer. */
export const OMP_UI_NOTIFICATIONS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]);

/** A UI request withdrawn by the agent; `targetId` names the one it withdraws. */
export const OMP_UI_CANCEL = "cancel";

export interface OmpReady {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

export type OmpPromptStatus = "completed" | "error" | "aborted";

export interface OmpPromptFailure {
  message: string;
  retryable?: boolean;
  provider?: string;
  model?: string;
  httpStatus?: number;
}

/** How a prompt ended: its `prompt_result`, once the session settled after it. */
export interface OmpPromptOutcome {
  status: OmpPromptStatus;
  error?: OmpPromptFailure;
}

export interface OmpContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface OmpMessage {
  role: string;
  content: string | OmpContentBlock[];
  stopReason?: string;
  errorMessage?: string;
}

/** One agent-loop event, as the child sent it. */
export interface OmpEvent {
  type: string;
  message?: OmpMessage;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: OmpContentBlock[] };
  isError?: boolean;
}

export interface OmpHostToolCall {
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface OmpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface OmpUIRequest {
  id: string;
  method: string;
  title?: string;
  options?: string[];
  message?: string;
}

/** One answer to a UI request: a chosen value, or the request cancelled. */
export type OmpUIResponse = { value: string } | { cancelled: true };

/** A host tool as `set_host_tools` declares it. */
export interface OmpHostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode: "essential";
}

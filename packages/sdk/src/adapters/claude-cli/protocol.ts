/**
 * The frames the installed Claude Code CLI exchanges in stream-json mode
 * (`claude --print --input-format stream-json --output-format stream-json`):
 * one JSON object per line on the child's stdin and stdout. Only what this
 * client reads or writes is typed; every other field is ignored, so a CLI that
 * adds informational fields or frame types keeps working.
 *
 * The shapes are taken from the captures under `tests/fixtures/claude-cli/`,
 * recorded against Claude Code 2.1.319. Nothing here reads or imports any
 * Anthropic package: the CLI is treated as an external process with a
 * documented wire format.
 */

import { asOptionalRecord } from "../shared/coercion";

/** The transport name a `room.ready` identity reports for this protocol. */
export const CLAUDE_PROTOCOL = "claude-stream-json";

/** The oldest CLI version this client drives; an older one is refused. */
export const CLAUDE_MIN_CLI_VERSION = "2.1.319";

/** Largest single NDJSON line the client accepts from the CLI. */
export const CLAUDE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** How much of the CLI's stderr the client keeps for a dying process's diagnostic. */
export const CLAUDE_MAX_STDERR_TAIL_BYTES = 64 * 1024;

/** The `control_request` subtypes this client sends. */
export const CLAUDE_CONTROL_SUBTYPE = {
  initialize: "initialize",
  interrupt: "interrupt",
} as const;

/** Frame types the client understands; any other `type` is ignored. */
export const CLAUDE_FRAME = {
  controlRequest: "control_request",
  controlResponse: "control_response",
  system: "system",
  assistant: "assistant",
  user: "user",
  result: "result",
} as const;

/** The `system` subtype that starts a session; other subtypes are informational. */
export const CLAUDE_SYSTEM_SUBTYPE = "init";

/** The terminal `result` subtypes observed on 2.1.319. */
export const CLAUDE_RESULT_SUBTYPE = {
  success: "success",
  errorDuringExecution: "error_during_execution",
} as const;

/** The `terminal_reason` values observed on 2.1.319. */
export const CLAUDE_TERMINAL_REASON = {
  completed: "completed",
  abortedTools: "aborted_tools",
} as const;

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** What the CLI reported about itself in answer to `initialize`. */
export interface ClaudeInitReport {
  /** The `claude_code_version` string, exactly as the CLI wrote it. */
  cliVersion: string;
  /** The permission mode the session started in, when the CLI named one. */
  permissionMode: string | null;
  /** Capability names the CLI offers this host. */
  capabilities: string[];
}

/** The `system`/`init` frame: the session the process is now running. */
export interface ClaudeSystemInit {
  sessionId: string;
  model: string | null;
  permissionMode: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  capabilities: string[];
}

/** The terminal `result` frame of one turn. */
export interface ClaudeResultFrame {
  subtype: string;
  isError: boolean;
  sessionId: string | null;
  /** The assistant's final text; the CLI omits it on an error-shaped result. */
  result: string | null;
  /** What the CLI said went wrong; empty unless the result is an error. */
  errors: string[];
  terminalReason: string | null;
  numTurns: number | null;
  /** Tool uses the permission layer declined; empty unless something was refused. */
  permissionDenials: Array<{ toolName: string; toolUseId: string | null }>;
  /** Cost fields are cumulative across resumes; `modelUsageSinceLastResult` is not. */
  totalCostUsd: number | null;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, unknown> | null;
  modelUsageSinceLastResult: Record<string, unknown> | null;
}

/** One content block of an assistant or user message, reduced to what is safe to surface. */
export type ClaudeContentBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError: boolean };

/** What a turn produces, in the order the CLI wrote it. */
export type ClaudeEvent =
  | { type: "system_init"; init: ClaudeSystemInit }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: unknown; isError: boolean }
  | { type: "notice"; text: string };

/** A `control_request` the CLI sent us; the client must answer it, or the CLI waits. */
export interface ClaudeInboundRequest {
  requestId: string;
  subtype: string;
  request: Record<string, unknown>;
}

export type ClaudeControlResponse =
  | { ok: true; requestId: string; response: Record<string, unknown> }
  | { ok: false; requestId: string; error: string };

// -- parsing -------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `2.1.319`, tolerating a `-suffix`; null when the value is not a version we can compare. */
export function parseClaudeVersion(value: unknown): ClaudeVersion | null {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether the CLI the process reported is new enough to drive. The version comes
 * from the `initialize` response, so an unparseable or missing one is refused
 * rather than assumed: a client that guesses drives an unknown protocol.
 */
export function checkClaudeCliVersion(
  value: unknown,
  minimum: string = CLAUDE_MIN_CLI_VERSION,
): { ok: true; version: string; parsed: ClaudeVersion } | { ok: false; message: string } {
  const reported = typeof value === "string" ? value.trim() : null;
  if (!reported) {
    return { ok: false, message: `the CLI reported no claude_code_version; ${minimum} or newer is required` };
  }
  const parsed = parseClaudeVersion(reported);
  if (!parsed) {
    return { ok: false, message: `cannot read the CLI version "${reported}"; ${minimum} or newer is required` };
  }
  const floor = parseClaudeVersion(minimum);
  if (!floor) {
    return { ok: false, message: `the configured minimum version "${minimum}" is not a version` };
  }
  if (compareClaudeVersions(parsed, floor) < 0) {
    return { ok: false, message: `Claude Code ${reported} is older than the ${minimum} this adapter requires` };
  }
  return { ok: true, version: reported, parsed };
}

/** The `control_response` for a request we sent; null when the frame is not one. */
export function parseControlResponse(frame: Record<string, unknown>): ClaudeControlResponse | null {
  if (frame.type !== CLAUDE_FRAME.controlResponse) {
    return null;
  }
  const wrapper = asOptionalRecord(frame.response);
  const requestId = asStringOrNull(wrapper?.request_id);
  if (!wrapper || requestId === null) {
    throw new TypeError("control_response carries no request_id");
  }
  if (wrapper.subtype === "error") {
    const error = asStringOrNull(wrapper.error) ?? "the CLI refused the request";
    return { ok: false, requestId, error };
  }
  if (wrapper.subtype !== "success") {
    throw new TypeError(`control_response subtype is neither success nor error: ${String(wrapper.subtype)}`);
  }
  return { ok: true, requestId, response: asOptionalRecord(wrapper.response) ?? {} };
}

export function parseInitReport(response: Record<string, unknown>): ClaudeInitReport {
  return {
    cliVersion: asStringOrNull(response.claude_code_version) ?? "",
    permissionMode: asStringOrNull(response.current_permission_mode),
    capabilities: asStringArray(response.capabilities),
  };
}

export function parseSystemInit(frame: Record<string, unknown>): ClaudeSystemInit | null {
  if (frame.type !== CLAUDE_FRAME.system || frame.subtype !== CLAUDE_SYSTEM_SUBTYPE) {
    return null;
  }
  const sessionId = asStringOrNull(frame.session_id);
  if (sessionId === null) {
    throw new TypeError("system/init carries no session_id");
  }
  const servers = Array.isArray(frame.mcp_servers) ? frame.mcp_servers : [];
  return {
    sessionId,
    model: asStringOrNull(frame.model),
    permissionMode: asStringOrNull(frame.permissionMode),
    tools: asStringArray(frame.tools),
    mcpServers: servers.reduce<Array<{ name: string; status: string }>>((kept, entry) => {
      const record = asOptionalRecord(entry);
      const name = asStringOrNull(record?.name);
      if (record && name !== null) {
        kept.push({ name, status: asStringOrNull(record.status) ?? "unknown" });
      }
      return kept;
    }, []),
    capabilities: asStringArray(frame.capabilities),
  };
}

/** The content blocks of an `assistant` or `user` frame, reduced to safe fields. */
export function parseContentBlocks(message: unknown): ClaudeContentBlock[] {
  const record = asOptionalRecord(message);
  const blocks = Array.isArray(record?.content) ? record.content : [];
  const parsed: ClaudeContentBlock[] = [];
  for (const entry of blocks) {
    const block = asOptionalRecord(entry);
    if (!block) {
      continue;
    }
    switch (block.type) {
      case "text": {
        const text = asStringOrNull(block.text);
        if (text !== null) {
          parsed.push({ kind: "text", text });
        }
        break;
      }
      case "thinking": {
        // The signature attests a reasoning block to Anthropic; it is neither a
        // reply nor a log line, so it never leaves the parser.
        const text = asStringOrNull(block.thinking);
        if (text !== null) {
          parsed.push({ kind: "reasoning", text });
        }
        break;
      }
      case "tool_use": {
        const id = asStringOrNull(block.id);
        const name = asStringOrNull(block.name);
        if (id !== null && name !== null) {
          parsed.push({ kind: "tool_use", id, name, input: asOptionalRecord(block.input) ?? {} });
        }
        break;
      }
      case "tool_result": {
        const toolUseId = asStringOrNull(block.tool_use_id);
        if (toolUseId !== null) {
          parsed.push({
            kind: "tool_result",
            toolUseId,
            content: block.content ?? null,
            isError: block.is_error === true,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return parsed;
}

export function parseResult(frame: Record<string, unknown>): ClaudeResultFrame {
  const denials = Array.isArray(frame.permission_denials) ? frame.permission_denials : [];
  return {
    subtype: asStringOrNull(frame.subtype) ?? "",
    isError: frame.is_error === true,
    sessionId: asStringOrNull(frame.session_id),
    result: asStringOrNull(frame.result),
    errors: asStringArray(frame.errors),
    terminalReason: asStringOrNull(frame.terminal_reason),
    numTurns: asFiniteNumberOrNull(frame.num_turns),
    permissionDenials: denials.reduce<Array<{ toolName: string; toolUseId: string | null }>>((kept, entry) => {
      const record = asOptionalRecord(entry);
      const toolName = asStringOrNull(record?.tool_name);
      if (record && toolName !== null) {
        kept.push({ toolName, toolUseId: asStringOrNull(record.tool_use_id) });
      }
      return kept;
    }, []),
    totalCostUsd: asFiniteNumberOrNull(frame.total_cost_usd),
    usage: asOptionalRecord(frame.usage) ?? null,
    modelUsage: asOptionalRecord(frame.modelUsage) ?? null,
    modelUsageSinceLastResult: asOptionalRecord(frame.model_usage_since_last_result) ?? null,
  };
}

export function parseInboundRequest(frame: Record<string, unknown>): ClaudeInboundRequest | null {
  if (frame.type !== CLAUDE_FRAME.controlRequest) {
    return null;
  }
  const requestId = asStringOrNull(frame.request_id);
  const request = asOptionalRecord(frame.request);
  const subtype = asStringOrNull(request?.subtype);
  if (requestId === null || !request || subtype === null) {
    throw new TypeError("control_request carries no request_id or request.subtype");
  }
  return { requestId, subtype, request };
}

/**
 * What an `assistant` frame contributes. A text block here is the model's own
 * words; the same block on a `user` frame is not, which is why the two roles
 * are read by different functions rather than by one that trusts `content`.
 */
export function eventsFromAssistant(frame: Record<string, unknown>): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const block of parseContentBlocks(frame.message)) {
    switch (block.kind) {
      case "text":
        events.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        events.push({ type: "reasoning", text: block.text });
        break;
      case "tool_use":
        events.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        break;
      case "tool_result":
        break;
    }
  }
  return events;
}

/**
 * What a `user` frame contributes: a tool's result, or a notice the CLI put in
 * the transcript on the host's behalf (an interrupted tool use, for one).
 */
export function eventsFromUser(frame: Record<string, unknown>): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const block of parseContentBlocks(frame.message)) {
    switch (block.kind) {
      case "tool_result":
        events.push({ type: "tool_result", toolUseId: block.toolUseId, content: block.content, isError: block.isError });
        break;
      case "text":
        events.push({ type: "notice", text: block.text });
        break;
      case "reasoning":
      case "tool_use":
        break;
    }
  }
  return events;
}

// -- encoding ------------------------------------------------------------------

/** The `user` envelope that starts a turn: one text block, no parent tool use. */
export function encodeUserMessage(text: string): Record<string, unknown> {
  return {
    type: CLAUDE_FRAME.user,
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

export function encodeControlRequest(
  requestId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return { type: CLAUDE_FRAME.controlRequest, request_id: requestId, request };
}

/** The answer to a `control_request` the client cannot serve. */
export function encodeControlError(requestId: string, error: string): Record<string, unknown> {
  return { type: CLAUDE_FRAME.controlResponse, response: { subtype: "error", request_id: requestId, error } };
}

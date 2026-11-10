import type { SessionUpdate } from "@agentclientprotocol/sdk"

import type { AgentEventListener } from "../../contracts/events"
import { asNonEmptyString, asOptionalRecord } from "../shared/coercion"
import { extractToolOutput, type ToolCallFrame } from "./client"
import { isTerminalToolStatus, mcpInvocationName } from "./toolCalls"
import type { CollectedChunk } from "./types"

// `_meta` entries in which an ACP bridge names its agent's own tool, by bridge.
// `title` is display copy (a command line, a sentence) and never the name.
const BRIDGE_TOOL_NAME_KEYS = ["claudeCode"] as const

interface ToolCallState {
  name?: string
  kind?: string
  reported: boolean
}

interface ToolCallNaming {
  name?: string | null
  kind?: string | null
  _meta?: unknown
  rawInput?: unknown
}

/** The tool name observers see; the rule is documented on `AgentEvent`'s `tool.call`. */
export function observedToolName(source: ToolCallNaming): string | undefined {
  return carriedToolName(source) ?? asNonEmptyString(source.kind) ?? undefined
}

/** A name the call carries itself, before the `kind` fallback. */
function carriedToolName({ name, _meta, rawInput }: ToolCallNaming): string | undefined {
  return asNonEmptyString(name) ?? bridgeToolName(_meta) ?? mcpInvocationName(rawInput)
}

/** One ACP session's tool calls; ACP ids are unique only within a session. */
interface SessionCalls {
  inFlight: Map<string, ToolCallState>
  /** Ids that already emitted `tool.result`; further terminals are ignored. */
  completed: Set<string>
}

/**
 * Turns one room's ACP session updates into local events. A bridge may send a
 * call's `tool_call` more than once, first without its input (Claude Code
 * does), so each call is reported once: when a frame brings its input, or,
 * for a call that never gets any, just before its result.
 */
export class SessionUpdateEvents {
  private readonly sessions = new Map<string, SessionCalls>()

  public constructor(
    private readonly roomId: string,
    private readonly emit: AgentEventListener,
  ) {}

  /** `chunk` is the update as the client collected it, for its extracted text. */
  public observe(sessionId: string, update: SessionUpdate, chunk: CollectedChunk): void {
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
      case "agent_message_chunk":
        if (chunk.content) {
          this.emit({
            type: update.sessionUpdate === "agent_thought_chunk" ? "thought" : "message",
            roomId: this.roomId,
            text: chunk.content,
          })
        }
        return
      // ACP lets either frame carry a terminal status, so both can end a call.
      case "tool_call":
      case "tool_call_update": {
        const session = this.session(sessionId)
        if (session.completed.has(update.toolCallId)) return
        const call = this.refine(session, update)
        if (isTerminalToolStatus(update.status)) {
          if (!call.reported) this.report(update.toolCallId, call, undefined)
          session.inFlight.delete(update.toolCallId)
          session.completed.add(update.toolCallId)
          // An update's collected text is already its tool output.
          const output = update.sessionUpdate === "tool_call_update" ? chunk.content : extractToolOutput(update)
          this.emit({ type: "tool.result", roomId: this.roomId, toolCallId: update.toolCallId, status: update.status, output })
        }
        return
      }
      default:
        return
    }
  }

  /** Forgets every session's calls, for a room or connection that is going away. */
  public reset(): void {
    this.sessions.clear()
  }

  private session(sessionId: string): SessionCalls {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { inFlight: new Map(), completed: new Set() }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private refine({ inFlight }: SessionCalls, update: ToolCallFrame): ToolCallState {
    const { toolCallId, rawInput } = update
    let call = inFlight.get(toolCallId)
    if (!call) {
      call = { reported: false }
      inFlight.set(toolCallId, call)
    }
    // Kind is stored separately; folding it into `name` would let a later
    // kind-only frame overwrite a bridge/ACP name.
    call.name = carriedToolName({ name: update.name, _meta: update._meta, rawInput }) ?? call.name
    call.kind = update.kind ?? call.kind
    if (!call.reported && hasInput(rawInput)) this.report(toolCallId, call, rawInput)
    return call
  }

  private report(toolCallId: string, call: ToolCallState, input: unknown): void {
    call.reported = true
    const name = observedToolName(call)
    this.emit({
      type: "tool.call",
      roomId: this.roomId,
      toolCallId,
      ...(name !== undefined ? { name } : {}),
      ...(call.kind !== undefined ? { kind: call.kind } : {}),
      ...(input !== undefined ? { input } : {}),
    })
  }
}

function bridgeToolName(meta: unknown): string | undefined {
  const record = asOptionalRecord(meta)
  for (const key of BRIDGE_TOOL_NAME_KEYS) {
    const toolName = asNonEmptyString(asOptionalRecord(record?.[key])?.toolName)
    if (toolName !== null) return toolName
  }
  return undefined
}

function hasInput(input: unknown): boolean {
  if (input === undefined || input === null) return false
  const record = asOptionalRecord(input)
  return record === undefined || Object.keys(record).length > 0
}

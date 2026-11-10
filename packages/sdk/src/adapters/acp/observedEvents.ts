import type { SessionUpdate } from "@agentclientprotocol/sdk"

import type { AgentEventListener } from "../../contracts/events"
import { asNonEmptyString, asOptionalRecord } from "../shared/coercion"
import { extractToolOutput, type ToolCallFrame } from "./client"
import { acpToolCallName, isTerminalToolStatus } from "./toolCalls"
import type { CollectedChunk } from "./types"

// `_meta` entries in which an ACP bridge names its agent's own tool, by bridge.
// `title` is display copy (a command line, a sentence) and never the name.
const BRIDGE_TOOL_NAME_KEYS = ["claudeCode"] as const

interface ToolCallState {
  name?: string
  kind?: string
  reported: boolean
}

/** The tool name observers see; the rule is documented on `AgentEvent`'s `tool.call`. */
export function observedToolName(source: {
  name?: string | null
  kind?: string | null
  _meta?: unknown
  rawInput?: unknown
}): string | undefined {
  return asNonEmptyString(source.name)
    ?? bridgeToolName(source._meta)
    ?? asNonEmptyString(acpToolCallName(source.rawInput, ""))
    ?? asNonEmptyString(source.kind)
    ?? undefined
}

/**
 * Turns one room's ACP session updates into local events. A bridge may send a
 * call's `tool_call` more than once, first without its input (Claude Code
 * does), so each call is reported once: when a frame brings its input, or,
 * for a call that never gets any, just before its result.
 */
export class SessionUpdateEvents {
  private readonly calls = new Map<string, ToolCallState>()
  /** Tool call ids that already emitted `tool.result`; further terminals are ignored. */
  private readonly completed = new Set<string>()

  public constructor(
    private readonly roomId: string,
    private readonly emit: AgentEventListener,
  ) {}

  /** `chunk` is the update as the client collected it, for its extracted text. */
  public observe(update: SessionUpdate, chunk: CollectedChunk): void {
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
        if (this.completed.has(update.toolCallId)) return
        const call = this.refine(update)
        if (isTerminalToolStatus(update.status)) {
          if (!call.reported) this.report(update.toolCallId, call, undefined)
          this.calls.delete(update.toolCallId)
          this.completed.add(update.toolCallId)
          this.emit({ type: "tool.result", roomId: this.roomId, toolCallId: update.toolCallId, status: update.status, output: extractToolOutput(update) })
        }
        return
      }
      default:
        return
    }
  }

  /** Forgets calls in flight, for a room or session that is going away. */
  public reset(): void {
    this.calls.clear()
    this.completed.clear()
  }

  private refine(update: ToolCallFrame): ToolCallState {
    const { toolCallId, rawInput } = update
    let call = this.calls.get(toolCallId)
    if (!call) {
      call = { reported: false }
      this.calls.set(toolCallId, call)
    }
    // Kind is stored separately; folding it into `name` would let a later
    // kind-only frame overwrite a bridge/ACP name.
    call.name = observedToolName({ name: update.name, _meta: update._meta, rawInput }) ?? call.name
    call.kind = update.kind ?? call.kind
    if (!call.reported && hasInput(rawInput)) this.report(toolCallId, call, rawInput)
    return call
  }

  private report(toolCallId: string, call: ToolCallState, input: unknown): void {
    call.reported = true
    const name = call.name ?? call.kind
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

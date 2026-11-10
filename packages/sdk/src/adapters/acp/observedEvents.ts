import type { SessionUpdate } from "@agentclientprotocol/sdk"

import type { AgentEventSink } from "../../contracts/events"
import { asOptionalRecord } from "../shared/coercion"
import type { CollectedChunk } from "./types"

// `_meta` entries in which an ACP bridge names its agent's own tool, by bridge.
// `title` is display copy (a command line, a sentence) and never the name.
const BRIDGE_TOOL_NAME_KEYS = ["claudeCode"] as const

interface ToolCallState {
  name?: string
  kind?: string
  reported: boolean
}

/**
 * Turns one room's ACP session updates into local events. A bridge may send a
 * call's `tool_call` more than once, first without its input (Claude Code
 * does), so each call is reported once: when a frame brings its input, or,
 * for a call that never gets any, just before its result.
 */
export class SessionUpdateEvents {
  private readonly calls = new Map<string, ToolCallState>()

  public constructor(
    private readonly roomId: string,
    private readonly emit: AgentEventSink,
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
      case "tool_call":
        this.refine(update.toolCallId, bridgeToolName(update._meta), update.kind ?? undefined, update.rawInput)
        return
      case "tool_call_update": {
        const call = this.refine(update.toolCallId, bridgeToolName(update._meta), update.kind ?? undefined, update.rawInput)
        if (update.status === "completed" || update.status === "failed") {
          if (!call.reported) this.report(update.toolCallId, call, undefined)
          this.calls.delete(update.toolCallId)
          this.emit({ type: "tool.result", roomId: this.roomId, toolCallId: update.toolCallId, status: update.status, output: chunk.content })
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
  }

  private refine(toolCallId: string, name: string | undefined, kind: string | undefined, input: unknown): ToolCallState {
    let call = this.calls.get(toolCallId)
    if (!call) {
      call = { reported: false }
      this.calls.set(toolCallId, call)
    }
    call.name = name ?? call.name
    call.kind = kind ?? call.kind
    if (!call.reported && hasInput(input)) this.report(toolCallId, call, input)
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
    const toolName = asOptionalRecord(record?.[key])?.toolName
    if (typeof toolName === "string" && toolName.length > 0) return toolName
  }
  return undefined
}

function hasInput(input: unknown): boolean {
  if (input === undefined || input === null) return false
  const record = asOptionalRecord(input)
  return record === undefined || Object.keys(record).length > 0
}

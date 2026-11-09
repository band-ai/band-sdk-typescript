import type { AgentEvent } from "../../contracts/events"
import type { CollectedChunk } from "./types"

/** The local event a session update stands for, or null when it has none. */
export function observedEvent(roomId: string, chunk: CollectedChunk): AgentEvent | null {
  const { tool_call_id: toolCallId, kind, raw_input: input, status } = chunk.metadata
  switch (chunk.chunkType) {
    case "thought":
      return chunk.content ? { type: "thought", roomId, text: chunk.content } : null
    case "text":
      return chunk.content ? { type: "message", roomId, text: chunk.content } : null
    case "tool_call":
      return typeof toolCallId === "string"
        ? {
            type: "tool.call",
            roomId,
            toolCallId,
            name: chunk.content,
            ...(typeof kind === "string" ? { kind } : {}),
            ...(input !== undefined ? { input } : {}),
          }
        : null
    case "tool_result":
      // Only the update that ends the call; progress updates have no result yet.
      return typeof toolCallId === "string" && (status === "completed" || status === "failed")
        ? { type: "tool.result", roomId, toolCallId, status, output: chunk.content }
        : null
    default:
      return null
  }
}

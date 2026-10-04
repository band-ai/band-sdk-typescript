import type { BandToolName } from "@band-ai/band-sdk-core";

import { mcpToolSpelling, resolveBandToolName } from "../../contracts/toolSchemas";
import type { Turn } from "../../core/turn";
import { asOptionalRecord } from "../shared/coercion";
import type { CollectedChunk } from "./types";

// The status an ACP tool call reports once it succeeded.
const COMPLETED = "completed";

// The `rawInput` keys each runtime reports an MCP call under, as (server,
// tool, arguments): codex-acp, then Cursor.
const MCP_INVOCATION_KEYS = [
  ["server", "tool", "arguments"],
  ["providerIdentifier", "toolName", "args"],
] as const;

/**
 * The name a `tool_call` chunk invoked: its MCP invocation spelled
 * `<server>-<tool>`, read from `raw_input`, or else its title, which some
 * runtimes use only as a display string.
 */
export function acpToolCallName(chunk: CollectedChunk): string {
  const input = asOptionalRecord(chunk.metadata.raw_input);
  if (input) {
    const inputKeys = Object.keys(input);
    for (const keys of MCP_INVOCATION_KEYS) {
      const [server, tool] = [input[keys[0]], input[keys[1]]];
      const matches = inputKeys.length === keys.length && keys.every((key) => Object.hasOwn(input, key));
      if (matches && typeof server === "string" && typeof tool === "string") {
        return mcpToolSpelling(server, tool);
      }
    }
  }
  return chunk.content;
}

function toolCallId(chunk: CollectedChunk): string | undefined {
  const id = chunk.metadata.tool_call_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Records on `turn` each Band tool call in one turn's chunks that completed,
 * for Band tools that ran in another process. A call completes on its own
 * `tool_call` chunk, or on a `tool_result` with the same non-empty id.
 */
export function recordBandToolCalls(chunks: readonly CollectedChunk[], turn: Turn): void {
  const calls = new Map<string, BandToolName>();
  for (const chunk of chunks) {
    const id = toolCallId(chunk);
    if (chunk.chunkType === "tool_call") {
      const tool = resolveBandToolName(acpToolCallName(chunk));
      if (!tool) {
        continue;
      }
      if (id) {
        calls.set(id, tool);
      }
      if (chunk.metadata.status === COMPLETED) {
        turn.recordTool(tool);
      }
    } else if (chunk.chunkType === "tool_result" && id && chunk.metadata.status === COMPLETED) {
      const tool = calls.get(id);
      if (tool) {
        turn.recordTool(tool);
      }
    }
  }
}

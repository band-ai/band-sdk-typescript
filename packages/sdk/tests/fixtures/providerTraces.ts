/**
 * Event sequences real providers send, as read from their own code. Tests replay them through the
 * real adapters, so a fake can no longer encode only what we assumed a provider does. Typed against
 * the provider SDKs, so a changed event shape fails typecheck.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { MCP_SERVER_NAME } from "../../src/contracts/toolSchemas";

/**
 * Cursor opens an MCP call as a pending "MCP: tool" of kind `other` and names it only in a later update,
 * before it runs the tool (cursor-agent 2026.09.26: `sendToolCall`, `getToolKind`, `refreshToolCall`).
 */
export function cursorLateNamedBandTool(toolCallId: string): SessionUpdate[] {
  return [
    { sessionUpdate: "tool_call", toolCallId, title: "MCP: tool", kind: "other", status: "pending", rawInput: {} },
    { sessionUpdate: "tool_call_update", toolCallId, title: `${MCP_SERVER_NAME}: band_send_message`,
      rawInput: { providerIdentifier: MCP_SERVER_NAME, toolName: "band_send_message", args: { content: "hi" } } },
    { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId, rawOutput: "{}", status: "completed" },
  ];
}

/** codex-acp names an MCP call on its start and sends only status and output on its end (`start_mcp_tool_call`, `end_mcp_tool_call`). */
export function codexNamedBandTool(toolCallId: string): SessionUpdate[] {
  return [
    { sessionUpdate: "tool_call", toolCallId, title: "Tool: band/band_send_message", status: "in_progress",
      rawInput: { server: MCP_SERVER_NAME, tool: "band_send_message", arguments: {} } },
    { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: "{}",
      content: [{ type: "content", content: { type: "text", text: "sent" } }] },
  ];
}

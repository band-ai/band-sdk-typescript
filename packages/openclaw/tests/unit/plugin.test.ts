import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registeredTools: [] as Array<{ name: string; execute: (toolCallId: unknown, input: unknown) => Promise<unknown> }>,
  createChatEvent: vi.fn().mockResolvedValue({ ok: true }),
  executeMcpTool: vi.fn().mockResolvedValue({ success: true, apiKey: "thnv_a_123456789abcdef" }),
}));

vi.mock("../../src/channel.js", () => ({
  registerChannel: vi.fn(),
  thenvoiChannel: {},
  setInboundCallback: vi.fn(),
  setOpenClawRuntime: vi.fn(),
  getBandToolEventContext: vi.fn(() => ({ accountId: "default", roomId: "room-123" })),
  getLink: vi.fn(() => ({ rest: { createChatEvent: mocks.createChatEvent } })),
}));

vi.mock("../../src/mcp-tools.js", () => ({
  getMcpToolSchemas: vi.fn(() => [
    {
      name: "thenvoi_lookup_peers",
      description: "Find available Band peers",
      inputSchema: { type: "object", properties: {} },
    },
  ]),
  executeMcpTool: mocks.executeMcpTool,
}));

import plugin from "../../src/index.js";

describe("OpenClaw plugin tool event reporting", () => {
  beforeEach(() => {
    mocks.registeredTools.length = 0;
    mocks.createChatEvent.mockClear();
    mocks.executeMcpTool.mockClear();
    mocks.executeMcpTool.mockResolvedValue({ success: true, apiKey: "thnv_a_123456789abcdef" });
  });

  it("emits Band tool_call and tool_result events around thenvoi tool execution", async () => {
    plugin({
      registerChannel: vi.fn(),
      registerTool: (tool) => mocks.registeredTools.push(tool),
    });

    await mocks.registeredTools[0]?.execute("tool-call-1", {
      page: 1,
      apiKey: "thnv_a_123456789abcdef",
    });

    expect(mocks.createChatEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createChatEvent).toHaveBeenNthCalledWith(
      1,
      "room-123",
      expect.objectContaining({
        messageType: "tool_call",
        content: expect.stringContaining("[REDACTED]"),
        metadata: expect.objectContaining({
          source: "openclaw",
          toolName: "thenvoi_lookup_peers",
          toolCallId: "tool-call-1",
        }),
      }),
    );
    expect(mocks.createChatEvent).toHaveBeenNthCalledWith(
      2,
      "room-123",
      expect.objectContaining({
        messageType: "tool_result",
        content: expect.stringContaining("[REDACTED]"),
        metadata: expect.objectContaining({
          source: "openclaw",
          toolName: "thenvoi_lookup_peers",
          toolCallId: "tool-call-1",
          status: "success",
        }),
      }),
    );
  });
});

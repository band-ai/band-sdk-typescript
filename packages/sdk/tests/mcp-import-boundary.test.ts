import { describe, expect, it, vi } from "vitest";

describe("MCP import boundary", () => {
  it("loads the generic MCP entrypoint without importing the Claude SDK bridge", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      throw new Error("claude sdk should not be imported by @band-ai/sdk/mcp");
    });

    const mcp = await import("../src/mcp/index");

    expect(typeof mcp.buildRoomScopedRegistrations).toBe("function");
    expect("createBandSdkMcpServer" in mcp).toBe(false);
  });
});

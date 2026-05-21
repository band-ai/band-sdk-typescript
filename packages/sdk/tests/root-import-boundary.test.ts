import { describe, expect, it, vi } from "vitest";

describe("root import boundary", () => {
  it("loads the root SDK entrypoint without importing optional ACP or Claude SDK peers", async () => {
    vi.resetModules();
    vi.doMock("@agentclientprotocol/sdk", () => {
      throw new Error("ACP SDK should not be imported by @band-ai/sdk");
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      throw new Error("Claude Agent SDK should not be imported by @band-ai/sdk");
    });

    const sdk = await import("../src/index");

    expect(typeof sdk.Agent).toBe("function");
    expect(typeof sdk.BandLink).toBe("function");
    expect(typeof sdk.AgentRuntime).toBe("function");
    expect(typeof sdk.GenericAdapter).toBe("function");
    expect(typeof sdk.ClaudeSDKAdapter).toBe("function");
  });
});

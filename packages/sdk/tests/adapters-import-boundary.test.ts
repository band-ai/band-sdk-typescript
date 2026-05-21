import { describe, expect, it, vi } from "vitest";

describe("adapters import boundary", () => {
  it("loads the adapters entrypoint without importing optional ACP or Claude SDK peers", async () => {
    vi.resetModules();
    vi.doMock("@agentclientprotocol/sdk", () => {
      throw new Error("ACP SDK should not be imported by @band-ai/sdk/adapters");
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      throw new Error("Claude Agent SDK should not be imported by @band-ai/sdk/adapters");
    });

    const adapters = await import("../src/adapters/index");

    expect(typeof adapters.OpenAIAdapter).toBe("function");
    expect(typeof adapters.ACPClientAdapter).toBe("function");
    expect(adapters.ThenvoiACPServerAdapter).toBe(adapters.BandACPServerAdapter);
    expect(typeof adapters.ClaudeSDKAdapter).toBe("function");
  });
});

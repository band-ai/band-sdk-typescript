import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { BandMcpStdioServer } from "../src/mcp/stdio";
import { FakeTools } from "./testUtils";

const connect = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
const registerTool = vi.fn();
const mcpServerCtor = vi.fn(function MockMcpServer(
  this: Record<string, unknown>,
  _serverInfo: unknown,
  _options: unknown,
) {
  this.connect = connect;
  this.registerTool = registerTool;
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: mcpServerCtor,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function MockStdioServerTransport(this: Record<string, unknown>) {
    this.close = close;
  }),
}));

describe("BandMcpStdioServer capabilities/instructions", () => {
  afterEach(() => {
    mcpServerCtor.mockClear();
    connect.mockClear();
    close.mockClear();
  });

  it("passes capabilities and instructions through to the underlying McpServer", async () => {
    const capabilities: ServerCapabilities = {
      experimental: { "claude/channel": {} },
    };
    const instructions = "Use the claude/channel notification to render inbound Band messages.";

    const server = new BandMcpStdioServer({
      tools: new FakeTools(),
      capabilities,
      instructions,
    });

    await server.start();
    await server.stop();

    expect(mcpServerCtor).toHaveBeenCalledTimes(1);
    const [, options] = mcpServerCtor.mock.calls[0]!;
    expect(options).toMatchObject({ capabilities, instructions });
  });

  it("omits capabilities and instructions when not configured", async () => {
    const server = new BandMcpStdioServer({
      tools: new FakeTools(),
    });

    await server.start();
    await server.stop();

    expect(mcpServerCtor).toHaveBeenCalledTimes(1);
    const [, options] = mcpServerCtor.mock.calls[0]!;
    expect(options).toMatchObject({ capabilities: undefined, instructions: undefined });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  CopilotACPAdapter,
  DEFAULT_COPILOT_ACP_COMMAND,
} from "../src/adapters/copilot-acp";
import { FakeTools, makeMessage } from "./testUtils";

function mockConnection(options: { prompt?: () => Promise<{ stopReason: string }> } = {}) {
  const controller = new AbortController()
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "session-1" })),
      prompt: options.prompt ?? vi.fn(async () => ({ stopReason: "end_turn" })),
    } as never,
    stop: async () => controller.abort(),
  }
}

describe("CopilotACPAdapter", () => {
  it("uses the explicit Copilot stdio command and forwards its environment", async () => {
    let received: { command: string[]; env?: Record<string, string> } | null = null
    const adapter = new CopilotACPAdapter({
      env: { COPILOT_GITHUB_TOKEN: "test-token" },
      connectionFactory: async (_client, options) => {
        received = options
        return mockConnection()
      },
    })

    await adapter.onStarted("Agent", "desc")
    expect(received).toEqual({
      command: [...DEFAULT_COPILOT_ACP_COMMAND],
      cwd: process.cwd(),
      env: { COPILOT_GITHUB_TOKEN: "test-token" },
    })
    await adapter.stop()
  })

  it("accepts a stdio command override", async () => {
    let command: string[] | null = null
    const adapter = new CopilotACPAdapter({
      command: ["copilot-preview", "--acp"],
      connectionFactory: async (_client, options) => {
        command = options.command
        return mockConnection()
      },
    })

    await adapter.onStarted("Agent", "desc")
    expect(command).toEqual(["copilot-preview", "--acp"])
    await adapter.stop()
  })

  it("maps TCP options to the generic factory and omits its environment", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let received: { command: string[]; env?: Record<string, string> } | null = null
    const adapter = new CopilotACPAdapter({
      host: "127.0.0.1",
      port: 3000,
      env: { COPILOT_GITHUB_TOKEN: "secret" },
      logger,
      connectionFactory: async (_client, options) => {
        received = options
        return mockConnection()
      },
    })

    await adapter.onStarted("Agent", "desc")
    expect(received).toEqual({ command: [], cwd: process.cwd(), env: undefined })
    expect(logger.warn.mock.calls[0]?.[0]).toContain("ignores env")
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain("secret")
    await adapter.stop()
  })

  it("rejects incomplete TCP and contradictory transport options", () => {
    expect(() => new CopilotACPAdapter({ host: "127.0.0.1" } as never)).toThrow("requires both host and port")
    expect(() => new CopilotACPAdapter({ command: ["copilot"], host: "127.0.0.1", port: 3000 } as never)).toThrow("cannot use command")
  })

  it("reports failures as Copilot ACP", async () => {
    const adapter = new CopilotACPAdapter({
      enableMcpTools: false,
      connectionFactory: async () => mockConnection({
        prompt: async () => {
          throw new Error("Copilot failed")
        },
      }),
    })
    const tools = new FakeTools()

    await adapter.onStarted("Agent", "desc")
    await expect(adapter.onMessage(
      makeMessage("hi"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    )).rejects.toThrow("Copilot failed")

    expect(tools.events.find((event) => event.messageType === "error")?.metadata?.failure)
      .toMatchObject({ provider: "copilot-acp", message: "Copilot failed" })
  })
})

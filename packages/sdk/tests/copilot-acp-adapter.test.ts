import { describe, expect, it, vi } from "vitest";

import {
  CopilotACPAdapter,
  DEFAULT_COPILOT_ACP_COMMAND,
} from "../src/adapters/copilot-acp";
import { FakeTools, makeMessage, roomWorkspacePath, tmpRoot } from "./testUtils";
import { runAcpTurn } from "./helpers/acpTurn";

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
    const root = tmpRoot()
    const adapter = new CopilotACPAdapter({
      cwd: root,
      enableMcpTools: false,
      env: { COPILOT_GITHUB_TOKEN: "test-token" },
      connectionFactory: async (_client, options) => {
        received = options
        return mockConnection()
      },
    })

    await runAcpTurn(adapter)
    expect(received).toEqual({
      command: [...DEFAULT_COPILOT_ACP_COMMAND],
      cwd: roomWorkspacePath(root, "room-1"),
      env: { COPILOT_GITHUB_TOKEN: "test-token" },
    })
    await adapter.stop()
  })

  it("accepts a stdio command override", async () => {
    let command: string[] | null = null
    const adapter = new CopilotACPAdapter({
      cwd: tmpRoot(),
      enableMcpTools: false,
      command: ["copilot-preview", "--acp"],
      connectionFactory: async (_client, options) => {
        command = options.command
        return mockConnection()
      },
    })

    await runAcpTurn(adapter)
    expect(command).toEqual(["copilot-preview", "--acp"])
    await adapter.stop()
  })

  it("reports failures as Copilot ACP", async () => {
    const adapter = new CopilotACPAdapter({
      cwd: tmpRoot(),
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

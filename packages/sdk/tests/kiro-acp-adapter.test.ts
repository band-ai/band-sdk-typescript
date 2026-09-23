import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_KIRO_ACP_COMMAND,
  KIRO_MCP_OAUTH_REQUEST_METHOD,
  KIRO_METADATA_METHOD,
  KiroACPAdapter,
} from "../src/adapters/kiro-acp";
import { FakeTools, makeMessage } from "./testUtils";

interface KiroClient {
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

function mockConnection(prompt: () => Promise<{ stopReason: string }>) {
  const controller = new AbortController()
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "kiro-session" })),
      prompt,
    } as never,
    stop: async () => controller.abort(),
  }
}

describe("KiroACPAdapter", () => {
  it("uses the default stdio command", async () => {
    let command: string[] | null = null
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      connectionFactory: async (_client, options) => {
        command = options.command
        return mockConnection(async () => ({ stopReason: "end_turn" }))
      },
    })

    await adapter.onStarted("Agent", "desc")
    expect(command).toEqual([...DEFAULT_KIRO_ACP_COMMAND])
    await adapter.stop()
  })

  it("accepts a stdio command override", async () => {
    let command: string[] | null = null
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      command: ["kiro-cli-preview", "acp"],
      connectionFactory: async (_client, options) => {
        command = options.command
        return mockConnection(async () => ({ stopReason: "end_turn" }))
      },
    })

    await adapter.onStarted("Agent", "desc")
    expect(command).toEqual(["kiro-cli-preview", "acp"])
    await adapter.stop()
  })

  it("reports failures as kiro-acp", async () => {
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      connectionFactory: async () => mockConnection(async () => {
        throw new Error("Kiro failed")
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
    )).rejects.toThrow("Kiro failed")

    expect(tools.events.find((event) => event.messageType === "error")?.metadata?.failure)
      .toMatchObject({ provider: "kiro-acp", message: "Kiro failed" })
  })

  it("declines _kiro.dev/mcp/oauth_request rather than hanging the agent, and warns", async () => {
    let client: KiroClient | undefined
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let response: Record<string, unknown> | null = null
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      logger,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(async () => {
          response = await client!.extMethod(KIRO_MCP_OAUTH_REQUEST_METHOD, { server: "some-mcp-server" })
          return { stopReason: "end_turn" }
        })
      },
    })

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi"), new FakeTools(), { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" })

    expect(response).toEqual({ outcome: "declined" })
    expect(logger.warn).toHaveBeenCalledWith("kiro_acp.oauth_request_declined", { method: KIRO_MCP_OAUTH_REQUEST_METHOD })
    await adapter.stop()
  })

  it("surfaces _kiro.dev/metadata as a context-window usage event when the payload carries recognizable usage fields", async () => {
    let client: KiroClient | undefined
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(async () => {
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 4200, contextWindowSize: 200_000 })
          return { stopReason: "end_turn" }
        })
      },
    })
    const tools = new FakeTools()

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi"), tools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" })

    expect(tools.events.map(({ content, messageType }) => ({ content, messageType }))).toEqual(
      expect.arrayContaining([{ content: "[Kiro context window] 4200/200000 tokens (2%)", messageType: "task" }]),
    )
    await adapter.stop()
  })

  it("is a no-op for _kiro.dev/metadata payloads with no recognizable usage fields, and for unrelated extension methods", async () => {
    let client: KiroClient | undefined
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(async () => {
          await client!.extNotification(KIRO_METADATA_METHOD, { unrelatedField: true })
          await client!.extNotification("_kiro.dev/clear/status", { cleared: true })
          const unhandled = await client!.extMethod("_kiro.dev/commands/available", {})
          expect(unhandled).toEqual({})
          return { stopReason: "end_turn" }
        })
      },
    })
    const tools = new FakeTools()

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi"), tools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" })

    expect(tools.events.filter((event) => event.messageType === "task" && event.content.startsWith("[Kiro"))).toEqual([])
    await adapter.stop()
  })
})

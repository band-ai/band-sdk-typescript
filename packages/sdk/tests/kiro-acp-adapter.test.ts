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

function mockConnection(
  prompt: (params: { sessionId: string }) => Promise<{ stopReason: string }>,
  overrides: {
    newSession?: (params?: Record<string, unknown>) => Promise<{ sessionId: string }>;
    cancel?: () => Promise<void>;
    loadSession?: (params: { sessionId: string }) => Promise<Record<string, unknown>>;
    agentCapabilities?: Record<string, unknown>;
  } = {},
) {
  const controller = new AbortController()
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: overrides.agentCapabilities ?? {},
      })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(overrides.newSession ?? (async () => ({ sessionId: "kiro-session" }))),
      prompt,
      ...(overrides.cancel ? { cancel: vi.fn(overrides.cancel) } : {}),
      ...(overrides.loadSession ? { loadSession: vi.fn(overrides.loadSession) } : {}),
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

  it("passes base ACPClientAdapter options (e.g. cwd) through to the underlying session", async () => {
    let newSessionParams: Record<string, unknown> | null = null
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      cwd: "/workspace/kiro",
      connectionFactory: async () => mockConnection(async () => ({ stopReason: "end_turn" }), {
        newSession: async (params) => {
          newSessionParams = params ?? {}
          return { sessionId: "kiro-session" }
        },
      }),
    })

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi"), new FakeTools(), { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" })

    expect(newSessionParams).toMatchObject({ cwd: "/workspace/kiro" })
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

  it("reads context-window aliases and ignores usage that is missing, non-finite, negative, fractional, or exceeds a non-positive total", async () => {
    let client: KiroClient | undefined
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      logger,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(async () => {
          await client!.extNotification(KIRO_METADATA_METHOD, { tokensUsed: 10, contextWindowTotal: 100 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10, contextWindowSize: 0 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10, contextWindowSize: -5 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: Number.NaN, contextWindowSize: 100 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: Number.POSITIVE_INFINITY, contextWindowSize: 100 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: -10, contextWindowSize: 100 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 500, contextWindowSize: 100 })
          await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 0.5, contextWindowSize: 100 })
          return { stopReason: "end_turn" }
        })
      },
    })
    const tools = new FakeTools()

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi"), tools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" })

    expect(tools.events.filter((event) => event.content.startsWith("[Kiro context window]")).map((event) => event.content)).toEqual([
      "[Kiro context window] 10/100 tokens (10%)",
    ])
    expect(logger.warn).toHaveBeenCalledWith("kiro_acp.metadata_unrecognized", {
      method: KIRO_METADATA_METHOD,
      keys: ["contextWindowUsed"],
    })
    await adapter.stop()
  })

  it("attributes a sessionless metadata notification to the next prompt after a timed-out prompt never settles", async () => {
    let client: KiroClient | undefined
    let created = 0
    let markBInPrompt: () => void = () => undefined
    let releaseB: () => void = () => undefined
    const bInPrompt = new Promise<void>((resolve) => {
      markBInPrompt = resolve
    })
    const bRelease = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      if (params.sessionId === "kiro-1") {
        return new Promise<{ stopReason: string }>(() => undefined)
      }
      markBInPrompt()
      await bRelease
      return { stopReason: "end_turn" }
    })
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      turnTimeoutMs: 30,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(prompt, {
          newSession: async () => ({ sessionId: `kiro-${++created}` }),
          cancel: async () => undefined,
        })
      },
    })
    const toolsA = new FakeTools()
    const toolsB = new FakeTools()
    await adapter.onStarted("Agent", "desc")
    await expect(adapter.onMessage(
      makeMessage("hello A", "room-a"),
      toolsA,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-a" },
    )).rejects.toThrow("ACP turn timed out")
    const turnB = adapter.onMessage(
      makeMessage("hello B", "room-b"),
      toolsB,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-b" },
    )
    await bInPrompt
    await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10, contextWindowSize: 100 })
    releaseB()
    await turnB
    const usage = "[Kiro context window] 10/100 tokens (10%)"
    expect(toolsB.events.some((event) => event.content === usage)).toBe(true)
    expect(toolsA.events.some((event) => event.content === usage)).toBe(false)
    await adapter.stop()
  })

  it("drops a sessionless metadata notification when two prompts are in flight", async () => {
    let client: KiroClient | undefined
    let created = 0
    let markA: () => void = () => undefined
    let markB: () => void = () => undefined
    let releaseBoth: () => void = () => undefined
    const aIn = new Promise<void>((resolve) => { markA = resolve })
    const bIn = new Promise<void>((resolve) => { markB = resolve })
    const release = new Promise<void>((resolve) => { releaseBoth = resolve })
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      if (params.sessionId === "kiro-1") {
        markA()
      } else {
        markB()
      }
      await release
      return { stopReason: "end_turn" }
    })
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      logger,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(prompt, { newSession: async () => ({ sessionId: `kiro-${++created}` }) })
      },
    })
    const toolsA = new FakeTools()
    const toolsB = new FakeTools()
    await adapter.onStarted("Agent", "desc")
    const turnA = adapter.onMessage(makeMessage("hello A", "room-a"), toolsA, { roomToSession: {} }, null, null, { isSessionBootstrap: true, roomId: "room-a" })
    const turnB = adapter.onMessage(makeMessage("hello B", "room-b"), toolsB, { roomToSession: {} }, null, null, { isSessionBootstrap: true, roomId: "room-b" })
    await aIn
    await bIn
    await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10, contextWindowSize: 100 })
    releaseBoth()
    await Promise.all([turnA, turnB])
    const usage = "[Kiro context window] 10/100 tokens (10%)"
    expect(toolsA.events.some((event) => event.content === usage)).toBe(false)
    expect(toolsB.events.some((event) => event.content === usage)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith("kiro_acp.metadata_unattributed", {
      method: KIRO_METADATA_METHOD,
      keys: ["contextWindowUsed", "contextWindowSize"],
    })
    await adapter.stop()
  })

  it("keeps a reused session id in flight when the timed-out prompt settles later", async () => {
    let client: KiroClient | undefined
    let created = 0
    let releaseHung: () => void = () => undefined
    const hung = new Promise<{ stopReason: string }>((resolve) => {
      releaseHung = () => resolve({ stopReason: "end_turn" })
    })
    let markSecond: () => void = () => undefined
    let releaseSecond: () => void = () => undefined
    const secondIn = new Promise<void>((resolve) => { markSecond = resolve })
    const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve })
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      if (params.sessionId === "s-a" && created === 1) {
        return hung
      }
      markSecond()
      await secondRelease
      return { stopReason: "end_turn" }
    })
    const adapter = new KiroACPAdapter({
      enableMcpTools: false,
      turnTimeoutMs: 30,
      connectionFactory: async (captured) => {
        client = captured as KiroClient
        return mockConnection(prompt, {
          newSession: async () => {
            created += 1
            return { sessionId: "s-a" }
          },
          cancel: async () => undefined,
        })
      },
    })
    const toolsB = new FakeTools()
    await adapter.onStarted("Agent", "desc")
    await expect(adapter.onMessage(
      makeMessage("hello A", "room-a"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-a" },
    )).rejects.toThrow("ACP turn timed out")
    const turnB = adapter.onMessage(
      makeMessage("hello B", "room-b"),
      toolsB,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-b" },
    )
    await secondIn
    releaseHung()
    // The hung prompt's `finally` runs on a later microtask than the
    // resolution itself. Yielding one turn would notify while that token
    // is still the only entry, which is already true after the timeout
    // released it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client!.extNotification(KIRO_METADATA_METHOD, { contextWindowUsed: 10, contextWindowSize: 100 })
    releaseSecond()
    await turnB
    expect(toolsB.events.some((event) => event.content === "[Kiro context window] 10/100 tokens (10%)")).toBe(true)
    await adapter.stop()
  })

  // Two REAL, sequential adapter lifecycles standing in for a `kiro-cli`
  // process restart -- the exact shape of the two live E2E scenarios dropped
  // for lack of a paid Kiro subscription (previously
  // packages/sdk/tests/integration/kiro-acp-live.ts). Unlike the
  // single-instance tests above, phase 2 runs against a brand-new
  // `KiroACPAdapter`, so whatever session id it tries to resume is whatever
  // phase 1's mock actually returned -- not a hand-picked constant. What a
  // real `KIRO_HOME` would persist across a restart is modeled by whether
  // phase 2's `loadSession` mock recognizes phase 1's session id.
  describe("multi-stage recall across a simulated restart", () => {
    it("recalls a fact via native session/load resume", async () => {
      const trackingMarker = "MARKER-7421"
      const agentFact = "the sky is blue"
      const sessionId = "kiro-restart-session"

      const adapter1 = new KiroACPAdapter({
        enableMcpTools: false,
        connectionFactory: async () => mockConnection(
          async () => ({ stopReason: "end_turn" }),
          { newSession: async () => ({ sessionId }) },
        ),
      })
      await adapter1.onStarted("Agent", "desc")
      await adapter1.onMessage(
        makeMessage(`Log a note with tracking marker ${trackingMarker} and state a fact: ${agentFact}.`),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      )
      await adapter1.stop()

      // A fresh adapter instance wired to the same session id a persisted
      // KIRO_HOME would carry across the restart.
      const loadSession = vi.fn(async (params: { sessionId: string }) => {
        if (params.sessionId !== sessionId) throw new Error("agent forgot this session")
        return {}
      })
      const newSession = vi.fn(async () => ({ sessionId: "should-not-be-created" }))
      const adapter2 = new KiroACPAdapter({
        enableMcpTools: false,
        connectionFactory: async () => mockConnection(
          async () => ({ stopReason: "end_turn" }),
          { loadSession, newSession, agentCapabilities: { loadSession: true } },
        ),
      })
      await adapter2.onStarted("Agent", "desc")
      await adapter2.onMessage(
        makeMessage("What did you log earlier?"),
        new FakeTools(),
        { roomToSession: { "room-1": sessionId } },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      )

      expect(loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }))
      expect(newSession).not.toHaveBeenCalled()
      await adapter2.stop()
    })

    it("recalls a fact via room-replay fallback when session/load misses", async () => {
      const trackingMarker = "MARKER-9182"
      const agentFact = "the sky is blue"
      const staleSessionId = "kiro-stale-session"

      const adapter1 = new KiroACPAdapter({
        enableMcpTools: false,
        connectionFactory: async () => mockConnection(
          async () => ({ stopReason: "end_turn" }),
          { newSession: async () => ({ sessionId: staleSessionId }) },
        ),
      })
      await adapter1.onStarted("Agent", "desc")
      await adapter1.onMessage(
        makeMessage(`Log a note with tracking marker ${trackingMarker} and state a fact: ${agentFact}.`),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      )
      await adapter1.stop()

      // A fresh KIRO_HOME after restart: session/load genuinely misses, so
      // Band's own room-replay fallback is the only way phase 2 recalls
      // what phase 1 said.
      const loadSession = vi.fn(async () => {
        throw new Error("agent forgot this session")
      })
      const newSession = vi.fn(async () => ({ sessionId: "kiro-fresh-session" }))
      const promptTexts: string[] = []
      const prompt = vi.fn(async (params: { sessionId: string; prompt?: Array<{ text?: string }> }) => {
        promptTexts.push(params.prompt?.[0]?.text ?? "")
        return { stopReason: "end_turn" }
      })
      const adapter2 = new KiroACPAdapter({
        enableMcpTools: false,
        connectionFactory: async () => mockConnection(prompt, {
          loadSession,
          newSession,
          agentCapabilities: { loadSession: true },
        }),
      })
      await adapter2.onStarted("Agent", "desc")
      await adapter2.onMessage(
        makeMessage("What did you log earlier?"),
        new FakeTools(),
        {
          roomToSession: { "room-1": staleSessionId },
          replayMessages: [
            { id: "earlier-1", line: `[User]: Log a note with tracking marker ${trackingMarker} and state a fact: ${agentFact}.` },
            { id: "earlier-2", line: `[Agent]: Logged ${trackingMarker}: ${agentFact}` },
          ],
        },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      )

      expect(loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: staleSessionId }))
      expect(newSession).toHaveBeenCalledTimes(1)
      expect(promptTexts[0]).toContain(trackingMarker)
      expect(promptTexts[0]).toContain(agentFact)
      await adapter2.stop()
    })
  })
})

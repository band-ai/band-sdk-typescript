import { describe, expect, it, vi } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import { FAILURE_EVENT_TYPE, FAILURE_METADATA_KEY } from "../src/contracts/protocols";
import {
  BandACPServerAdapter,
} from "../src/adapters/acp";
import { FakeRestApi, FakeTools, makeMessage } from "./testUtils";

function makeFailure(content: string, roomId: string, metadata: Record<string, unknown> = {}) {
  return { ...makeMessage(content, roomId, metadata), messageType: FAILURE_EVENT_TYPE }
}

async function createFixture(options: {
  graceMs?: number;
  timeoutMs?: number;
  pauseBeforeSend?: Promise<void>;
  messageDelivery?: () => Promise<void>;
  sessionUpdate?: (params: Record<string, unknown>) => Promise<void>;
} = {}) {
  let nextRoom = 0
  const sentMessages: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const adapter = new BandACPServerAdapter({
    bandRest: new FakeRestApi({
      createChat: async () => ({ id: `room-${++nextRoom}` }),
      createChatMessage: async (_roomId, message) => {
        sentMessages.push(message as Record<string, unknown>)
        await options.messageDelivery?.()
        return { ok: true }
      },
      listChatParticipants: async () => {
        await options.pauseBeforeSend
        return [{ id: "peer-1", name: "Peer", type: "Agent", handle: "peer" }]
      },
    }, { id: "agent-1", name: "Band Agent", description: null }),
    promptCompletionGraceMs: options.graceMs ?? 10,
    responseTimeoutMs: options.timeoutMs ?? 150,
  })
  await adapter.onStarted("Band Agent", "ACP server")
  adapter.bindConnection({
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    sessionUpdate: async (params: Record<string, unknown>) => {
      updates.push(params)
      await options.sessionUpdate?.(params)
    },
  } as never)
  const emit = async (message: ReturnType<typeof makeMessage>) => adapter.onMessage(
    message,
    new FakeTools(),
    { sessionToRoom: {}, sessionCwd: {}, sessionMcpServers: {} },
    null,
    null,
    { isSessionBootstrap: false, roomId: message.roomId },
  )
  return { adapter, sentMessages, updates, emit }
}

describe("BandACPServerAdapter", () => {
  it("creates ACP sessions, routes prompts, and streams room responses", async () => {
    const createdEvents: Array<Record<string, unknown>> = []
    const sentMessages: Array<Record<string, unknown>> = []
    const rest = new FakeRestApi({
      createChat: async () => ({ id: "room-1" }),
      createChatEvent: async (_chatId, event) => {
        createdEvents.push(event as Record<string, unknown>)
        return { ok: true }
      },
      createChatMessage: async (_chatId, message) => {
        sentMessages.push(message as Record<string, unknown>)
        return { ok: true }
      },
      listChatParticipants: async () => [
        { id: "agent-1", name: "Band Agent", type: "Agent", handle: "band" },
        { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
        { id: "peer-2", name: "Claude", type: "Agent", handle: "claude" },
      ],
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      bandRest: rest,
      promptCompletionGraceMs: 5,
      responseTimeoutMs: 500,
      slashCommands: {
        codex: "Codex",
      },
    })
    await adapter.onStarted("Band Agent", "ACP server")

    const updates: Array<Record<string, unknown>> = []
    adapter.bindConnection({
      signal: new AbortController().signal,
      closed: Promise.resolve(),
      sessionUpdate: vi.fn(async (params) => {
        updates.push(params as Record<string, unknown>)
      }),
    } as never)

    const sessionId = await adapter.createSession({
      cwd: "/workspace",
      mcpServers: [{
        type: "stdio",
        name: "filesystem",
        command: "mcp-fs",
        args: ["--cwd", "/workspace"],
        env: [],
      }] as never,
    })

    expect(sessionId).toBeTruthy()
    expect(createdEvents).toEqual([
      expect.objectContaining({
        messageType: "task",
        metadata: expect.objectContaining({
          acp_session_id: sessionId,
          acp_room_id: "room-1",
          acp_cwd: "/workspace",
        }),
      }),
    ])

    const promptPromise = adapter.handlePrompt(sessionId, "/codex fix this bug")
    await vi.waitFor(() => {
      expect(sentMessages).toHaveLength(1)
    })

    expect(sentMessages[0]).toEqual(expect.objectContaining({
      content: expect.stringContaining("[ACP Session Context]"),
      mentions: [{
        id: "peer-1",
        handle: "codex",
        name: "Codex",
      }],
    }))

    await adapter.onMessage(
      makeMessage("done", "room-1"),
      new FakeTools(),
      {
        sessionToRoom: {},
        sessionCwd: {},
        sessionMcpServers: {},
      },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    )
    await promptPromise

    expect(updates).toEqual([
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: expect.objectContaining({
            text: "done",
          }),
        }),
      }),
    ])

    await adapter.onMessage(
      makeMessage("background update", "room-1"),
      new FakeTools(),
      {
        sessionToRoom: {},
        sessionCwd: {},
        sessionMcpServers: {},
      },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    )

    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual(expect.objectContaining({
      sessionId,
      update: expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: expect.objectContaining({
          text: "background update",
        }),
      }),
    }))
  })

  it("rolls back local session state if bootstrap event creation fails", async () => {
    const rest = new FakeRestApi({
      createChat: async () => ({ id: "room-rollback" }),
      createChatEvent: async () => {
        throw new Error("bootstrap failed")
      },
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      bandRest: rest,
      maxSessions: 1,
    })
    await adapter.onStarted("Band Agent", "ACP server")

    await expect(adapter.createSession({
      cwd: "/workspace",
    })).rejects.toThrow("bootstrap failed")

    expect(adapter.getSessionIds()).toEqual([])
    expect(adapter.hasSession("missing")).toBe(false)

    await expect(adapter.createSession({
      cwd: "/workspace",
    })).rejects.toThrow("bootstrap failed")
    expect(adapter.getSessionIds()).toEqual([])
  })

  it("times out prompts after tool-only room updates", async () => {
    const sentMessages: Array<Record<string, unknown>> = []
    const adapter = new BandACPServerAdapter({
      bandRest: new FakeRestApi({
        createChat: async () => ({ id: "room-tools" }),
        createChatMessage: async (_chatId, message) => {
          sentMessages.push(message as Record<string, unknown>)
          return { ok: true }
        },
        listChatParticipants: async () => [
          { id: "agent-1", name: "Band Agent", type: "Agent", handle: "band" },
          { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
        ],
      }, { id: "agent-1", name: "Band Agent", description: null }),
      promptCompletionGraceMs: 5,
      responseTimeoutMs: 100,
      slashCommands: {
        codex: "Codex",
      },
    })
    await adapter.onStarted("Band Agent", "ACP server")

    adapter.bindConnection({
      signal: new AbortController().signal,
      closed: Promise.resolve(),
      sessionUpdate: vi.fn(async () => undefined),
    } as never)

    const sessionId = await adapter.createSession()
    const promptPromise = adapter.handlePrompt(sessionId, "/codex use tools only")
    await vi.waitFor(() => {
      expect(sentMessages).toHaveLength(1)
    })

    const toolOnlyMessage = {
      ...makeMessage("{\"name\":\"lookup_weather\",\"tool_call_id\":\"call-1\",\"args\":{\"city\":\"Vancouver\"}}", "room-tools"),
      messageType: "tool_call" as const,
    }

    await adapter.onMessage(
      toolOnlyMessage,
      new FakeTools(),
      {
        sessionToRoom: {},
        sessionCwd: {},
        sessionMcpServers: {},
      },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-tools" },
    )

    await expect(promptPromise).rejects.toThrow("ACP prompt timed out")
  })

  it("preserves and redacts structured failure detail in a terminal prompt error", async () => {
    const { adapter, sentMessages, updates, emit } = await createFixture()
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "fix this")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))

    const metadata = { [FAILURE_METADATA_KEY]: {
      provider: "openai",
      message: "provider failed",
      code: "rate_limit",
      detail: { trace: ["Bearer sk-private", {
        API_KEY: "sk-private",
        client_secret: "opaque-private",
        token: { value: "opaque-token", attempts: 2, history: ["older-token", null] },
        note: "retry", attempts: 2, allowed: false, extra: null,
      }] },
    } }
    await emit(makeFailure("provider failed", "room-1", metadata))
    const outcome = await prompt
    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") throw new Error("Expected failure")
    const projection = new AgentFailure("openai", "provider failed", "rate_limit", {
      trace: ["Bearer [REDACTED]", {
        API_KEY: "[REDACTED]",
        client_secret: "[REDACTED]",
        token: { value: "[REDACTED]", attempts: 2, history: ["[REDACTED]", null] },
        note: "retry", attempts: 2, allowed: false, extra: null,
      }],
    }).toExtensionData()
    expect(outcome.failure.toExtensionData()).toEqual(projection)
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[Error] provider failed" }, _meta: projection },
    })
  })

  it("falls back to a local failure for missing or malformed room metadata", async () => {
    const { adapter, sentMessages, emit } = await createFixture()
    const sessionId = await adapter.createSession()
    const cyclicDetail: Record<string, unknown> = {}
    cyclicDetail.self = cyclicDetail
    for (const metadata of [
      {},
      { [FAILURE_METADATA_KEY]: { provider: "", message: "bad", detail: { token: "secret" } } },
      { [FAILURE_METADATA_KEY]: { provider: "peer", message: "bad", code: 42 } },
      { [FAILURE_METADATA_KEY]: { provider: "peer", message: "bad", detail: { nested: undefined } } },
      { [FAILURE_METADATA_KEY]: { provider: "peer", message: "bad", detail: cyclicDetail } },
    ]) {
      const prompt = adapter.handlePrompt(sessionId, "retry")
      const expectedCount = sentMessages.length + 1
      await vi.waitFor(() => expect(sentMessages).toHaveLength(expectedCount))
      await emit(makeFailure("  token=secret  ", "room-1", metadata))
      const outcome = await prompt
      expect(outcome.kind).toBe("failure")
      if (outcome.kind !== "failure") throw new Error("Expected failure")
      expect(outcome.failure.toObject()).toEqual(new AgentFailure("band", "token=[REDACTED]").toObject())
    }
  })

  it("keeps thought and tool updates nonterminal, then settles on failure", async () => {
    const { adapter, sentMessages, emit } = await createFixture({ graceMs: 5 })
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "run tool")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await emit({ ...makeMessage("thinking", "room-1"), messageType: "thought" })
    await emit({ ...makeMessage("{}", "room-1"), messageType: "tool_call" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await emit(makeFailure("tool failed", "room-1"))
    expect((await prompt).kind).toBe("failure")
  })

  it("lets an error override text during grace without waiting for a stalled chunk", async () => {
    let releaseUpdate: (() => void) | undefined
    const { adapter, sentMessages, updates, emit } = await createFixture({
      graceMs: 80,
      sessionUpdate: async (params) => {
        const update = params.update as { content?: { text?: string } }
        if (update.content?.text?.startsWith("[Error]")) {
          await new Promise<void>((resolve) => { releaseUpdate = resolve })
        }
      },
    })
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "fix")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await emit(makeMessage("partial answer", "room-1"))
    await emit(makeFailure("failed", "room-1"))
    expect((await prompt).kind).toBe("failure")
    await vi.waitFor(() => expect(updates).toHaveLength(2))
    releaseUpdate?.()
  })

  it("keeps the prompt failure when the readable error update fails", async () => {
    const { adapter, sentMessages, emit } = await createFixture({
      sessionUpdate: async () => { throw new Error("client update failed") },
    })
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "fix")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await emit(makeFailure("failed", "room-1"))
    expect((await prompt).kind).toBe("failure")
  })

  it("keeps the first terminal outcome across cancellation and cleanup", async () => {
    const { adapter, sentMessages, emit } = await createFixture()
    const sessionId = await adapter.createSession()
    const first = adapter.handlePrompt(sessionId, "first")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await adapter.cancelPrompt(sessionId)
    await emit(makeFailure("late error", "room-1"))
    expect((await first).kind).toBe("cancelled")

    const second = adapter.handlePrompt(sessionId, "second")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(2))
    await emit(makeFailure("first error", "room-1"))
    await adapter.cancelPrompt(sessionId)
    await adapter.onCleanup("room-1")
    const outcome = await second
    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") throw new Error("Expected failure")
    expect(outcome.failure.message).toBe("first error")
  })

  it("fails a pending prompt when its room is cleaned up", async () => {
    const { adapter, sentMessages } = await createFixture()
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "fix")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await adapter.onCleanup("room-1")
    const outcome = await prompt
    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") throw new Error("Expected failure")
    expect(outcome.failure.toObject()).toEqual(new AgentFailure("band", "Band room closed before prompt completed.").toObject())
  })

  it("rejects a second same-room prompt without replacing the first", async () => {
    const { adapter, sentMessages, emit } = await createFixture()
    const firstSession = await adapter.createSession()
    const secondSession = await adapter.createSession()
    const first = adapter.handlePrompt(firstSession, "first")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await expect(adapter.handlePrompt(firstSession, "duplicate")).rejects.toThrow("already active")
    expect(sentMessages).toHaveLength(1)
    const otherRoom = adapter.handlePrompt(secondSession, "independent")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(2))
    await emit(makeMessage("done", "room-1"))
    await emit(makeMessage("done", "room-2"))
    expect((await first).kind).toBe("completed")
    expect((await otherRoom).kind).toBe("completed")
  })

  it("keeps the first prompt active during participant lookup, then settles on room failure", async () => {
    let releaseParticipants: (() => void) | undefined
    const pauseBeforeSend = new Promise<void>((resolve) => { releaseParticipants = resolve })
    const { adapter, sentMessages, emit } = await createFixture({ pauseBeforeSend })
    const sessionId = await adapter.createSession()
    const first = adapter.handlePrompt(sessionId, "first")

    await expect(adapter.handlePrompt(sessionId, "overlapping")).rejects.toThrow("already active")
    await emit(makeFailure("failed during lookup", "room-1", {
      [FAILURE_METADATA_KEY]: { provider: "peer", message: "failed during lookup" },
    }))
    const outcome = await first
    releaseParticipants?.()
    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") throw new Error("Expected failure")
    expect(outcome.failure.toExtensionData()).toEqual(
      new AgentFailure("peer", "failed during lookup").toExtensionData(),
    )
    expect(sentMessages).toHaveLength(0)
  })

  it("keeps a room failure when the in-flight prompt delivery later fails", async () => {
    let rejectDelivery: ((error: Error) => void) | undefined
    const delivery = new Promise<void>((_, reject) => { rejectDelivery = reject })
    const { adapter, sentMessages, emit } = await createFixture({
      messageDelivery: () => delivery,
    })
    const sessionId = await adapter.createSession()
    const prompt = adapter.handlePrompt(sessionId, "fix")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))

    await emit(makeFailure("peer failed", "room-1"))
    const outcome = await prompt
    rejectDelivery?.(new Error("Band send failed"))
    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") throw new Error("Expected failure")
    expect(outcome.failure.message).toBe("peer failed")
  })

  it("does not let an old completion timer finish a later prompt", async () => {
    const { adapter, sentMessages, emit } = await createFixture({ graceMs: 20, timeoutMs: 150 })
    const sessionId = await adapter.createSession()
    const first = adapter.handlePrompt(sessionId, "first")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await emit(makeMessage("first reply", "room-1"))
    await adapter.cancelPrompt(sessionId)
    expect((await first).kind).toBe("cancelled")

    const second = adapter.handlePrompt(sessionId, "second")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    await emit(makeFailure("second failed", "room-1"))
    expect((await second).kind).toBe("failure")
  })
});

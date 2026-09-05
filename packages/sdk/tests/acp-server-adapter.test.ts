import { describe, expect, it, vi } from "vitest";

import {
  BandACPServerAdapter,
} from "../src/adapters/acp";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { ValidationError } from "../src/core/errors";
import { FakeRestApi, FakeTools, makeMessage } from "./testUtils";

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

  it("completes ACP prompts after tool-only room updates", async () => {
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

    await expect(promptPromise).resolves.toBeUndefined()
  })

  // A rehydrated session whose bootstrap event carried no `acp_cwd` gets no
  // session-context preamble, so a whitespace-only prompt reaches the send
  // path blank; the transport refuses it and no reply can ever arrive. The
  // adapter has to say that, not sit out `responseTimeoutMs` and blame a slow
  // peer. The real FernRestAdapter produces the refusal so the test can't pass
  // against a hand-copied result shape.
  it("fails a blank prompt immediately instead of waiting out the response timeout", async () => {
    const createAgentChatMessage = vi.fn()
    const transport = new FernRestAdapter({ agentApiMessages: { createAgentChatMessage } })
    const adapter = new BandACPServerAdapter({
      bandRest: new FakeRestApi({
        createChatMessage: (chatId, message) => transport.createChatMessage(chatId, message),
        listChatParticipants: async () => [
          { id: "agent-1", name: "Band Agent", type: "Agent", handle: "band" },
          { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
        ],
      }, { id: "agent-1", name: "Band Agent", description: null }),
      responseTimeoutMs: 60_000,
    })
    await adapter.onStarted("Band Agent", "ACP server")

    await adapter.onMessage(
      makeMessage("hello", "room-rehydrated"),
      new FakeTools(),
      {
        sessionToRoom: { "session-rehydrated": "room-rehydrated" },
        sessionCwd: {},
        sessionMcpServers: {},
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-rehydrated" },
    )

    const error = await adapter.handlePrompt("session-rehydrated", "   ").catch((caught) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toMatch(/blank/i)
    expect(createAgentChatMessage).not.toHaveBeenCalled()
  })

  // A resolved ok:false isn't only a blank-content refusal -- the platform can
  // reject a send for other reasons too, and that must surface just as
  // immediately instead of silently degrading into a response timeout.
  it("fails a genuinely rejected prompt immediately, not just a blank one", async () => {
    const adapter = new BandACPServerAdapter({
      bandRest: new FakeRestApi({
        createChatMessage: async () => ({ ok: false, status: "moderation_rejected", error: "flagged content" }),
        listChatParticipants: async () => [
          { id: "agent-1", name: "Band Agent", type: "Agent", handle: "band" },
          { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
        ],
      }, { id: "agent-1", name: "Band Agent", description: null }),
      responseTimeoutMs: 60_000,
    })
    await adapter.onStarted("Band Agent", "ACP server")

    await adapter.onMessage(
      makeMessage("hello", "room-rejected"),
      new FakeTools(),
      {
        sessionToRoom: { "session-rejected": "room-rejected" },
        sessionCwd: {},
        sessionMcpServers: {},
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-rejected" },
    )

    const error = await adapter.handlePrompt("session-rejected", "fix this bug").catch((caught) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toMatch(/flagged content/)
  })
});

import { describe, expect, it, vi } from "vitest";

import {
  BandACPServerAdapter,
  ThenvoiACPServerAdapter,
} from "../src/adapters/acp";
import { FakeRestApi, FakeTools, makeMessage } from "./testUtils";

describe("BandACPServerAdapter", () => {
  it("exports the legacy ThenvoiACPServerAdapter alias", () => {
    expect(ThenvoiACPServerAdapter).toBe(BandACPServerAdapter);
  });

  it("accepts the canonical bandRest option", () => {
    const rest = new FakeRestApi();
    expect(() => new BandACPServerAdapter({ bandRest: rest })).not.toThrow();
  });

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
        { id: "agent-1", name: "Band Agent", type: "Agent", handle: "thenvoi" },
        { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
        { id: "peer-2", name: "Claude", type: "Agent", handle: "claude" },
      ],
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      thenvoiRest: rest,
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
      thenvoiRest: rest,
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
      thenvoiRest: new FakeRestApi({
        createChat: async () => ({ id: "room-tools" }),
        createChatMessage: async (_chatId, message) => {
          sentMessages.push(message as Record<string, unknown>)
          return { ok: true }
        },
        listChatParticipants: async () => [
          { id: "agent-1", name: "Band Agent", type: "Agent", handle: "thenvoi" },
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
});

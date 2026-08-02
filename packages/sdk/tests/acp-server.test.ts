import { describe, expect, it, vi } from "vitest";

import {
  ACPServer,
  BandACPServerAdapter,
} from "../src/adapters/acp";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { FakeRestApi, FakeTools, makeMessage } from "./testUtils";

describe("ACPServer", () => {
  it("handles an in-memory ACP client session over the official SDK transport", async () => {
    const sentMessages: Array<Record<string, unknown>> = []
    const rest = new FakeRestApi({
      createChat: async () => ({ id: "room-1" }),
      createChatMessage: async (_chatId, message) => {
        sentMessages.push(message as Record<string, unknown>)
        return { ok: true }
      },
      listChatParticipants: async () => [
        { id: "agent-1", name: "Band Agent", type: "Agent", handle: "thenvoi" },
        { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
      ],
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      thenvoiRest: rest,
      promptCompletionGraceMs: 5,
      responseTimeoutMs: 500,
    })
    await adapter.onStarted("Band Agent", "ACP server")

    const server = new ACPServer(adapter)

    const toAgent = new TransformStream<Uint8Array, Uint8Array>()
    const toClient = new TransformStream<Uint8Array, Uint8Array>()
    await server.connectStream(ndJsonStream(toClient.writable, toAgent.readable))

    const sessionUpdates: Array<Record<string, unknown>> = []
    const client = new ClientSideConnection(() => ({
      requestPermission: async () => ({
        outcome: {
          outcome: "cancelled",
        },
      }),
      sessionUpdate: async (params) => {
        sessionUpdates.push(params as Record<string, unknown>)
      },
    }), ndJsonStream(toAgent.writable, toClient.readable))

    const init = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    })
    expect(init.protocolVersion).toBe(1)
    expect(init.agentCapabilities?.loadSession).toBe(true)
    expect(init.agentCapabilities?.mcpCapabilities).toBeUndefined()

    const session = await client.newSession({
      cwd: "/workspace",
      mcpServers: [],
    })

    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: [{
        type: "text",
        text: "fix this bug",
      }],
    })

    await vi.waitFor(() => {
      expect(sentMessages).toHaveLength(1)
    })

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

    const response = await promptPromise
    expect(response.stopReason).toBe("end_turn")
    expect(sessionUpdates).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        update: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: expect.objectContaining({
            text: "done",
          }),
        }),
      }),
    ])
  })

  it("applies ACPServer mode overrides to the adapter session state", async () => {
    const rest = new FakeRestApi({
      createChat: async () => ({ id: "room-1" }),
      createChatEvent: async () => ({ ok: true }),
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      thenvoiRest: rest,
      sessionModes: [{
        id: "default",
        name: "Default",
        description: "Adapter default",
      }],
    })
    await adapter.onStarted("Band Agent", "ACP server")

    const server = new ACPServer(adapter, {
      modes: [{
        id: "review",
        name: "Review",
        description: "Server override",
      }],
    })

    const session = await server.newSession({
      cwd: "/workspace",
      mcpServers: [],
    } as never)

    expect(session.modes).toEqual({
      availableModes: [{
        id: "review",
        name: "Review",
        description: "Server override",
      }],
      currentModeId: "review",
    })
  })
});

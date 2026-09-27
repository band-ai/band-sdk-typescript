import { describe, expect, it, vi } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import {
  ACPServer,
  BandACPServerAdapter,
} from "../src/adapters/acp";
import { ClientSideConnection, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";
import { FAILURE_EVENT_TYPE, FAILURE_METADATA_KEY } from "../src/contracts/protocols";
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
        { id: "agent-1", name: "Band Agent", type: "Agent", handle: "band" },
        { id: "peer-1", name: "Codex", type: "Agent", handle: "codex" },
      ],
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      bandRest: rest,
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

  it("sends failure data and cancellation outcomes through the real ACP transport", async () => {
    const sentMessages: Array<Record<string, unknown>> = []
    const adapter = new BandACPServerAdapter({
      bandRest: new FakeRestApi({
        createChat: async () => ({ id: "room-1" }),
        createChatMessage: async (_roomId, message) => {
          sentMessages.push(message as Record<string, unknown>)
          return { ok: true }
        },
        listChatParticipants: async () => [
          { id: "peer-1", name: "Peer", type: "Agent", handle: "peer" },
        ],
      }, { id: "agent-1", name: "Band Agent", description: null }),
      promptCompletionGraceMs: 10,
      responseTimeoutMs: 500,
    })
    await adapter.onStarted("Band Agent", "ACP server")
    const server = new ACPServer(adapter)
    const toAgent = new TransformStream<Uint8Array, Uint8Array>()
    const toClient = new TransformStream<Uint8Array, Uint8Array>()
    await server.connectStream(ndJsonStream(toClient.writable, toAgent.readable))
    const updates: Array<Record<string, unknown>> = []
    const client = new ClientSideConnection(() => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async (params) => { updates.push(params as Record<string, unknown>) },
    }), ndJsonStream(toAgent.writable, toClient.readable))
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: "/workspace", mcpServers: [] })
    const request = (text: string) => client.prompt({ sessionId, prompt: [{ type: "text", text }] })
    const emit = (message: ReturnType<typeof makeMessage>) => adapter.onMessage(
      message,
      new FakeTools(),
      { sessionToRoom: {}, sessionCwd: {}, sessionMcpServers: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    )

    const first = request("fail")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1))
    await expect(request("overlapping")).rejects.toMatchObject({ code: -32602 })
    expect(sentMessages).toHaveLength(1)
    const failure = new AgentFailure("peer", "failed", "E_FAIL", {
      reason: "offline", trace: "Bearer sk-private", API_KEY: "sk-private",
    })
    const projection = new AgentFailure("peer", "failed", "E_FAIL", {
      reason: "offline", trace: "Bearer [REDACTED]", API_KEY: "[REDACTED]",
    }).toExtensionData()
    await emit({ ...makeMessage("failed", "room-1", { [FAILURE_METADATA_KEY]: failure.toObject() }), messageType: FAILURE_EVENT_TYPE })
    const promptError: unknown = await first.then(() => null, (error: unknown) => error)
    expect(promptError).toBeInstanceOf(RequestError)
    if (!(promptError instanceof RequestError)) throw new Error("Expected ACP request error")
    expect(promptError.code).toBe(-32603)
    expect(promptError.data).toEqual(projection)
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[Error] failed" },
        _meta: projection,
      },
    })

    await emit({ ...makeMessage("unsolicited", "room-1", { [FAILURE_METADATA_KEY]: failure.toObject() }), messageType: FAILURE_EVENT_TYPE })
    await vi.waitFor(() => expect(updates).toHaveLength(2))
    expect(updates[1]).toEqual({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[Error] unsolicited" },
        _meta: projection,
      },
    })
    expect(updates[1]).not.toHaveProperty("_meta")

    await emit({ ...makeMessage("token=hidden", "room-1", { [FAILURE_METADATA_KEY]: { provider: "", message: "bad" } }), messageType: FAILURE_EVENT_TYPE })
    await vi.waitFor(() => expect(updates).toHaveLength(3))
    expect(updates[2]).toMatchObject({
      update: {
        content: { text: "[Error] token=[REDACTED]" },
        _meta: new AgentFailure("band", "token=[REDACTED]").toExtensionData(),
      },
    })

    const cancelled = request("cancel")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(2))
    await client.cancel({ sessionId })
    await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" })

    const closed = request("close")
    await vi.waitFor(() => expect(sentMessages).toHaveLength(3))
    await adapter.onCleanup("room-1")
    await expect(closed).rejects.toMatchObject({
      code: -32603,
      data: new AgentFailure("band", "Band room closed before prompt completed.").toExtensionData(),
    })
  })

  it("applies ACPServer mode overrides to the adapter session state", async () => {
    const rest = new FakeRestApi({
      createChat: async () => ({ id: "room-1" }),
      createChatEvent: async () => ({ ok: true }),
    }, { id: "agent-1", name: "Band Agent", description: null })

    const adapter = new BandACPServerAdapter({
      bandRest: rest,
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

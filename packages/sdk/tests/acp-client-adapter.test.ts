import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { BandACPClient } from "../src/adapters/acp/client";
import { FakeTools, expectTurnFailed, findFailureEvent, makeMessage } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";

function makeLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function requireAcpClient(client: BandACPClient | null): BandACPClient {
  if (!client) {
    throw new Error("ACP connection factory did not receive a client")
  }
  return client
}

async function send(adapter: ACPClientAdapter, roomId = "room-1", history: Record<string, string> = {}): Promise<void> {
  await adapter.onStarted("Agent", "desc")
  await adapter.onMessage(
    makeMessage("hi", roomId),
    new FakeTools(),
    { roomToSession: history },
    null,
    null,
    { isSessionBootstrap: true, roomId },
  )
}

// Shared by the `resolveSessionMode` and `resolveSessionModel` test
// harnesses below: the connection-mock shape every ACP session actually
// exposes (signal/closed/initialize/authenticate/loadSession/
// resumeSession/newSession/prompt), parameterized by whichever
// extra RPC spies (setSessionMode, setSessionConfigOption) the calling
// block needs.
function buildMockConnection(spies: {
  agentCapabilities?: Record<string, unknown>;
  loadSession: () => Promise<Record<string, unknown>>;
  newSession: () => Promise<Record<string, unknown>>;
  prompt: (params: { sessionId: string }) => Promise<{ stopReason: string }>;
  extraRpcSpies?: Record<string, unknown>;
}) {
  const controller = new AbortController()
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: spies.agentCapabilities ?? { loadSession: true },
      })),
      authenticate: vi.fn(async () => ({})),
      loadSession: spies.loadSession,
      resumeSession: vi.fn(),
      newSession: spies.newSession,
      prompt: spies.prompt,
      ...spies.extraRpcSpies,
    } as never,
    stop: async () => {
      controller.abort()
    },
  }
}

describe("ACPClientAdapter", () => {
  it("restores ACP sessions, auto-injects MCP, and fans out ACP updates", async () => {
    let clientHandle: {
      sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
      requestPermission: (params: Record<string, unknown>) => Promise<unknown>;
    } | null = null

    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
        },
      },
    }))
    const authenticate = vi.fn(async () => ({}))
    const loadSession = vi.fn(async () => ({}))
    const newSession = vi.fn(async () => ({
      sessionId: "session-new",
    }))
    const promptTexts: string[] = []
    const prompt = vi.fn(async (params: { sessionId: string; prompt: Array<{ text?: string }> }) => {
      promptTexts.push(params.prompt[0]?.text ?? "")

      const permission = await clientHandle?.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-2",
          title: "Edit config",
        },
        options: [{
          kind: "allow_once",
          name: "Allow once",
          optionId: "allow",
        }],
      })

      expect(permission).toEqual({
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      })

      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: "thinking",
          },
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Lookup weather",
          kind: "fetch",
          status: "in_progress",
          rawInput: { city: "Vancouver" },
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: "sunny",
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{
            content: "Check the weather",
            priority: "medium",
            status: "in_progress",
          }],
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "hello back",
          },
        },
      })

      return {
        stopReason: "end_turn",
      }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      authMethod: "api_key",
      connectionFactory: async (client) => {
        clientHandle = client as typeof clientHandle
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize,
            authenticate,
            loadSession,
            resumeSession: vi.fn(),
            newSession,
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Parity Agent", "ACP parity test")

    const restoredTools = new FakeTools()
    await adapter.onMessage(
      makeMessage("continue existing", "room-restored"),
      restoredTools,
      {
        roomToSession: {
          "room-restored": "session-restored",
        },
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-restored" },
    )

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(authenticate).toHaveBeenCalledWith({ methodId: "api_key" })
    expect(loadSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-restored",
      cwd: process.cwd(),
      mcpServers: expect.arrayContaining([
        expect.objectContaining({
          type: "http",
          name: "band",
          headers: [
            expect.objectContaining({
              name: "Authorization",
              value: expect.stringMatching(/^Bearer [0-9a-f]{64}$/),
            }),
          ],
        }),
      ]),
    }))
    expect(newSession).not.toHaveBeenCalled()
    expect(promptTexts[0]).not.toContain("[System Context]")
    expect(restoredTools.messages).toEqual(["hello back"])
    expect(restoredTools.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageType: "tool_call", content: "Permission requested: Edit config" }),
      expect.objectContaining({ messageType: "thought", content: "thinking" }),
      expect.objectContaining({ messageType: "tool_call", content: "Lookup weather" }),
      expect.objectContaining({ messageType: "tool_result", content: "sunny" }),
      expect.objectContaining({ messageType: "task", content: "Check the weather" }),
      expect.objectContaining({
        messageType: "task",
        metadata: expect.objectContaining({
          acp_client_session_id: "session-restored",
          acp_client_room_id: "room-restored",
        }),
      }),
    ]))

    const newRoomTools = new FakeTools()
    await adapter.onMessage(
      makeMessage("start fresh", "room-new"),
      newRoomTools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-new" },
    )
    await adapter.onMessage(
      makeMessage("follow up", "room-new"),
      newRoomTools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-new" },
    )

    expect(newSession).toHaveBeenCalledTimes(1)
    expect(promptTexts[1]).toContain("[System Context]")
    expect(promptTexts[2]).not.toContain("[System Context]")
  })

  it("coalesces adjacent streamed text chunks; leaves each tool_call_update frame its own event with its own reported status", async () => {
    let clientHandle: BandACPClient | null = null

    const prompt = vi.fn(async (params: { sessionId: string }) => {
      // Two text deltas in a row — the shape a streaming agent actually sends
      // for one reply, one delta per token or phrase.
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } },
      })

      // A tool call reporting two frames sharing one tool_call_id: a failed
      // terminal frame, then a later frame that omits `status` entirely (a
      // legal ACP partial patch). `tool_result` isn't a streamed chunk type,
      // so each frame always pushes its own entry — the second's status can
      // never end up attached to the first's, unlike two adjacent text/
      // thought deltas.
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "failed",
          rawOutput: "boom",
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          rawOutput: "cleanup finished",
        },
      })

      // Text resumes after the tool call — a separate run, not merged with
      // the one before the tool_call_update boundary.
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All" } },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " done" } },
      })

      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async (client) => {
        clientHandle = client as BandACPClient
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({ sessionId: "session-coalesce" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Coalescing Agent", "ACP chunk coalescing test")

    const tools = new FakeTools()
    await adapter.onMessage(
      makeMessage("go", "room-coalesce"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-coalesce" },
    )

    // Four streamed text deltas collapse into two room messages; the two
    // tool_call_update frames stay two separate events, not eight room posts.
    expect(tools.messages).toEqual(["Hello world", "All done"])

    const toolResultEvents = tools.events.filter((event) => event.messageType === "tool_result")
    expect(toolResultEvents).toEqual([
      expect.objectContaining({
        content: "boom",
        metadata: expect.objectContaining({ tool_call_id: "call-1", status: "failed" }),
      }),
      expect.objectContaining({
        content: "cleanup finished",
        metadata: expect.objectContaining({ tool_call_id: "call-1", status: "completed" }),
      }),
    ])

    await adapter.onCleanup("room-coalesce")
    const client = requireAcpClient(clientHandle)
    await client.sessionUpdate({
      sessionId: "session-coalesce",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late output" } },
    })
    expect(client.getCollectedChunks("session-coalesce")).toEqual([])
  })

  it("coalesces a text run across an interleaved thought run, since a thought is not an action boundary", async () => {
    let clientHandle: {
      sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
    } | null = null

    const prompt = vi.fn(async (params: { sessionId: string }) => {
      // Claude/Codex both stream visible reasoning interleaved with the
      // reply itself: text → thought → thought → text. The thought run
      // merges on its own (already posted separately as a "thought" event),
      // and — this is the regression this test guards — it must not fragment
      // the text run around it: both text deltas belong to one reply and
      // must still post as a single room message.
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check that. " } },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " it over" } },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here's the answer." } },
      })
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async (client) => {
        clientHandle = client as unknown as typeof clientHandle
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({ sessionId: "session-thought" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Thought Agent", "ACP thought coalescing test")

    const tools = new FakeTools()
    await adapter.onMessage(
      makeMessage("go", "room-thought"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-thought" },
    )

    const thoughtEvents = tools.events.filter((event) => event.messageType === "thought")
    expect(thoughtEvents).toEqual([expect.objectContaining({ content: "Thinking it over" })])
    expect(tools.messages).toEqual(["Let me check that. Here's the answer."])
  })

  it("a non-streamed chunk closes every open streamed run, not just the one sharing its chunkType", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
    client.beginSession("session-x")

    // Both a text run and a thought run are open when the tool call lands —
    // it must close both, so the text/thought that follow start fresh runs
    // instead of silently gluing onto content from before the tool call.
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before" } },
    })
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking before" } },
    })
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "search", rawInput: {} },
    })
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After" } },
    })
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking after" } },
    })

    const chunks = client.getCollectedChunks("session-x")
    expect(chunks.map((chunk) => ({ chunkType: chunk.chunkType, content: chunk.content }))).toEqual([
      { chunkType: "text", content: "Before" },
      { chunkType: "thought", content: "Thinking before" },
      { chunkType: "tool_call", content: "search" },
      { chunkType: "text", content: "After" },
      { chunkType: "thought", content: "Thinking after" },
    ])
  })

  it("does not merge a streamed text chunk with an adjacent, unrelated cursor/task completion marker sharing the same chunkType", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
    client.beginSession("session-x")

    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Building your report" } },
    })
    // cursor/task delivers a one-shot completion marker as chunkType "text",
    // the same type a streamed reply uses — it must never be mistaken for
    // part of that stream just because the type string matches.
    await client.extNotification("cursor/task", { sessionId: "session-x", result: "done" })

    expect(client.getCollectedChunks("session-x").map((chunk) => chunk.content)).toEqual([
      "Building your report",
      "[Task completed] done",
    ])
  })

  it("does not merge a cursor/task completion marker with a streamed text chunk that follows it", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
    client.beginSession("session-x")

    // Same hazard as the marker-after-stream case above, in the opposite
    // order: the marker is non-streamed, so it must not become the seed a
    // later genuine delta merges into either.
    await client.extNotification("cursor/task", { sessionId: "session-x", result: "done" })
    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting the next step" } },
    })

    expect(client.getCollectedChunks("session-x").map((chunk) => chunk.content)).toEqual([
      "[Task completed] done",
      "Starting the next step",
    ])
  })

  it("cursor/update_todos posts a non-streamed plan chunk that does not merge into an adjacent streamed text run", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
    client.beginSession("session-x")

    await client.sessionUpdate({
      sessionId: "session-x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it" } },
    })
    await client.extNotification("cursor/update_todos", {
      sessionId: "session-x",
      todos: [
        { content: "Read the file", completed: true },
        { content: "Write the fix", completed: false },
      ],
    })

    const chunks = client.getCollectedChunks("session-x")
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual(["text", "plan"])
    expect(chunks[1].content).toBe("- [x] Read the file\n- [ ] Write the fix")
  })

  it("cursor/update_todos with no non-blank todo lines posts nothing", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))

    await client.extNotification("cursor/update_todos", { sessionId: "session-x", todos: [] })

    expect(client.getCollectedChunks("session-x")).toEqual([])
  })

  it("BandACPClient.getCollectedChunks() with no sessionId coalesces each session independently, not across sessions", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
    client.beginSession("session-a")
    client.beginSession("session-b")

    await client.sessionUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A1" } },
    })
    await client.sessionUpdate({
      sessionId: "session-a",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A2" } },
    })
    await client.sessionUpdate({
      sessionId: "session-b",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B1" } },
    })

    expect(client.getCollectedChunks().map((chunk) => chunk.content)).toEqual(["A1A2", "B1"])
  })

  it("completes the turn without posting a blank event, when a tool update carries no output", async () => {
    let clientHandle: {
      sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
      requestPermission: (params: Record<string, unknown>) => Promise<unknown>;
    } | null = null

    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        mcpCapabilities: { http: true },
      },
    }))
    const newSession = vi.fn(async () => ({ sessionId: "session-blank-update" }))
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      // A status-only update: no rawOutput and no content, the shape a tool
      // that reports completion without a result produces.
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
        },
      })
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      })
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async (client) => {
        clientHandle = client as typeof clientHandle
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize,
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Blank Update Agent", "ACP blank chunk test")

    const tools = new FakeTools()
    const sendEventSpy = vi.spyOn(tools, "sendEvent")

    await adapter.onMessage(
      makeMessage("run the tool", "room-blank-update"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-blank-update" },
    )

    // The blank status update must never even reach sendEvent — not just be
    // dropped once it gets there.
    expect(sendEventSpy.mock.calls.some(([content]) => content.trim().length === 0)).toBe(false)
    expect(tools.events.some((event) => event.messageType === "tool_result")).toBe(false)
    expect(tools.messages).toEqual(["done"])
    expect(tools.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageType: "task", content: "ACP client session" }),
    ]))
  })

  it("resolves a mention token to a handle before prompting the agent", async () => {
    const promptTexts: string[] = []
    const prompt = vi.fn(async (params: { sessionId: string; prompt: Array<{ text?: string }> }) => {
      promptTexts.push(params.prompt[0]?.text ?? "")
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true } },
            })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({ sessionId: "session-mentions" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Mention Agent", "ACP mention test")

    const REVIEWER_ID = "65044b09-fd04-4a34-a94f-51fe413bd2cb"
    await adapter.onMessage(
      makeMessage(`@[[${REVIEWER_ID}]] are you there?`, "room-mentions", {
        mentions: [{ id: REVIEWER_ID, username: "reviewer-bot" }],
      }),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-mentions" },
    )

    expect(promptTexts[0]).toContain("@reviewer-bot are you there?")
    expect(promptTexts[0]).not.toContain("@[[")
  })

  it("carries a room-context update to the agent, on a warm turn as well as a bootstrap one", async () => {
    const promptTexts: string[] = []
    const prompt = vi.fn(async (params: { sessionId: string; prompt: Array<{ text?: string }> }) => {
      promptTexts.push(params.prompt[0]?.text ?? "")
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true } },
            })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({ sessionId: "session-room-context" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Room Context Agent", "ACP room context test")

    await adapter.onMessage(
      makeMessage("hello", "room-context"),
      new FakeTools(),
      { roomToSession: {} },
      "Alice joined the room.",
      null,
      { isSessionBootstrap: true, roomId: "room-context" },
    )
    await adapter.onMessage(
      makeMessage("still here?", "room-context"),
      new FakeTools(),
      { roomToSession: {} },
      "Bob joined the room.",
      null,
      { isSessionBootstrap: false, roomId: "room-context" },
    )

    expect(promptTexts[0]).toContain("[System]: Alice joined the room.")
    expect(promptTexts[1]).toContain("[System]: Bob joined the room.")
  })

  it("fails loudly instead of guessing when the agent advertises no MCP transport", async () => {
    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        mcpCapabilities: {},
      },
    }))
    const newSession = vi.fn(async () => ({
      sessionId: "session-untransported",
    }))

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize,
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt: vi.fn(),
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("No Transport Agent", "ACP fallback test")

    await expect(adapter.onMessage(
      makeMessage("hello", "room-untransported"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-untransported" },
    )).rejects.toThrow(/does not advertise MCP transport support/)

    expect(newSession).not.toHaveBeenCalled()
  })

  it("creates the MCP backend at most once when two rooms bootstrap concurrently", async () => {
    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        mcpCapabilities: { http: true },
      },
    }))
    let sessionCounter = 0
    const newSessionCalls: Array<{ mcpServers: Array<{ url: string; headers: Array<{ value: string }> }> }> = []
    const newSession = vi.fn(async (params: typeof newSessionCalls[number]) => {
      newSessionCalls.push(params)
      return { sessionId: `session-concurrent-${sessionCounter++}` }
    })
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" }))

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize,
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt,
          } as never,
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("Concurrent Agent", "ACP concurrency test")

    await Promise.all([
      adapter.onMessage(
        makeMessage("hello from room A", "room-concurrent-a"),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-concurrent-a" },
      ),
      adapter.onMessage(
        makeMessage("hello from room B", "room-concurrent-b"),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-concurrent-b" },
      ),
    ])

    expect(newSession).toHaveBeenCalledTimes(2)
    const [firstServer, secondServer] = newSessionCalls.map(({ mcpServers }) => mcpServers[0])

    // Both rooms must have been handed the same backend URL and bearer token —
    // a second, independently-created backend would mean the loopback-port race
    // in getOrCreateBackend() regressed.
    expect(firstServer?.url).toEqual(secondServer?.url)
    expect(firstServer?.headers[0]?.value).toEqual(secondServer?.headers[0]?.value)
  })

  it("does not let a stale, failed session establishment evict a newer one still in flight for the same room", async () => {
    // Regression guard: `getOrCreateSession`'s in-flight guard used to clear
    // whatever promise was stored for a room, not specifically the one that
    // just settled. A room torn down (`onCleanup`) while its establishment
    // was still pending, then re-entered before that stale promise resolves,
    // could have the stale settle's `finally` evict the *newer* promise from
    // the map — reopening the exact duplicate-establishment race the guard
    // exists to close.
    let firstStarted: () => void = () => undefined
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
    let rejectFirst: (error: Error) => void = () => undefined
    const firstGate = new Promise<{ sessionId: string }>((_resolve, reject) => { rejectFirst = reject })

    let secondStarted: () => void = () => undefined
    const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve })
    let resolveSecond: (value: { sessionId: string }) => void = () => undefined
    const secondGate = new Promise<{ sessionId: string }>((resolve) => { resolveSecond = resolve })

    const newSession = vi.fn()
      .mockImplementationOnce(async () => { firstStarted(); return firstGate })
      .mockImplementationOnce(async () => { secondStarted(); return secondGate })
      .mockImplementation(async () => ({ sessionId: "session-should-not-happen" }))

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
          } as never,
          stop: async () => controller.abort(),
        }
      },
    })

    await adapter.onStarted("Agent", "desc")
    const turn = (): Promise<void> => adapter.onMessage(
      makeMessage("hi", "room-1"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    )

    const turn1 = turn()
    await firstStartedPromise
    // Tears down the room while turn1's establishment is still pending —
    // this is what clears the in-flight guard's entry for "room-1" without
    // touching turn1's own promise.
    await adapter.onCleanup("room-1")

    const turn2 = turn()
    await secondStartedPromise // turn2's establishment is now the one stored in the guard.

    rejectFirst(new Error("agent process died mid-establishment"))
    await expect(turn1).rejects.toThrow("agent process died mid-establishment")

    // While turn2 is still pending, a third turn must reuse it rather than
    // starting its own — the failure above must not have evicted it.
    const turn3 = turn()

    resolveSecond({ sessionId: "session-second" })
    await turn2
    await turn3

    expect(newSession).toHaveBeenCalledTimes(2)
  })

  it("never lets two concurrent turns for one room interleave their chunk collection (ACR-001)", async () => {
    // Regression guard: before per-room turn serialization, `onMessage` ran
    // `resetChunks → prompt → flushChunks` with no lock at all. A second
    // turn for the same room, entering while the first was still mid-prompt,
    // could `resetChunks` the shared session buffer out from under the first
    // turn's still-in-progress collection — losing its output entirely (or,
    // as here, replaying the second turn's own output a second time).
    let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null
    let releaseFirstPrompt: () => void = () => undefined
    const firstPromptGate = new Promise<void>((resolve) => { releaseFirstPrompt = resolve })
    let firstPromptStarted: () => void = () => undefined
    const firstPromptStartedPromise = new Promise<void>((resolve) => { firstPromptStarted = resolve })
    let promptCount = 0

    const prompt = vi.fn(async (params: { sessionId: string }) => {
      const isFirst = promptCount === 0
      promptCount += 1
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: isFirst ? "first-response" : "second-response" },
        },
      })
      if (isFirst) {
        firstPromptStarted()
        await firstPromptGate
      }
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async (client) => {
        clientHandle = client as unknown as typeof clientHandle
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({ sessionId: "session-1" })),
            prompt,
          } as never,
          stop: async () => controller.abort(),
        }
      },
    })

    await adapter.onStarted("Agent", "desc")
    const tools = new FakeTools()

    const turn1 = adapter.onMessage(
      makeMessage("first message", "room-1"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    )
    await firstPromptStartedPromise

    const turn2 = adapter.onMessage(
      makeMessage("second message", "room-1"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    )
    // Gives a regressed (unlocked) turn2 room to race ahead of turn1 before
    // it's released, without depending on any real clock.
    await new Promise((resolve) => setImmediate(resolve))
    releaseFirstPrompt()

    await turn1
    await turn2

    expect(tools.messages).toEqual(["first-response", "second-response"])
  })

  it("fails a session establishment instead of hanging forever, when the connection closes mid-establishment (ACR-002a)", async () => {
    // The installed ACP SDK's `sendRequest` never rejects a pending call when
    // its connection closes, so `newSession` here is built to hang forever —
    // exactly what a real dead subprocess looks like. Without racing it
    // against `connection.closed`, this turn would never settle at all.
    let markClosed: () => void = () => undefined
    const closed = new Promise<void>((resolve) => { markClosed = resolve })
    const newSession = vi.fn(() => new Promise<never>(() => undefined))

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async () => ({
        connection: {
          signal: new AbortController().signal,
          closed,
          initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
          authenticate: vi.fn(async () => ({})),
          loadSession: vi.fn(),
          resumeSession: vi.fn(),
          newSession,
          prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
        } as never,
        stop: async () => undefined,
      }),
    })

    await adapter.onStarted("Agent", "desc")
    const onMessage = adapter.onMessage(
      makeMessage("hi", "room-1"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    )

    markClosed()
    await expect(onMessage).rejects.toThrow("ACP connection closed while a session operation was still in flight")
  })

  it("refuses to let a superseded establishment re-link a room that has already moved on to a fresher session (ACR-002b)", async () => {
    let resolveFirst: (value: { sessionId: string }) => void = () => undefined
    const firstGate = new Promise<{ sessionId: string }>((resolve) => { resolveFirst = resolve })
    let firstStarted: () => void = () => undefined
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })

    const newSession = vi.fn()
      .mockImplementationOnce(async () => { firstStarted(); return firstGate })
      .mockImplementationOnce(async () => ({ sessionId: "session-fresh" }))
      .mockImplementation(async () => ({ sessionId: "session-should-not-happen" }))

    const promptedSessionIds: string[] = []
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      promptedSessionIds.push(params.sessionId)
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt,
          } as never,
          stop: async () => controller.abort(),
        }
      },
    })

    await adapter.onStarted("Agent", "desc")
    const turn = (): Promise<void> => adapter.onMessage(
      makeMessage("hi", "room-1"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    )

    const turn1 = turn()
    await firstStartedPromise
    // The room moves on (torn down and re-entered) before turn1's
    // establishment ever resolves — this bumps the room's generation, so
    // turn1 no longer belongs to it.
    await adapter.onCleanup("room-1")

    const turn2 = turn()
    await turn2

    // turn1's establishment finally resolves, long after the room moved on —
    // it must be rejected, not silently re-link the room onto its session.
    resolveFirst({ sessionId: "session-stale" })
    await expect(turn1).rejects.toThrow(/superseded/)

    // A third turn must still find the room routed to the fresh session from
    // turn2, not to turn1's stale one and not establishing yet another.
    await turn()

    expect(newSession).toHaveBeenCalledTimes(2)
    expect(promptedSessionIds).toEqual(["session-fresh", "session-fresh"])
  })

  it("throws instead of activating a session for a room whose new session id already belongs to another room (ACR-003)", async () => {
    const newSession = vi.fn(async () => ({ sessionId: "session-shared" }))
    const promptedSessionIds: string[] = []
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      promptedSessionIds.push(params.sessionId)
      return { stopReason: "end_turn" }
    })

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession,
            prompt,
          } as never,
          stop: async () => controller.abort(),
        }
      },
    })

    await adapter.onStarted("Agent", "desc")

    await adapter.onMessage(
      makeMessage("hi from room A", "room-a"),
      new FakeTools(),
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-a" },
    )

    await expect(
      adapter.onMessage(
        makeMessage("hi from room B", "room-b"),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-b" },
      ),
    ).rejects.toThrow(/already routed elsewhere/)

    // Room B's establishment threw before ever prompting — room A's session
    // was never used on room B's behalf.
    expect(promptedSessionIds).toEqual(["session-shared"])
  })

  it("selects only a mode advertised by the connected ACP harness", async () => {
    const setSessionMode = vi.fn(async () => ({}))
    const resolveSessionMode = vi.fn(async () => "plan")
    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      enableMcpTools: false,
      resolveSessionMode,
      connectionFactory: async () => {
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            resumeSession: vi.fn(),
            newSession: vi.fn(async () => ({
              sessionId: "session-modes",
              modes: {
                currentModeId: "ask",
                availableModes: [
                  { id: "ask", name: "Ask" },
                  { id: "plan", name: "Plan", description: "Plan before editing" },
                ],
              },
            })),
            setSessionMode,
            prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
          } as never,
          stop: async () => controller.abort(),
        }
      },
    })

    await adapter.onStarted("Agent", "desc")
    await adapter.onMessage(makeMessage("hi", "room-modes"), new FakeTools(), { roomToSession: {} }, null, null, {
      isSessionBootstrap: true,
      roomId: "room-modes",
    })

    expect(resolveSessionMode).toHaveBeenCalledWith({
      roomId: "room-modes",
      sessionId: "session-modes",
      currentModeId: "ask",
      modes: [
        { id: "ask", name: "Ask" },
        { id: "plan", name: "Plan", description: "Plan before editing" },
      ],
    }, expect.any(AbortSignal))
    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: "session-modes", modeId: "plan" })
  })

  describe("resolvePermission (manual approval)", () => {
    // One allow-kind and one reject-kind option — the shape every case below
    // needs to distinguish "denied" from "cancelled" and to pick a specific id.
    const ASK_OPTIONS = [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Deny", optionId: "deny" },
    ]

    const CANCELLED = { outcome: { outcome: "cancelled" } }
    const UNROUTABLE_WARNING = "cancelling a permission request that maps to no live room"

    type Ask = (sessionId: string, toolCallId?: string) => Promise<unknown>
    type Modes = { currentModeId: string; availableModes: Array<{ id: string; name: string }> }

    function isPermissionEvent(event: { metadata?: Record<string, unknown> }): boolean {
      return event.metadata?.permission_request === true
    }

    // Lets a `closed.finally` handler (and any microtask chain behind it) run
    // before the next assertion, without advancing any clock.
    function flush(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve))
    }

    // Shared harness: a scriptable subprocess whose `prompt` drives a real
    // `session/request_permission` round trip, plus the knobs the routing and
    // abandonment cases need — every spawned connection kept (a reconnect
    // exposes both generations) and closable on demand, a queue of session
    // ids, and a restore that can be made to fail.
    function buildHarness(input: {
      adapterOptions?: Partial<ACPClientAdapterOptions>;
      sessionIds?: string[];
      canRestore?: boolean;
      restoreFails?: boolean;
      modes?: Modes;
      onPrompt?: (turn: { sessionId: string; ask: Ask }) => Promise<void>;
    } = {}) {
      const sessionIds = [...(input.sessionIds ?? ["session-1"])]
      const connections: Array<{ ask: Ask; close: () => void }> = []
      let permissionResult: unknown

      const setSessionMode = vi.fn(async () => ({}))
      const newSession = vi.fn(async () => ({
        sessionId: sessionIds.shift() ?? "session-exhausted",
        ...(input.modes ? { modes: input.modes } : {}),
      }))
      const loadSession = vi.fn(async () => {
        if (input.restoreFails) {
          throw new Error("the agent no longer holds that session")
        }
        return input.modes ? { modes: input.modes } : {}
      })

      const onPrompt = input.onPrompt ?? (async ({ sessionId, ask }) => {
        permissionResult = await ask(sessionId)
      })
      const prompt = vi.fn(async (params: { sessionId: string }) => {
        await onPrompt({ sessionId: params.sessionId, ask: connections[connections.length - 1].ask })
        return { stopReason: "end_turn" }
      })

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        // No real MCP backend needed for any permission scenario below —
        // disabling it keeps every case from spinning up a real HTTP server
        // (and its own housekeeping timers, which would otherwise pollute
        // `vi.getTimerCount()` assertions under fake timers).
        enableMcpTools: false,
        connectionFactory: async (client) => {
          const controller = new AbortController()
          let markClosed: () => void = () => undefined
          const closed = new Promise<void>((resolve) => { markClosed = resolve })
          const close = (): void => {
            controller.abort()
            markClosed()
          }

          connections.push({
            close,
            ask: (sessionId, toolCallId = "call-1") => (client as unknown as {
              requestPermission: (params: Record<string, unknown>) => Promise<unknown>;
            }).requestPermission({
              sessionId,
              toolCall: { toolCallId, title: "Edit file" },
              options: ASK_OPTIONS,
            }),
          })

          return {
            connection: {
              signal: controller.signal,
              closed,
              initialize: vi.fn(async () => ({
                protocolVersion: 1,
                agentCapabilities: input.canRestore ? { loadSession: true } : {},
              })),
              authenticate: vi.fn(async () => ({})),
              loadSession,
              resumeSession: vi.fn(),
              newSession,
              setSessionMode,
              prompt,
            } as never,
            stop: async () => {
              close()
            },
          }
        },
        ...input.adapterOptions,
      })

      return {
        adapter,
        connections,
        newSession,
        loadSession,
        setSessionMode,
        getPermissionResult: () => permissionResult,
        // Injects a request over the newest connection, the way a live agent
        // can at any moment — not only from inside a `prompt` call.
        ask: (sessionId: string, toolCallId?: string) =>
          connections[connections.length - 1].ask(sessionId, toolCallId),
      }
    }

    async function send(
      adapter: ACPClientAdapter,
      tools: FakeTools,
      roomId = "room-1",
      history: Record<string, string> = {},
    ): Promise<void> {
      await adapter.onStarted("Agent", "desc")
      await adapter.onMessage(
        makeMessage("hi", roomId),
        tools,
        { roomToSession: history },
        null,
        null,
        { isSessionBootstrap: true, roomId },
      )
    }

    it("(a) no resolvePermission ⇒ unchanged auto-allow", async () => {
      const { adapter, getPermissionResult } = buildHarness()
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
    })

    it("(b) resolvePermission resolving an allow-kind id is used", async () => {
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: { resolvePermission: async () => "allow" },
      })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
    })

    it("(c) resolvePermission that never resolves falls back to cancelled after permissionTimeoutMs", async () => {
      vi.useFakeTimers()
      try {
        // `resolveManually` registers its `setTimeout` synchronously, before
        // it ever invokes `resolvePermission` (which is deferred a
        // microtask via `Promise.resolve().then(...)`) — so waiting for
        // this signal guarantees the timer already exists before advancing
        // the fake clock. Without it, the timer can still be mid-registration
        // (several `await`s deep in `onStarted`/`onMessage`) when the clock
        // jumps, and gets scheduled to fire *after* the jump — hanging.
        let permissionRequested: () => void = () => undefined
        const requested = new Promise<void>((resolve) => { permissionRequested = resolve })
        const signals: AbortSignal[] = []

        const { adapter, getPermissionResult } = buildHarness({
          adapterOptions: {
            resolvePermission: async (_request, signal) => {
              signals.push(signal)
              permissionRequested()
              return new Promise<string | undefined>(() => undefined)
            },
            permissionTimeoutMs: 1_000,
          },
        })
        const onMessage = send(adapter, new FakeTools())
        await requested
        await vi.advanceTimersByTimeAsync(1_000)
        await onMessage
        expect(getPermissionResult()).toEqual(CANCELLED)
        expect(signals[0]?.reason).toBe("timeout")
      } finally {
        vi.useRealTimers()
      }
    })

    it("(d) resolvePermission rejecting falls back to cancelled and is logged, not thrown", async () => {
      const logger = makeLoggerSpy()
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: async () => {
            throw new Error("host UI call failed")
          },
          logger,
        },
      })
      await expect(send(adapter, new FakeTools())).resolves.toBeUndefined()
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
      expect(logger.warn).toHaveBeenCalledWith(
        "resolvePermission threw; treating as no answer",
        expect.objectContaining({ error: expect.stringContaining("host UI call failed") }),
      )
    })

    it("(e) resolving before the timeout clears the pending timer", async () => {
      vi.useFakeTimers()
      try {
        const { adapter } = buildHarness({
          adapterOptions: {
            resolvePermission: async () => "allow",
            permissionTimeoutMs: 5_000,
          },
        })
        await send(adapter, new FakeTools())
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it("(f) resolvePermission resolving a reject-kind id is a real deny, not cancelled", async () => {
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: { resolvePermission: async () => "deny" },
      })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: "deny" } })
    })

    it("(g) an id absent from this request's own options falls back to cancelled, and warns", async () => {
      const logger = makeLoggerSpy()
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: { resolvePermission: async () => "not-a-real-option", logger },
      })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual(CANCELLED)
      expect(logger.warn).toHaveBeenCalledWith(
        "resolvePermission chose an option this request does not offer",
        expect.objectContaining({ roomId: "room-1", chosenId: "not-a-real-option" }),
      )
    })

    it("(h) onCleanup(roomId) while a request for that room is pending resolves it cancelled immediately", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })
      const signals: AbortSignal[] = []

      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: async (_request, signal) => {
            signals.push(signal)
            permissionRequested()
            return new Promise<string | undefined>(() => undefined) // hangs until cleanup cancels it
          },
          permissionTimeoutMs: 60_000,
        },
      })

      const onMessage = send(adapter, new FakeTools())
      await requested
      await adapter.onCleanup("room-1")
      await onMessage

      expect(getPermissionResult()).toEqual(CANCELLED)
      expect(signals[0]?.reason).toBe("room-closed")
    })

    it("(h) stop() with a pending request in any room resolves it cancelled immediately", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })
      const signals: AbortSignal[] = []

      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: async (_request, signal) => {
            signals.push(signal)
            permissionRequested()
            return new Promise<string | undefined>(() => undefined)
          },
          permissionTimeoutMs: 60_000,
        },
      })

      const onMessage = send(adapter, new FakeTools())
      await requested
      await adapter.stop()
      await onMessage

      expect(getPermissionResult()).toEqual(CANCELLED)
      expect(signals[0]?.reason).toBe("adapter-stopped")
    })

    it("(i) resolvePermission resolving promptly to undefined (a dismissed popup) ⇒ cancelled, as no-answer not settled (ACR-005)", async () => {
      const signals: AbortSignal[] = []
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: async (_request, signal) => {
            signals.push(signal)
            return undefined
          },
        },
      })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual(CANCELLED)
      // This request ran its own course to a real (if unusable) outcome — it
      // was never externally torn down — so `settled` would misreport it as
      // "the consumer picked one of the offered options".
      expect(signals[0]?.reason).toBe("no-answer")
    })

    it("(x) a permission-requested event that fails to post forces cancellation, even when resolvePermission answers validly (ACR-005)", async () => {
      const logger = makeLoggerSpy()
      const signals: AbortSignal[] = []

      // Only the permission-requested event fails — everything else (the
      // final "ACP client session" event, any flushed chunks) must keep
      // working normally.
      class UnpostableRequestTools extends FakeTools {
        public override async sendEvent(
          content: string,
          messageType: string,
          metadata?: Record<string, unknown>,
        ): Promise<Record<string, unknown>> {
          if (metadata?.permission_request === true) {
            throw new Error("platform rejected the event")
          }
          return super.sendEvent(content, messageType, metadata)
        }
      }

      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          logger,
          resolvePermission: async (_request, signal) => {
            signals.push(signal)
            return "allow" // a real, valid answer — must still lose to the failed event.
          },
        },
      })

      await send(adapter, new UnpostableRequestTools())

      expect(getPermissionResult()).toEqual(CANCELLED)
      expect(signals[0]?.reason).toBe("no-answer")
      expect(logger.warn).toHaveBeenCalledWith(
        "failed to post the permission-requested event; cancelling the request",
        expect.objectContaining({ roomId: "room-1" }),
      )
    })

    it("(j) the permission-requested event fires before a slow resolver settles, with auto_allowed:false", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })
      let releasePermission: (value: string | undefined) => void = () => undefined
      const pending = new Promise<string | undefined>((resolve) => { releasePermission = resolve })

      const { adapter } = buildHarness({
        adapterOptions: {
          resolvePermission: async () => {
            permissionRequested()
            return pending
          },
        },
      })

      const tools = new FakeTools()
      const onMessage = send(adapter, tools)
      await requested

      expect(tools.events).toContainEqual(
        expect.objectContaining({
          messageType: "tool_call",
          content: "Permission requested: Edit file",
          metadata: expect.objectContaining({ auto_allowed: false }),
        }),
      )

      releasePermission("allow")
      await onMessage
    })

    it.each([0, -1, NaN])("(k) constructing with an invalid permissionTimeoutMs (%s) throws", (invalid) => {
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        resolvePermission: async () => "allow",
        permissionTimeoutMs: invalid,
      })).toThrow(/permissionTimeoutMs must be a positive finite number/)
    })

    it("(l) resolvePermission throwing synchronously still falls back to cancelled, not an uncaught throw", async () => {
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: () => {
            throw new Error("sync boom")
          },
        },
      })
      await expect(send(adapter, new FakeTools())).resolves.toBeUndefined()
      expect(getPermissionResult()).toEqual(CANCELLED)
    })

    it("(m) onCleanup fired while the permission-requested event is still in flight still cancels promptly", async () => {
      // Regression guard for a real gap: the pending request used to be
      // tracked only once `resolveManually` itself ran, which is after
      // `tools.sendEvent(...)` resolves. A room torn down while that event
      // was still in flight found nothing to cancel and the request then
      // hung for the full timeout. `trackPending` now runs before
      // `sendEvent` is even called, so cancellation reaches it regardless
      // of when it lands relative to that call.
      let releaseSendEvent: () => void = () => undefined
      const sendEventGate = new Promise<void>((resolve) => { releaseSendEvent = resolve })
      let sendEventStarted: () => void = () => undefined
      const started = new Promise<void>((resolve) => { sendEventStarted = resolve })

      class DelayedTools extends FakeTools {
        public override async sendEvent(
          content: string,
          messageType: string,
          metadata?: Record<string, unknown>,
        ): Promise<Record<string, unknown>> {
          sendEventStarted()
          await sendEventGate
          return super.sendEvent(content, messageType, metadata)
        }
      }

      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          // Never actually invoked in this test — onCleanup below cancels the
          // request before resolveManually's race would ever call it — kept
          // async-and-hanging only so a regression (the old, buggy ordering)
          // fails by timing out rather than by a misleading assertion error.
          resolvePermission: async () => new Promise<string | undefined>(() => undefined),
          permissionTimeoutMs: 60_000,
        },
      })

      const onMessage = send(adapter, new DelayedTools())
      await started
      await adapter.onCleanup("room-1")
      releaseSendEvent()
      await onMessage

      expect(getPermissionResult()).toEqual(CANCELLED)
    })

    it("(n) an answered request reads as settled, not as abandoned", async () => {
      const signals: AbortSignal[] = []
      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          resolvePermission: async (_request, signal) => {
            signals.push(signal)
            return "allow"
          },
        },
      })

      await send(adapter, new FakeTools())

      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
      expect(signals[0]?.reason).toBe("settled")
    })

    it("(o) an answer arriving after the request was abandoned is discarded and warned about", async () => {
      const logger = makeLoggerSpy()
      let answer: (optionId: string) => void = () => undefined
      const answered = new Promise<string>((resolve) => { answer = resolve })
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })

      const { adapter, getPermissionResult } = buildHarness({
        adapterOptions: {
          logger,
          resolvePermission: async () => {
            permissionRequested()
            return answered
          },
          permissionTimeoutMs: 60_000,
        },
      })

      const onMessage = send(adapter, new FakeTools())
      await requested
      await adapter.onCleanup("room-1")
      answer("allow")
      await onMessage
      await flush()

      expect(getPermissionResult()).toEqual(CANCELLED)
      expect(logger.warn).toHaveBeenCalledWith(
        "resolvePermission answered after the request was abandoned; discarding",
        expect.objectContaining({ roomId: "room-1", chosenId: "allow", reason: "room-closed" }),
      )
    })

    const ASK_MODES: Modes = {
      currentModeId: "auto",
      availableModes: [{ id: "auto", name: "auto" }, { id: "ask", name: "ask" }],
    }

    it("(p) routes a request that arrives before the turn's prompt, on a restored session", async () => {
      // The exact window the per-turn handler registration used to leave
      // open: the session already exists in the agent and the mode RPC is
      // still in flight, so a real `session/request_permission` can land
      // here. Injecting from inside `resolveSessionMode` reproduces that
      // moment without reaching into adapter internals.
      let injected: unknown
      let ask: Ask = async () => undefined

      const harness = buildHarness({
        canRestore: true,
        modes: ASK_MODES,
        adapterOptions: {
          resolvePermission: async () => "allow",
          resolveSessionMode: async ({ sessionId }) => {
            injected = await ask(sessionId)
            return "ask"
          },
        },
        onPrompt: async () => undefined,
      })
      ask = harness.ask

      await send(harness.adapter, new FakeTools(), "room-1", { "room-1": "session-restored" })

      expect(injected).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
      expect(harness.setSessionMode).toHaveBeenCalledWith({ sessionId: "session-restored", modeId: "ask" })
    })

    it("(q) cancels and warns about a request for a session it has never seen", async () => {
      const logger = makeLoggerSpy()
      const resolvePermission = vi.fn(async () => "allow")
      const harness = buildHarness({ adapterOptions: { logger, resolvePermission } })

      await send(harness.adapter, new FakeTools())
      resolvePermission.mockClear()

      expect(await harness.ask("session-nobody-knows")).toEqual(CANCELLED)
      expect(resolvePermission).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        UNROUTABLE_WARNING,
        expect.objectContaining({ sessionId: "session-nobody-knows", sessionActive: false }),
      )
    })

    it("(r) refuses a request on a session whose connection dropped, without prompting anyone", async () => {
      const logger = makeLoggerSpy()
      const resolvePermission = vi.fn(async () => "allow")
      const harness = buildHarness({ adapterOptions: { logger, resolvePermission } })

      const tools = new FakeTools()
      await send(harness.adapter, tools)
      resolvePermission.mockClear()
      const eventsBefore = tools.events.length

      harness.connections[0].close()
      await flush()

      expect(await harness.ask("session-1")).toEqual(CANCELLED)
      expect(resolvePermission).not.toHaveBeenCalled()
      expect(tools.events).toHaveLength(eventsBefore)
      expect(logger.warn).toHaveBeenCalledWith(
        UNROUTABLE_WARNING,
        expect.objectContaining({ sessionId: "session-1", sessionActive: false }),
      )
    })

    it("(s) stops routing a room's previous session id once it has been replaced", async () => {
      const harness = buildHarness({
        sessionIds: ["session-1", "session-2"],
        adapterOptions: { resolvePermission: async () => "allow" },
      })

      const tools = new FakeTools()
      await send(harness.adapter, tools)
      harness.connections[0].close()
      await flush()
      await send(harness.adapter, tools)

      expect(harness.newSession).toHaveBeenCalledTimes(2)
      expect(await harness.ask("session-2")).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
      expect(await harness.ask("session-1")).toEqual(CANCELLED)
    })

    it("(t) gives each room its own tools and roomId, on one shared connection", async () => {
      const seen: Array<{ roomId: string; sessionId: string }> = []
      const harness = buildHarness({
        sessionIds: ["session-a", "session-b"],
        adapterOptions: {
          resolvePermission: async (request) => {
            seen.push({ roomId: request.roomId, sessionId: request.sessionId })
            return "allow"
          },
        },
      })

      const roomA = new FakeTools()
      const roomB = new FakeTools()
      await send(harness.adapter, roomA, "room-a")
      await send(harness.adapter, roomB, "room-b")

      expect(harness.connections).toHaveLength(1)
      expect(seen).toEqual([
        { roomId: "room-a", sessionId: "session-a" },
        { roomId: "room-b", sessionId: "session-b" },
      ])
      expect(roomA.events.filter(isPermissionEvent)).toHaveLength(1)
      expect(roomB.events.filter(isPermissionEvent)).toHaveLength(1)
    })

    it("(u) refuses to route one restored session id to a second room", async () => {
      const logger = makeLoggerSpy()
      const harness = buildHarness({
        canRestore: true,
        adapterOptions: { logger, resolvePermission: async () => "allow" },
      })

      const tools = new FakeTools()
      await send(harness.adapter, tools, "room-1", {
        "room-1": "shared-session",
        "room-2": "shared-session",
      })

      expect(logger.warn).toHaveBeenCalledWith(
        "refusing to route one ACP session to a second room",
        expect.objectContaining({ sessionId: "shared-session", roomId: "room-2", routedRoomId: "room-1" }),
      )
      // The room that got there first keeps the route; nothing is re-pointed.
      expect(await harness.ask("shared-session")).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
      expect(tools.events.filter(isPermissionEvent)).toHaveLength(2)
    })

    it("(v) establishes one session when a room's first two turns run concurrently", async () => {
      const harness = buildHarness({
        sessionIds: ["session-1", "session-2"],
        adapterOptions: { resolvePermission: async () => "allow" },
      })

      await harness.adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      const turn = (): Promise<void> => harness.adapter.onMessage(
        makeMessage("hi", "room-1"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      )
      await Promise.all([turn(), turn()])

      expect(harness.newSession).toHaveBeenCalledTimes(1)
      expect(await harness.ask("session-1")).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
    })

    it("(w) keeps two rooms answering their own permissions across approve, deny, a drop, and a reconnect", async () => {
      // Deliberately on real timers with a long permission timeout: nothing
      // here may depend on a clock advancing, so a request that stops being
      // answered promptly fails this test by exhausting the test timeout.
      const logger = makeLoggerSpy()
      const script = ["allow", "deny", "drop", "allow", "allow"]
      const resolvedRooms: string[] = []
      const outcomes: unknown[] = []
      const droppedSignals: AbortSignal[] = []
      let dropConnection: () => void = () => undefined
      let injectDuringModeSetup: (() => Promise<void>) | null = null
      let injectedOnLiveSession: unknown
      let injectedOnDeadSession: unknown

      const harness = buildHarness({
        sessionIds: ["session-a1", "session-b1", "session-a2"],
        canRestore: true,
        restoreFails: true,
        modes: ASK_MODES,
        adapterOptions: {
          logger,
          permissionTimeoutMs: 60_000,
          resolveSessionMode: async () => {
            const inject = injectDuringModeSetup
            injectDuringModeSetup = null
            await inject?.()
            return "ask"
          },
          resolvePermission: async (request, signal) => {
            resolvedRooms.push(request.roomId)
            const step = script.shift()
            if (step !== "drop") {
              return step
            }

            droppedSignals.push(signal)
            dropConnection()
            return new Promise<string | undefined>(() => undefined)
          },
        },
        onPrompt: async ({ sessionId, ask }) => {
          outcomes.push(await ask(sessionId))
        },
      })
      dropConnection = () => harness.connections[0].close()

      const roomA = new FakeTools()
      const roomB = new FakeTools()

      await send(harness.adapter, roomA, "room-a")
      await send(harness.adapter, roomB, "room-b")
      await send(harness.adapter, roomA, "room-a")
      await flush()

      injectDuringModeSetup = async () => {
        injectedOnLiveSession = await harness.ask("session-a2")
        injectedOnDeadSession = await harness.ask("session-a1")
      }
      await send(harness.adapter, roomA, "room-a")

      expect(outcomes).toEqual([
        { outcome: { outcome: "selected", optionId: "allow" } },
        { outcome: { outcome: "selected", optionId: "deny" } },
        CANCELLED,
        { outcome: { outcome: "selected", optionId: "allow" } },
      ])
      expect(droppedSignals[0]?.reason).toBe("connection-lost")

      // The reconnect: restore is refused by the agent, so a fresh session
      // replaces the dead one and is configured before its first prompt.
      expect(harness.loadSession).toHaveBeenCalledTimes(1)
      expect(harness.newSession).toHaveBeenCalledTimes(3)
      expect(harness.setSessionMode).toHaveBeenCalledWith({ sessionId: "session-a2", modeId: "ask" })
      expect(injectedOnLiveSession).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
      expect(injectedOnDeadSession).toEqual(CANCELLED)
      expect(logger.warn).toHaveBeenCalledWith(
        UNROUTABLE_WARNING,
        expect.objectContaining({ sessionId: "session-a1" }),
      )

      // Isolation: every request was attributed to the room that owns its
      // session, and room B never saw one of room A's.
      expect(resolvedRooms).toEqual(["room-a", "room-b", "room-a", "room-a", "room-a"])
      expect(roomA.events.filter(isPermissionEvent)).toHaveLength(4)
      expect(roomB.events.filter(isPermissionEvent)).toHaveLength(1)
    })
  })

  describe("resolveSessionMode", () => {
    // Shared harness: a connection whose newSession/loadSession return a
    // given `modes` state, a `setSessionMode` spy, and (opt-in) a `prompt`
    // that raises one real permission request — the same request/response
    // shape a live Claude/Codex session actually sends, so the "mode gets
    // set, then a real ask/allow round trip happens" test below exercises
    // the real flow this feature exists for, not just the RPC call in
    // isolation.
    function buildHarness(input: {
      adapterOptions?: Partial<ACPClientAdapterOptions>;
      agentCapabilities?: Record<string, unknown>;
      newSessionModes?: { currentModeId: string; availableModes?: Array<{ id: string; name: string }> };
      loadSessionModes?: { currentModeId: string; availableModes?: Array<{ id: string; name: string }> };
      raisePermissionRequest?: boolean;
    } = {}) {
      let clientHandle: { requestPermission: (params: Record<string, unknown>) => Promise<unknown> } | null = null
      let permissionResult: unknown

      const setSessionMode = vi.fn(async () => ({}))
      const newSession = vi.fn(async () => ({
        sessionId: "session-1",
        ...(input.newSessionModes ? { modes: input.newSessionModes } : {}),
      }))
      const loadSession = vi.fn(async () => ({
        ...(input.loadSessionModes ? { modes: input.loadSessionModes } : {}),
      }))
      const resumeSession = vi.fn()
      const prompt = vi.fn(async (params: { sessionId: string }) => {
        if (input.raisePermissionRequest) {
          permissionResult = await clientHandle?.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: "call-1", title: "Edit file" },
            options: [
              { kind: "allow_once", name: "Allow once", optionId: "allow" },
              { kind: "reject_once", name: "Deny", optionId: "deny" },
            ],
          })
        }
        return { stopReason: "end_turn" }
      })

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async (client) => {
          clientHandle = client as unknown as typeof clientHandle
          const controller = new AbortController()
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({
                protocolVersion: 1,
                agentCapabilities: input.agentCapabilities ?? { loadSession: true },
              })),
              authenticate: vi.fn(async () => ({})),
              loadSession,
              resumeSession,
              newSession,
              setSessionMode,
              prompt,
            } as never,
            stop: async () => {
              controller.abort()
            },
          }
        },
        ...input.adapterOptions,
      })

      return { adapter, setSessionMode, loadSession, newSession, getPermissionResult: () => permissionResult }
    }

    async function send(adapter: ACPClientAdapter, roomId = "room-1", history: Record<string, string> = {}): Promise<void> {
      await adapter.onStarted("Agent", "desc")
      await adapter.onMessage(
        makeMessage("hi", roomId),
        new FakeTools(),
        { roomToSession: history },
        null,
        null,
        { isSessionBootstrap: true, roomId },
      )
    }

    it.each(["allow", "deny"] as const)("switching into ask mode surfaces a real %s decision on the next tool call", async (pick) => {
      const { adapter, setSessionMode, getPermissionResult } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default", resolvePermission: async () => pick },
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
        raisePermissionRequest: true,
      })
      await send(adapter)
      expect(setSessionMode).toHaveBeenCalledWith({ sessionId: "session-1", modeId: "default" })
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: pick } })
    })

    it("does nothing when resolveSessionMode is unset, regardless of what the session advertises", async () => {
      const { adapter, setSessionMode } = buildHarness({
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
      })
      await send(adapter)
      expect(setSessionMode).not.toHaveBeenCalled()
    })

    it("does nothing, and never calls the resolver, when the backend advertises no modes at all", async () => {
      const logger = makeLoggerSpy()
      const resolveSessionMode = vi.fn(async () => "default")
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode, logger },
      })
      await send(adapter)
      expect(resolveSessionMode).not.toHaveBeenCalled()
      expect(setSessionMode).not.toHaveBeenCalled()
      // Not advertising modes at all is expected and silent; advertising
      // modes but missing the resolved one (below) is not.
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it("warns, but does not throw, when the resolved mode id isn't advertised", async () => {
      const logger = makeLoggerSpy()
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default", logger },
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }] },
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionMode).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        "resolveSessionMode selected a mode id this session does not advertise",
        expect.objectContaining({ selectedModeId: "default" }),
      )
    })

    it("does not surface an unhandled rejection when the logger's own warn() is async and rejects", async () => {
      // `Logger.warn` is typed to return `void`, but TS's void-return
      // bivariance lets an `async` implementation satisfy it — safeWarn's
      // try/catch alone would only catch a synchronous throw, not this.
      // Deliberately a plain function, not `vi.fn()`: vitest's mock wrapper
      // attaches its own handler to track `mock.results`, which incidentally
      // marks the rejection "handled" and would hide a regression here.
      const unhandled: unknown[] = []
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on("unhandledRejection", onUnhandledRejection)

      try {
        const logger = {
          ...makeLoggerSpy(),
          warn: async () => {
            throw new Error("logging sink is down")
          },
        }
        const { adapter } = buildHarness({
          adapterOptions: { resolveSessionMode: async () => "default", logger },
          newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }] },
        })

        await expect(send(adapter)).resolves.toBeUndefined()
        // Give the rejected `warn()` promise a turn to surface as an
        // `unhandledRejection` if safeWarn didn't actually catch it.
        await new Promise((resolve) => setImmediate(resolve))

        expect(unhandled).toEqual([])
      } finally {
        process.off("unhandledRejection", onUnhandledRejection)
      }
    })

    it("is a no-op when the session is already in the resolved mode", async () => {
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default" },
        newSessionModes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] },
      })
      await send(adapter)
      expect(setSessionMode).not.toHaveBeenCalled()
    })

    it("logs a warning and leaves the session usable when setSessionMode itself rejects", async () => {
      const logger = makeLoggerSpy()
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default", logger },
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
      })
      setSessionMode.mockRejectedValueOnce(new Error("agent rejected the mode switch"))

      await expect(send(adapter)).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        "failed to switch session into the selected mode",
        expect.objectContaining({ error: expect.stringContaining("agent rejected the mode switch") }),
      )
    })

    it("re-applies the resolved mode on a restored session, not just a freshly created one", async () => {
      const { adapter, setSessionMode, loadSession } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default" },
        loadSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
      })
      await send(adapter, "room-restored", { "room-restored": "session-restored" })
      expect(loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-restored" }))
      expect(setSessionMode).toHaveBeenCalledWith({ sessionId: "session-restored", modeId: "default" })
    })

    // The ACP client does not runtime-validate an agent's JSON-RPC response
    // (see `dist/acp.js` — `newSession`/`loadSession`/`resumeSession`
    // just return the raw parsed result), so the two cases below model
    // non-conforming responses that `SessionModeState`'s type promises can't
    // happen but nothing actually prevents.
    it("does not throw when the agent's modes response omits availableModes", async () => {
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default" },
        newSessionModes: { currentModeId: "auto" },
      })

      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionMode).not.toHaveBeenCalled()
    })

    it("treats a resumed session as restored even when the agent's response carries no modes at all", async () => {
      // The installed ACP SDK's own `resumeSession` has no `?? {}`
      // fallback the way its `loadSession` does, so resolving to `undefined`
      // on success is a real possibility here, not just a hypothetical.
      const { adapter, newSession } = buildHarness({
        agentCapabilities: { sessionCapabilities: { resume: true } },
      })

      await expect(send(adapter, "room-restored", { "room-restored": "session-restored" })).resolves.toBeUndefined()
      expect(newSession).not.toHaveBeenCalled()
    })

    it("applies the resolved mode only once per session, not on every subsequent message", async () => {
      // The `activeSessions` fast path in `getOrCreateSession` is what makes
      // this establishment-only, not per-turn — a regression that moved the
      // call so it re-runs every message would add a `setSessionMode` round
      // trip (and any of its failure-warning noise) to every single turn.
      const { adapter, setSessionMode } = buildHarness({
        adapterOptions: { resolveSessionMode: async () => "default" },
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
      })
      await send(adapter)
      await send(adapter)
      expect(setSessionMode).toHaveBeenCalledTimes(1)
    })

    it("warns instead of hanging forever when setSessionMode never responds", async () => {
      // The installed ACP SDK's `sendRequest` has no timeout of its own — an
      // agent that never answers `session/set_mode` would otherwise stall
      // this room's turn indefinitely.
      vi.useFakeTimers()
      try {
        let setSessionModeCalled: () => void = () => undefined
        const called = new Promise<void>((resolve) => { setSessionModeCalled = resolve })

        const logger = makeLoggerSpy()
        const { adapter, setSessionMode } = buildHarness({
          adapterOptions: { resolveSessionMode: async () => "default", logger },
          newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
        })
        setSessionMode.mockImplementationOnce(() => {
          setSessionModeCalled()
          return new Promise(() => undefined)
        })

        const onMessage = send(adapter)
        await called
        await vi.advanceTimersByTimeAsync(10_000)
        await onMessage

        expect(logger.warn).toHaveBeenCalledWith(
          "failed to switch session into the selected mode",
          expect.objectContaining({ error: expect.stringContaining("did not respond within") }),
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("failure reporting", () => {
    function buildFailureHarness(input: {
      turnTimeoutMs?: number;
      prompt: ReturnType<typeof vi.fn>;
      cancel?: ReturnType<typeof vi.fn>;
      newSession?: ReturnType<typeof vi.fn>;
    }) {
      let clientHandle: BandACPClient | null = null
      const cancel = input.cancel ?? vi.fn(async () => undefined)
      const loadSession = vi.fn(async () => ({}))
      const newSession = input.newSession ?? vi.fn(async () => ({ sessionId: "session-1" }))

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        turnTimeoutMs: input.turnTimeoutMs,
        connectionFactory: async (client) => {
          clientHandle = client as unknown as BandACPClient
          const controller = new AbortController()
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
              })),
              authenticate: vi.fn(async () => ({})),
              loadSession,
              resumeSession: vi.fn(),
              newSession,
              cancel,
              prompt: input.prompt,
            } as never,
            stop: async () => {
              controller.abort()
            },
          }
        },
      })

      return { adapter, cancel, loadSession, newSession, getClient: () => requireAcpClient(clientHandle) }
    }

    describeDeliveryContract([{
      path: "ACP flushed reply chunk",
      turn: async (tools) => {
        const { adapter, getClient } = buildFailureHarness({
          prompt: vi.fn(async (params: { sessionId: string }) => {
            await getClient().sessionUpdate({
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final answer" } },
            })
            return { stopReason: "end_turn" }
          }),
        })
        await adapter.onStarted("Agent", "desc")
        await adapter.onMessage(
          makeMessage("question", "room-delivery"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-delivery" },
        )
      },
    }])

    it("reports a structured failure, carrying the provider's stop reason, without throwing a raw error", async () => {
      const { adapter } = buildFailureHarness({
        prompt: vi.fn(async () => ({ stopReason: "refusal" })),
      })
      await adapter.onStarted("Agent", "desc")

      const tools = new FakeTools()
      await expectTurnFailed(adapter.onMessage(
        makeMessage("question", "room-refusal"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-refusal" },
      ))

      expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
        provider: "acp",
        code: "refusal",
        message: "ACP turn ended with stop reason: refusal.",
      })
    })

    it("reports a structured failure when the prompt call itself rejects", async () => {
      const promptError = new Error("agent process crashed")
      const { adapter } = buildFailureHarness({
        prompt: vi.fn(async () => {
          throw promptError
        }),
      })
      await adapter.onStarted("Agent", "desc")

      const tools = new FakeTools()
      await expectTurnFailed(adapter.onMessage(
        makeMessage("question", "room-crash"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-crash" },
      ))

      expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
        provider: "acp",
        message: "agent process crashed",
      })
    })

    it("a fake connection.prompt rejecting with a wire-shaped error reaches sendFailure with code, message, and detail populated", async () => {
      const { adapter } = buildFailureHarness({
        prompt: vi.fn(async () => {
          throw { code: 42, message: "quota exceeded", data: { retryAfterMs: 5000 } }
        }),
      })
      await adapter.onStarted("Agent", "desc")

      const tools = new FakeTools()
      await expectTurnFailed(adapter.onMessage(
        makeMessage("question", "room-jsonrpc"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-jsonrpc" },
      ))

      expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
        provider: "acp",
        code: "42",
        message: "quota exceeded",
        detail: { retryAfterMs: 5000 },
      })
    })

    it("does not redeliver an already-flushed chunk when a later step of the same turn fails", async () => {
      const { adapter, getClient } = buildFailureHarness({
        prompt: vi.fn(async (params: { sessionId: string }) => {
          await getClient().sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final answer" } },
          })
          return { stopReason: "end_turn" }
        }),
      })
      await adapter.onStarted("Agent", "desc")

      // Fails the "ACP client session" task event posted right after the
      // success-path flush already delivered the chunk above, landing in
      // `runTurn`'s catch — which used to flush again from the same
      // (non-draining) buffer and post the same reply twice.
      const tools = new FakeTools({ failOn: ["sendEvent"] })
      await expectTurnFailed(adapter.onMessage(
        makeMessage("question", "room-double-flush"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-double-flush" },
      ))

      expect(tools.messages).toEqual(["final answer"])
    })

    it("on a turn timeout: cancels the outstanding prompt, flushes output streamed so far, and evicts the session so the room's next turn establishes a fresh session instead of restoring or reusing it", async () => {
      vi.useFakeTimers()
      try {
        const prompt = vi.fn()
        const { adapter, cancel, loadSession, newSession, getClient } = buildFailureHarness({
          turnTimeoutMs: 1_000,
          prompt,
        })
        prompt.mockImplementationOnce(async (params: { sessionId: string }) => {
          await getClient().sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial-before-timeout" } },
          })
          // Never settles — the real agent is still working when the turn
          // gives up waiting on it.
          return new Promise(() => undefined)
        })
        prompt.mockImplementation(async () => ({ stopReason: "end_turn" }))

        await adapter.onStarted("Agent", "desc")

        const tools = new FakeTools()
        const turn = adapter.onMessage(
          makeMessage("question", "room-timeout"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-timeout" },
        )
        // A safety net only -- `expectTurnFailed` below attaches the real
        // assertion separately. Without this, the rejection below (once the
        // timer fires) has no handler yet during the `advanceTimersByTimeAsync`
        // tick that produces it, which Node flags as unhandled even though
        // `expectTurnFailed` handles it moments later.
        turn.catch(() => undefined)

        await vi.advanceTimersByTimeAsync(1_000)
        await expectTurnFailed(turn)

        // Partial output the agent had already streamed still reaches the
        // room instead of being silently discarded.
        expect(tools.messages).toEqual(["partial-before-timeout"])
        expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
          provider: "acp",
          code: "timeout",
        })
        // The abandoned turn is actually told to stop, not just given up on
        // locally.
        expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1" })

        // The timed-out session is evicted AND barred from restore: the
        // room's next turn establishes a genuinely fresh session via
        // `newSession` instead of `loadSession`-restoring the one the
        // abandoned turn may still be writing to.
        const nextTools = new FakeTools()
        await adapter.onMessage(
          makeMessage("follow up", "room-timeout"),
          nextTools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-timeout" },
        )
        expect(loadSession).not.toHaveBeenCalled()
        expect(newSession).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a stray notification from a timed-out turn's session cannot contaminate the next turn's reply, since the next turn is a genuinely fresh session", async () => {
      vi.useFakeTimers()
      try {
        const prompt = vi.fn()
        const newSession = vi.fn()
          .mockResolvedValueOnce({ sessionId: "session-1" })
          .mockResolvedValueOnce({ sessionId: "session-2" })
        const { adapter, loadSession, getClient } = buildFailureHarness({
          turnTimeoutMs: 1_000,
          prompt,
          newSession,
        })
        prompt.mockImplementationOnce(() => new Promise(() => undefined))

        await adapter.onStarted("Agent", "desc")

        const tools = new FakeTools()
        const turn = adapter.onMessage(
          makeMessage("question", "room-stray"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-stray" },
        )
        turn.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(1_000)
        await expectTurnFailed(turn)

        // The next turn establishes session-2 (a fresh id, not a restore of
        // session-1) and streams its own real content; a straggler from the
        // abandoned session-1 turn arrives for the OLD id in between.
        prompt.mockImplementationOnce(async (params: { sessionId: string }) => {
          await getClient().sessionUpdate({
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE-FROM-ABANDONED-TURN " } },
          })
          await getClient().sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "real-turn-2-answer" } },
          })
          return { stopReason: "end_turn" }
        })

        const nextTools = new FakeTools()
        await adapter.onMessage(
          makeMessage("follow up", "room-stray"),
          nextTools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-stray" },
        )

        expect(loadSession).not.toHaveBeenCalled()
        expect(nextTools.messages).toEqual(["real-turn-2-answer"])
      } finally {
        vi.useRealTimers()
      }
    })

    it("does not wedge the room forever waiting on a turn-timeout cancel() that never resolves", async () => {
      vi.useFakeTimers()
      try {
        const prompt = vi.fn()
        const cancel = vi.fn(() => new Promise(() => undefined))
        const { adapter } = buildFailureHarness({
          turnTimeoutMs: 1_000,
          prompt,
          cancel,
        })
        prompt.mockImplementationOnce(() => new Promise(() => undefined))
        prompt.mockImplementation(async () => ({ stopReason: "end_turn" }))

        await adapter.onStarted("Agent", "desc")

        const tools = new FakeTools()
        const turn = adapter.onMessage(
          makeMessage("question", "room-wedge"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-wedge" },
        )
        turn.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(1_000)

        // The timed-out turn itself still fails promptly -- it does not wait
        // on `cancel()`, which this test deliberately never resolves.
        await expectTurnFailed(turn)

        // Nor does the room stay wedged: a follow-up turn on the same room
        // completes normally instead of hanging behind the unresolved cancel.
        const nextTools = new FakeTools()
        await adapter.onMessage(
          makeMessage("follow up", "room-wedge"),
          nextTools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-wedge" },
        )
        expect(nextTools.messages).toEqual([])
        expect(findFailureEvent(nextTools)).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([0, -1, NaN])("constructing with an invalid turnTimeoutMs (%s) throws", (invalid) => {
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        turnTimeoutMs: invalid,
      })).toThrow(/turnTimeoutMs must be a positive number or Infinity/)
    })

    it("constructing with a turnTimeoutMs beyond setTimeout's max delay throws", () => {
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        turnTimeoutMs: 2_147_483_648,
      })).toThrow(/turnTimeoutMs must be Infinity or at most 2147483647/)
    })

    it("accepts Infinity as an explicit, unbounded turnTimeoutMs", () => {
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        turnTimeoutMs: Infinity,
      })).not.toThrow()
    })

    it("constructing with a non-number turnTimeoutMs throws instead of silently disabling the timeout", () => {
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        turnTimeoutMs: "3000" as unknown as number,
      })).toThrow(/turnTimeoutMs must be a positive number or Infinity/)
    })

    it("still evicts and cancels when flushing the timed-out partial fails to deliver", async () => {
      vi.useFakeTimers()
      try {
        const prompt = vi.fn()
        const { adapter, cancel, loadSession, newSession, getClient } = buildFailureHarness({
          turnTimeoutMs: 1_000,
          prompt,
        })
        prompt.mockImplementationOnce(async (params: { sessionId: string }) => {
          await getClient().sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial-before-timeout" } },
          })
          return new Promise(() => undefined)
        })
        prompt.mockImplementation(async () => ({ stopReason: "end_turn" }))

        await adapter.onStarted("Agent", "desc")

        const tools = new FakeTools({ failOn: ["sendMessage"] })
        const turn = adapter.onMessage(
          makeMessage("question", "room-timeout-flush-fail"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-timeout-flush-fail" },
        )
        turn.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(1_000)
        await expect(turn).rejects.toBeTruthy()
        expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1" })

        const nextTools = new FakeTools()
        await adapter.onMessage(
          makeMessage("follow up", "room-timeout-flush-fail"),
          nextTools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-timeout-flush-fail" },
        )
        expect(loadSession).not.toHaveBeenCalled()
        expect(newSession).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a stale generation's timeout does not reset a replacement that reused the same session id", async () => {
      let attempt = 0
      let client2: BandACPClient | null = null
      let resolveClosed!: () => void
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const stalePromptStarted = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const replPromptStarted = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const releaseReplacement = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const newSession = vi.fn(async () => ({ sessionId: "session-persist" }))

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        turnTimeoutMs: 250,
        connectionFactory: async (client) => {
          attempt += 1
          const controller = new AbortController()
          if (attempt === 1) {
            return {
              connection: {
                signal: controller.signal,
                closed,
                initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
                authenticate: vi.fn(async () => ({})),
                loadSession: vi.fn(async () => ({})),
                resumeSession: vi.fn(),
                newSession,
                cancel: vi.fn(async () => undefined),
                prompt: vi.fn(async () => {
                  stalePromptStarted.resolve()
                  return new Promise(() => undefined)
                }),
              } as never,
              stop: async () => {
                controller.abort()
              },
            }
          }
          client2 = client as unknown as BandACPClient
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
              authenticate: vi.fn(async () => ({})),
              loadSession: vi.fn(async () => ({})),
              resumeSession: vi.fn(),
              newSession,
              cancel: vi.fn(async () => undefined),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                replPromptStarted.resolve()
                await client2!.sessionUpdate({
                  sessionId: params.sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLACEMENT-OUTPUT" } },
                })
                await releaseReplacement.promise
                return { stopReason: "end_turn" }
              }),
            } as never,
            stop: async () => {
              controller.abort()
            },
          }
        },
      })

      await adapter.onStarted("Agent", "desc")
      const staleTools = new FakeTools()
      const staleTurn = adapter.onMessage(
        makeMessage("hello", "room-race"),
        staleTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-race" },
      )
      staleTurn.catch(() => undefined)
      await stalePromptStarted.promise
      await adapter.onCleanup("room-race")
      resolveClosed()
      await new Promise((resolve) => setTimeout(resolve, 10))

      const replTools = new FakeTools()
      const replTurn = adapter.onMessage(
        makeMessage("replacement", "room-race"),
        replTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-race" },
      )
      await replPromptStarted.promise
      await expectTurnFailed(staleTurn)

      releaseReplacement.resolve()
      await replTurn
      expect(replTools.messages).toEqual(["REPLACEMENT-OUTPUT"])

      const thirdTools = new FakeTools()
      await adapter.onMessage(
        makeMessage("third", "room-race"),
        thirdTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-race" },
      )
      expect(newSession).toHaveBeenCalledTimes(2)
      await adapter.stop()
    })

    it("a stale generation's permission request is cancelled and never delivered to a same-id replacement room", async () => {
      let attempt = 0
      let client1: BandACPClient | null = null
      let resolveClosed!: () => void
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const stalePromptStarted = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const replPromptStarted = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const releaseReplacement = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const resolvedRooms: string[] = []
      const newSession = vi.fn(async () => ({ sessionId: "session-persist" }))
      const permissionParams = {
        sessionId: "session-persist",
        toolCall: { toolCallId: "call-stale", title: "Edit config" },
        options: [{ kind: "allow_once" as const, name: "Allow once", optionId: "allow" }],
      }

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        resolvePermission: async (request) => {
          resolvedRooms.push(request.roomId)
          return "allow"
        },
        connectionFactory: async (client) => {
          attempt += 1
          const controller = new AbortController()
          if (attempt === 1) {
            client1 = client as unknown as BandACPClient
            return {
              connection: {
                signal: controller.signal,
                closed,
                initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
                authenticate: vi.fn(async () => ({})),
                loadSession: vi.fn(async () => ({})),
                resumeSession: vi.fn(),
                newSession,
                cancel: vi.fn(async () => undefined),
                prompt: vi.fn(async () => {
                  stalePromptStarted.resolve()
                  return new Promise(() => undefined)
                }),
              } as never,
              stop: async () => {
                controller.abort()
              },
            }
          }
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
              authenticate: vi.fn(async () => ({})),
              loadSession: vi.fn(async () => ({})),
              resumeSession: vi.fn(),
              newSession,
              cancel: vi.fn(async () => undefined),
              prompt: vi.fn(async () => {
                replPromptStarted.resolve()
                await releaseReplacement.promise
                return { stopReason: "end_turn" }
              }),
            } as never,
            stop: async () => {
              controller.abort()
            },
          }
        },
      })

      await adapter.onStarted("Agent", "desc")
      const staleTools = new FakeTools()
      const staleTurn = adapter.onMessage(
        makeMessage("hello", "room-perm-race"),
        staleTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-perm-race" },
      )
      staleTurn.catch(() => undefined)
      await stalePromptStarted.promise
      await adapter.onCleanup("room-perm-race")
      resolveClosed()
      await new Promise((resolve) => setTimeout(resolve, 10))

      const replTools = new FakeTools()
      const replTurn = adapter.onMessage(
        makeMessage("replacement", "room-perm-race"),
        replTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-perm-race" },
      )
      await replPromptStarted.promise

      const stalePermission = await client1!.requestPermission(permissionParams)
      expect(stalePermission).toEqual({ outcome: { outcome: "cancelled" } })
      expect(replTools.events.filter((event) => event.metadata?.permission_request === true)).toEqual([])
      expect(resolvedRooms).toEqual([])

      releaseReplacement.resolve()
      await replTurn
      await adapter.stop()
    })

    it("takeCollectedChunks does not resurrect a buffer deleted by onCleanup", async () => {
      let clientHandle: BandACPClient | null = null
      const promptStarted = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const promptGate = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } })()
      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async (client) => {
          clientHandle = client as unknown as BandACPClient
          const controller = new AbortController()
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
              authenticate: vi.fn(async () => ({})),
              loadSession: vi.fn(async () => ({})),
              resumeSession: vi.fn(),
              newSession: vi.fn(async () => ({ sessionId: "session-1" })),
              cancel: vi.fn(async () => undefined),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                await clientHandle!.sessionUpdate({
                  sessionId: params.sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "in-flight" } },
                })
                promptStarted.resolve()
                await promptGate.promise
                return { stopReason: "end_turn" }
              }),
            } as never,
            stop: async () => {
              controller.abort()
            },
          }
        },
      })
      await adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      const turn = adapter.onMessage(
        makeMessage("hello", "room-cleanup-inflight"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-cleanup-inflight" },
      )
      await promptStarted.promise
      await adapter.onCleanup("room-cleanup-inflight")
      promptGate.resolve()
      await turn.catch(() => undefined)
      await clientHandle!.sessionUpdate({
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late-after-cleanup" } },
      })
      expect(clientHandle!.takeCollectedChunks("session-1")).toEqual([])
      await adapter.stop()
    })
  })

  describe("resolveSessionModel", () => {
    // Shared harness: a connection whose newSession/loadSession return a
    // given `configOptions` catalog and a `setSessionConfigOption` spy — the
    // model-hook analog of the `resolveSessionMode` harness above. Also
    // accepts `newSessionModes` and exposes `setSessionMode`, so a test
    // exercising both hooks together doesn't need its own hand-rolled mock.
    function buildHarness(input: {
      adapterOptions?: Partial<ACPClientAdapterOptions>;
      newSessionModes?: { currentModeId: string; availableModes?: Array<{ id: string; name: string }> };
      newSessionConfigOptions?: Array<Record<string, unknown>>;
      loadSessionConfigOptions?: Array<Record<string, unknown>>;
    } = {}) {
      const setSessionMode = vi.fn(async () => ({}))
      const setSessionConfigOption = vi.fn(async () => ({ configOptions: [] }))
      const newSession = vi.fn(async () => ({
        sessionId: "session-1",
        ...(input.newSessionModes ? { modes: input.newSessionModes } : {}),
        ...(input.newSessionConfigOptions ? { configOptions: input.newSessionConfigOptions } : {}),
      }))
      const loadSession = vi.fn(async () => ({
        ...(input.loadSessionConfigOptions ? { configOptions: input.loadSessionConfigOptions } : {}),
      }))
      const prompt = vi.fn(async () => ({ stopReason: "end_turn" }))

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => buildMockConnection({
          loadSession,
          newSession,
          prompt,
          extraRpcSpies: { setSessionMode, setSessionConfigOption },
        }),
        ...input.adapterOptions,
      })

      return { adapter, setSessionMode, setSessionConfigOption, loadSession, newSession }
    }

    // Shaped like the "model" config option real Claude/Codex ACP agents
    // advertise (see `test/unit/acpAgentContract.test.ts` in band-plugin-vsc).
    function modelConfigOption(overrides: Partial<{
      id: string;
      category: string | null;
      currentValue: string;
      options: Array<Record<string, unknown>>;
    }> = {}) {
      return {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus" },
          { value: "sonnet", name: "Sonnet" },
        ],
        ...overrides,
      }
    }

    it("selects an advertised model", async () => {
      const resolveSessionModel = vi.fn(async () => "sonnet")
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel },
        newSessionConfigOptions: [modelConfigOption()],
      })
      await send(adapter)
      expect(resolveSessionModel).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }],
        }),
        expect.anything(),
      )
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("does nothing when resolveSessionModel is unset, regardless of what's advertised", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        newSessionConfigOptions: [modelConfigOption()],
      })
      await send(adapter)
      expect(setSessionConfigOption).not.toHaveBeenCalled()
    })

    it("does nothing, and never calls the resolver, when the backend advertises no configOptions at all", async () => {
      const logger = makeLoggerSpy()
      const resolveSessionModel = vi.fn(async () => "sonnet")
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel, logger },
      })
      await send(adapter)
      expect(resolveSessionModel).not.toHaveBeenCalled()
      expect(setSessionConfigOption).not.toHaveBeenCalled()
      // Not advertising configOptions at all is expected and silent;
      // advertising them but missing the resolved one (below) is not.
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it("does nothing, and never calls the resolver, when configOptions has no model-categorized/keyed entry", async () => {
      const resolveSessionModel = vi.fn(async () => "sonnet")
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel },
        newSessionConfigOptions: [
          { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] },
        ],
      })
      await send(adapter)
      expect(resolveSessionModel).not.toHaveBeenCalled()
      expect(setSessionConfigOption).not.toHaveBeenCalled()
    })

    it("warns, but does not throw, when the resolved model id isn't advertised", async () => {
      const logger = makeLoggerSpy()
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "gpt-9", logger },
        newSessionConfigOptions: [modelConfigOption()],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        "resolveSessionModel selected a model id this session does not advertise",
        expect.objectContaining({ selectedModelId: "gpt-9" }),
      )
    })

    it("is a no-op when the session is already using the resolved model", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "opus" },
        newSessionConfigOptions: [modelConfigOption({ currentValue: "opus" })],
      })
      await send(adapter)
      expect(setSessionConfigOption).not.toHaveBeenCalled()
    })

    it("logs a warning and leaves the session usable when setSessionConfigOption itself rejects", async () => {
      const logger = makeLoggerSpy()
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet", logger },
        newSessionConfigOptions: [modelConfigOption()],
      })
      setSessionConfigOption.mockRejectedValueOnce(new Error("agent rejected the model switch"))

      await expect(send(adapter)).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        "failed to switch session into the selected model",
        expect.objectContaining({ error: expect.stringContaining("agent rejected the model switch") }),
      )
    })

    it("re-applies the resolved model on a restored session, not just a freshly created one", async () => {
      const { adapter, setSessionConfigOption, loadSession } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        loadSessionConfigOptions: [modelConfigOption()],
      })
      await send(adapter, "room-restored", { "room-restored": "session-restored" })
      expect(loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-restored" }))
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-restored", configId: "model", value: "sonnet" })
    })

    // The ACP client does not runtime-validate an agent's JSON-RPC response,
    // so this models a non-conforming response that `SessionConfigSelect`'s
    // type promises can't happen but nothing actually prevents.
    it("does not throw when the matched config option's options field is missing", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus" },
        ],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).not.toHaveBeenCalled()
    })

    it("flattens a grouped options shape and applies a selection from within a group", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [modelConfigOption({
          options: [
            { group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
          ],
        })],
      })
      await send(adapter)
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("applies the resolved model only once per session, not on every subsequent message", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [modelConfigOption()],
      })
      await send(adapter)
      await send(adapter)
      expect(setSessionConfigOption).toHaveBeenCalledTimes(1)
    })

    it("warns instead of hanging forever when setSessionConfigOption never responds", async () => {
      vi.useFakeTimers()
      try {
        let setSessionConfigOptionCalled: () => void = () => undefined
        const called = new Promise<void>((resolve) => { setSessionConfigOptionCalled = resolve })

        const logger = makeLoggerSpy()
        const { adapter, setSessionConfigOption } = buildHarness({
          adapterOptions: { resolveSessionModel: async () => "sonnet", logger },
          newSessionConfigOptions: [modelConfigOption()],
        })
        setSessionConfigOption.mockImplementationOnce(() => {
          setSessionConfigOptionCalled()
          return new Promise(() => undefined)
        })

        const onMessage = send(adapter)
        await called
        await vi.advanceTimersByTimeAsync(10_000)
        await onMessage

        expect(logger.warn).toHaveBeenCalledWith(
          "failed to switch session into the selected model",
          expect.objectContaining({ error: expect.stringContaining("did not respond within") }),
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it("resolveSessionMode and resolveSessionModel configured together on the same session don't interfere with each other", async () => {
      const { adapter, setSessionMode, setSessionConfigOption } = buildHarness({
        adapterOptions: {
          resolveSessionMode: async () => "default",
          resolveSessionModel: async () => "sonnet",
        },
        newSessionModes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "auto" }, { id: "default", name: "default" }] },
        newSessionConfigOptions: [modelConfigOption()],
      })

      await send(adapter)
      expect(setSessionMode).toHaveBeenCalledWith({ sessionId: "session-1", modeId: "default" })
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("resolves promptly instead of hanging the full timeout when the connection signal starts already aborted", async () => {
      const preAbortedController = new AbortController()
      preAbortedController.abort()
      const setSessionConfigOption = vi.fn(async () => ({ configOptions: [] }))
      const newSession = vi.fn(async () => ({
        sessionId: "session-1",
        configOptions: [modelConfigOption()],
      }))
      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        resolveSessionModel: () => new Promise<string | undefined>(() => undefined),
        connectionFactory: async () => ({
          connection: {
            signal: preAbortedController.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(async () => ({})),
            resumeSession: vi.fn(),
            newSession,
            setSessionMode: vi.fn(async () => ({})),
            setSessionConfigOption,
            prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
          } as never,
          stop: async () => undefined,
        }),
      })

      const timedOut = Symbol("timed-out")
      const winner = await Promise.race([
        send(adapter).then(() => "resolved" as const),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 50)),
      ])
      expect(winner).toBe("resolved")
    })

    it("warns but does not call setSessionConfigOption when resolveSessionModel throws", async () => {
      const logger = makeLoggerSpy()
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: {
          resolveSessionModel: async () => { throw new Error("boom") },
          logger,
        },
        newSessionConfigOptions: [modelConfigOption()],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        "resolveSessionModel threw; preserving the harness default",
        expect.objectContaining({ error: expect.stringContaining("boom") }),
      )
    })

    it("warns when resolveSessionModel answers after the request was already abandoned to the timeout", async () => {
      let resolveLate: (value: string) => void = () => undefined
      const logger = makeLoggerSpy()
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: {
          resolveSessionModel: () => new Promise<string | undefined>((resolve) => { resolveLate = resolve }),
          logger,
          permissionTimeoutMs: 20,
        },
        newSessionConfigOptions: [modelConfigOption()],
      })

      await send(adapter)
      expect(setSessionConfigOption).not.toHaveBeenCalled()

      resolveLate("sonnet")
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(logger.warn).toHaveBeenCalledWith(
        "resolveSessionModel answered after the request was abandoned; discarding",
        { chosenId: "sonnet" },
      )
    })

    it("detects the model option by id when category is missing", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [modelConfigOption({ category: null })],
      })
      await send(adapter)
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("prefers the entry actually categorized \"model\" over one merely keyed id:\"model\"", async () => {
      const resolveSessionModel = vi.fn(async () => "sonnet")
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel },
        newSessionConfigOptions: [
          { id: "model", name: "Thought level", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
          modelConfigOption({ id: "primary_model" }),
        ],
      })
      await send(adapter)
      expect(resolveSessionModel).toHaveBeenCalledWith(
        expect.objectContaining({ currentModelId: "opus" }),
        expect.anything(),
      )
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "primary_model", value: "sonnet" })
    })

    it("does not throw when the options array contains a non-object entry", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [modelConfigOption({
          // `null` is dropped by the `!entry` half of the guard; the bare
          // string is dropped by its `typeof entry !== "object"` half —
          // covering both halves, since a plain object-record check alone
          // wouldn't exercise the second.
          options: [null as unknown as Record<string, unknown>, "not-an-object" as unknown as Record<string, unknown>, { value: "sonnet", name: "Sonnet" }],
        })],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("skips a malformed top-level configOptions entry and still finds the real model option", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [null as unknown as Record<string, unknown>, modelConfigOption()],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("drops a group entry whose own options field is not an array", async () => {
      const resolveSessionModel = vi.fn(async () => "sonnet")
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel },
        newSessionConfigOptions: [modelConfigOption({
          options: [
            { group: "bad", name: "Bad", options: "not-an-array" },
            { group: "anthropic", name: "Anthropic", options: [{ value: "sonnet", name: "Sonnet" }] },
          ],
        })],
      })
      await send(adapter)
      expect(resolveSessionModel).toHaveBeenCalledWith(
        expect.objectContaining({ models: [{ value: "sonnet", name: "Sonnet" }] }),
        expect.anything(),
      )
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })

    it("does not throw when a group entry omits its own options field", async () => {
      const { adapter, setSessionConfigOption } = buildHarness({
        adapterOptions: { resolveSessionModel: async () => "sonnet" },
        newSessionConfigOptions: [modelConfigOption({
          options: [
            { group: "empty", name: "Empty" },
            { group: "anthropic", name: "Anthropic", options: [{ value: "sonnet", name: "Sonnet" }] },
          ],
        })],
      })
      await expect(send(adapter)).resolves.toBeUndefined()
      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "session-1", configId: "model", value: "sonnet" })
    })
  })
});

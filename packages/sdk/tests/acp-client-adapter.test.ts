import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { BandACPClient } from "../src/adapters/acp/client";
import { FakeTools, makeMessage } from "./testUtils";

function makeLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
            unstable_resumeSession: vi.fn(),
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
    let clientHandle: {
      sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
    } | null = null

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
        clientHandle = client as unknown as typeof clientHandle
        const controller = new AbortController()
        return {
          connection: {
            signal: controller.signal,
            closed: new Promise<void>(() => undefined),
            initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
            authenticate: vi.fn(async () => ({})),
            loadSession: vi.fn(),
            unstable_resumeSession: vi.fn(),
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
  })

  it("coalesces adjacent thought chunks, without merging them into an adjacent text run on either side", async () => {
    let clientHandle: {
      sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
    } | null = null

    const prompt = vi.fn(async (params: { sessionId: string }) => {
      // text → thought boundary (no merge), then two thought deltas that do
      // merge, then a thought → text boundary (no merge either direction).
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
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
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
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
            unstable_resumeSession: vi.fn(),
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
    expect(tools.messages).toEqual(["Hi", "Done"])
  })

  it("does not merge a streamed text chunk with an adjacent, unrelated cursor/task completion marker sharing the same chunkType", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))

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

  it("BandACPClient.getCollectedChunks() with no sessionId coalesces each session independently, not across sessions", async () => {
    const client = new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))

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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
          unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
            unstable_resumeSession: vi.fn(),
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
              unstable_resumeSession: vi.fn(),
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
      const unstable_resumeSession = vi.fn()
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
              unstable_resumeSession,
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
    // (see `dist/acp.js` — `newSession`/`loadSession`/`unstable_resumeSession`
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
      // The installed ACP SDK's own `unstable_resumeSession` has no `?? {}`
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
});

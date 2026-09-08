import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { ACPClientHistoryConverter } from "../src/converters/acp-client";
import { FakeTools, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";

interface FakeConnectionOverrides {
  signal?: AbortSignal
  closed?: Promise<void>
  initialize?: unknown
  authenticate?: unknown
  loadSession?: unknown
  unstable_resumeSession?: unknown
  newSession?: unknown
  prompt?: unknown
  cancel?: unknown
}

/**
 * A working ACP connection — every method the adapter calls, stubbed to
 * succeed. A test passes only the part it drives, so the override list is the
 * test's subject rather than eight lines of identical scaffolding.
 */
function fakeConnection(overrides: FakeConnectionOverrides = {}): never {
  return {
    signal: new AbortController().signal,
    closed: new Promise<void>(() => undefined),
    initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
    authenticate: vi.fn(async () => ({})),
    loadSession: vi.fn(),
    unstable_resumeSession: vi.fn(),
    newSession: vi.fn(async () => ({ sessionId: "session-1" })),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    ...overrides,
  } as never
}

function makeLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe("ACPClientAdapter", () => {
  describeDeliveryContract([{
    path: "flushed agent text chunk",
    turn: async (tools) => {
      let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null
      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async (client) => {
          clientHandle = client as unknown as typeof clientHandle
          return {
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: "session-delivery" })),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                await clientHandle?.sessionUpdate({
                  sessionId: params.sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the answer" } },
                })
                return { stopReason: "end_turn" }
              }),
            }),
            stop: vi.fn(async () => undefined),
          }
        },
      })
      await adapter.onStarted("Agent", "desc")
      await adapter.onMessage(
        makeMessage("question", "room-delivery"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-delivery" },
      )
    },
  }]);

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
          connection: fakeConnection({
            signal: controller.signal,
            initialize,
            authenticate,
            loadSession,
            newSession,
            prompt,
          }),
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
          connection: fakeConnection({
            signal: controller.signal,
            initialize,
            newSession,
            prompt,
          }),
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
          connection: fakeConnection({
            signal: controller.signal,
            initialize: vi.fn(async () => ({
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true } },
            })),
            newSession: vi.fn(async () => ({ sessionId: "session-mentions" })),
            prompt,
          }),
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
          connection: fakeConnection({
            signal: controller.signal,
            initialize: vi.fn(async () => ({
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true } },
            })),
            newSession: vi.fn(async () => ({ sessionId: "session-room-context" })),
            prompt,
          }),
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
          connection: fakeConnection({
            signal: controller.signal,
            initialize,
            newSession,
            prompt: vi.fn(),
          }),
          stop: async () => {
            controller.abort()
          },
        }
      },
    })

    await adapter.onStarted("No Transport Agent", "ACP fallback test")

    const tools = new FakeTools()
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("hello", "room-untransported"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-untransported" },
      ),
    )

    expect(newSession).not.toHaveBeenCalled()
    const failureEvent = findFailureEvent(tools)
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "acp",
      message: expect.stringMatching(/does not advertise MCP transport support/),
      code: null,
      detail: null,
    })
    expect(tools.messages).toEqual([])
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
          connection: fakeConnection({
            signal: controller.signal,
            initialize,
            newSession,
            prompt,
          }),
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
    // Shared harness: a connection whose `prompt` drives exactly one
    // `requestPermission` call, scripted with one allow-kind and one
    // reject-kind option — the shape every case below needs to distinguish
    // "denied" from "cancelled" and to pick a specific id.
    function buildHarness(adapterOptions: Partial<ACPClientAdapterOptions> = {}) {
      let clientHandle: {
        sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
        requestPermission: (params: Record<string, unknown>) => Promise<unknown>;
      } | null = null
      let permissionResult: unknown

      const prompt = vi.fn(async (params: { sessionId: string }) => {
        permissionResult = await clientHandle?.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "call-1", title: "Edit file" },
          options: [
            { kind: "allow_once", name: "Allow once", optionId: "allow" },
            { kind: "reject_once", name: "Deny", optionId: "deny" },
          ],
        })
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
          clientHandle = client as unknown as typeof clientHandle
          const controller = new AbortController()
          return {
            connection: fakeConnection({
              signal: controller.signal,
              prompt,
            }),
            stop: async () => {
              controller.abort()
            },
          }
        },
        ...adapterOptions,
      })

      return { adapter, getPermissionResult: () => permissionResult }
    }

    async function send(adapter: ACPClientAdapter, tools: FakeTools, roomId = "room-1"): Promise<void> {
      await adapter.onStarted("Agent", "desc")
      await adapter.onMessage(
        makeMessage("hi", roomId),
        tools,
        { roomToSession: {} },
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
      const { adapter, getPermissionResult } = buildHarness({ resolvePermission: async () => "allow" })
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

        const { adapter, getPermissionResult } = buildHarness({
          resolvePermission: async () => {
            permissionRequested()
            return new Promise<string | undefined>(() => undefined)
          },
          permissionTimeoutMs: 1_000,
        })
        const onMessage = send(adapter, new FakeTools())
        await requested
        await vi.advanceTimersByTimeAsync(1_000)
        await onMessage
        expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
      } finally {
        vi.useRealTimers()
      }
    })

    it("(d) resolvePermission rejecting falls back to cancelled and is logged, not thrown", async () => {
      const logger = makeLoggerSpy()
      const { adapter, getPermissionResult } = buildHarness({
        resolvePermission: async () => {
          throw new Error("host UI call failed")
        },
        logger,
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
          resolvePermission: async () => "allow",
          permissionTimeoutMs: 5_000,
        })
        await send(adapter, new FakeTools())
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it("(f) resolvePermission resolving a reject-kind id is a real deny, not cancelled", async () => {
      const { adapter, getPermissionResult } = buildHarness({ resolvePermission: async () => "deny" })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "selected", optionId: "deny" } })
    })

    it("(g) an id absent from this request's own options falls back to cancelled", async () => {
      const { adapter, getPermissionResult } = buildHarness({ resolvePermission: async () => "not-a-real-option" })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
    })

    it("(h) onCleanup(roomId) while a request for that room is pending resolves it cancelled immediately", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })

      const { adapter, getPermissionResult } = buildHarness({
        resolvePermission: async () => {
          permissionRequested()
          return new Promise<string | undefined>(() => undefined) // hangs until cleanup cancels it
        },
        permissionTimeoutMs: 60_000,
      })

      const onMessage = send(adapter, new FakeTools())
      await requested
      await adapter.onCleanup("room-1")
      await onMessage

      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
    })

    it("(h) stop() with a pending request in any room resolves it cancelled immediately", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })

      const { adapter, getPermissionResult } = buildHarness({
        resolvePermission: async () => {
          permissionRequested()
          return new Promise<string | undefined>(() => undefined)
        },
        permissionTimeoutMs: 60_000,
      })

      const onMessage = send(adapter, new FakeTools())
      await requested
      await adapter.stop()
      await onMessage

      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
    })

    it("(i) resolvePermission resolving promptly to undefined (a dismissed popup) ⇒ cancelled", async () => {
      const { adapter, getPermissionResult } = buildHarness({ resolvePermission: async () => undefined })
      await send(adapter, new FakeTools())
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
    })

    it("(j) the permission-requested event fires before a slow resolver settles, with auto_allowed:false", async () => {
      let permissionRequested: () => void = () => undefined
      const requested = new Promise<void>((resolve) => { permissionRequested = resolve })
      let releasePermission: (value: string | undefined) => void = () => undefined
      const pending = new Promise<string | undefined>((resolve) => { releasePermission = resolve })

      const { adapter } = buildHarness({
        resolvePermission: async () => {
          permissionRequested()
          return pending
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

    it("(k) constructing with a permissionTimeoutMs past the setTimeout clamp throws, like turnTimeoutMs", () => {
      // setTimeout silently clamps delays over ~24.8 days to 1ms instead of
      // erroring — a permissionTimeoutMs meant to mean "wait a long time"
      // must be rejected at construction, not silently auto-resolve almost
      // instantly at runtime.
      expect(() => new ACPClientAdapter({
        command: ["acp-agent"],
        resolvePermission: async () => "allow",
        permissionTimeoutMs: 5_000_000_000,
      })).toThrow(/permissionTimeoutMs must be at most 2147483647/)
    })

    it("(l) resolvePermission throwing synchronously still falls back to cancelled, not an uncaught throw", async () => {
      const { adapter, getPermissionResult } = buildHarness({
        resolvePermission: () => {
          throw new Error("sync boom")
        },
      })
      await expect(send(adapter, new FakeTools())).resolves.toBeUndefined()
      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
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
        // Never actually invoked in this test — onCleanup below cancels the
        // request before resolveManually's race would ever call it — kept
        // async-and-hanging only so a regression (the old, buggy ordering)
        // fails by timing out rather than by a misleading assertion error.
        resolvePermission: async () => new Promise<string | undefined>(() => undefined),
        permissionTimeoutMs: 60_000,
      })

      const onMessage = send(adapter, new DelayedTools())
      await started
      await adapter.onCleanup("room-1")
      releaseSendEvent()
      await onMessage

      expect(getPermissionResult()).toEqual({ outcome: { outcome: "cancelled" } })
    })
  })

  describe("turnTimeoutMs and the two-scope catch", () => {
    it("a fake connection.prompt rejecting with a wire-shaped error reaches sendFailure with code, message, and detail populated", async () => {
      const prompt = vi.fn(async () => {
        // Simulating the ACP SDK's real rejection shape: connection.prompt(...)
        // rejects with the plain deserialized wire object, never an Error.
        throw { code: 42, message: "quota exceeded", data: { retryAfterMs: 5000 } }
      })
      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          const controller = new AbortController()
          return {
            connection: fakeConnection({
              signal: controller.signal,
              newSession: vi.fn(async () => ({ sessionId: "session-err" })),
              prompt,
              cancel: vi.fn(async () => undefined),
            }),
            stop: async () => { controller.abort() },
          }
        },
      })
      await adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      await expectTurnFailed(
        adapter.onMessage(
          makeMessage("hello", "room-err"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-err" },
        ),
      )

      const failureEvent = findFailureEvent(tools)
      expect(failureEvent?.metadata?.failure).toMatchObject({
        provider: "acp",
        code: "42",
        message: "quota exceeded",
        detail: { retryAfterMs: 5000 },
      })
      expect(tools.messages).toEqual([])
    })

    it("a connection re-establishment failure reaches sendFailure via this.stop(), and the failed attempt's own handle is stopped (leaked-handle fix)", async () => {
      let attempt = 0
      let closeFirstConnection: () => void = () => undefined
      const secondHandleStop = vi.fn(async () => undefined)

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          attempt += 1
          if (attempt === 1) {
            const controller = new AbortController()
            const closed = new Promise<void>((resolve) => { closeFirstConnection = resolve })
            return {
              connection: {
                signal: controller.signal,
                closed,
                initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
                authenticate: vi.fn(async () => ({})),
                loadSession: vi.fn(),
                unstable_resumeSession: vi.fn(),
                newSession: vi.fn(async () => ({ sessionId: "session-1" })),
                prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
              } as never,
              stop: async () => { controller.abort() },
            }
          }

          // Second attempt: re-initializing the connection itself fails.
          return {
            connection: fakeConnection({
              initialize: vi.fn(async () => { throw new Error("re-init failed") }),
              newSession: vi.fn(),
              prompt: vi.fn(),
            }),
            stop: secondHandleStop,
          }
        },
      })

      await adapter.onStarted("Agent", "desc")
      // Kill the first connection (agent process exit / stream close) so the
      // next message has to re-establish it.
      closeFirstConnection()
      await Promise.resolve()
      await Promise.resolve()

      const stopSpy = vi.spyOn(adapter, "stop")
      const tools = new FakeTools()
      await expectTurnFailed(
        adapter.onMessage(
          makeMessage("hello", "room-reconnect"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-reconnect" },
        ),
      )

      expect(stopSpy).toHaveBeenCalledTimes(1)
      expect(secondHandleStop).toHaveBeenCalledTimes(1)
      const failureEvent = findFailureEvent(tools)
      expect(failureEvent?.metadata?.failure).toMatchObject({
        provider: "acp",
        message: "re-init failed",
        code: null,
        detail: null,
      })
    })

    it("a superseded spawnConnection() (stop() racing a slow connect) stops its own handle and never overwrites a newer connection (generation-token fix)", async () => {
      let attempt = 0
      let resolveSlowInit: (value: { protocolVersion: number; agentCapabilities: Record<string, unknown> }) => void = () => undefined
      const slowInit = new Promise<{ protocolVersion: number; agentCapabilities: Record<string, unknown> }>((resolve) => { resolveSlowInit = resolve })
      let staleInitializeCalled: () => void = () => undefined
      const staleInitializeCalledSignal = new Promise<void>((resolve) => { staleInitializeCalled = resolve })
      const staleHandleStop = vi.fn(async () => undefined)
      const freshHandleStop = vi.fn(async () => undefined)

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          attempt += 1
          if (attempt === 1) {
            return {
              connection: fakeConnection({
                initialize: vi.fn(async () => {
                  staleInitializeCalled()
                  return slowInit
                }),
                newSession: vi.fn(),
                prompt: vi.fn(),
              }),
              stop: staleHandleStop,
            }
          }

          return {
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: "session-fresh" })),
            }),
            stop: freshHandleStop,
          }
        },
      })

      // Attempt 1: starts, gets stuck awaiting `initialize`.
      const started = adapter.onStarted("Agent", "desc")
      await staleInitializeCalledSignal

      // A stop() fires while attempt 1 is still in flight (e.g. onRuntimeStop
      // racing a slow connect) — bumps the generation counter.
      await adapter.stop()

      // A fresh connection attempt (attempt 2) now runs to completion and
      // installs itself successfully.
      const tools = new FakeTools()
      await adapter.onMessage(
        makeMessage("hello", "room-fresh"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-fresh" },
      )
      expect(freshHandleStop).not.toHaveBeenCalled()
      expect(tools.events.some((event) => event.messageType === "task")).toBe(true)

      // Now let the stale attempt 1 finally resolve, late — it must stop its
      // own handle and throw instead of overwriting the fresh connection.
      resolveSlowInit({ protocolVersion: 1, agentCapabilities: {} })
      await expect(started).rejects.toThrow(/superseded by stop\(\)/)
      expect(staleHandleStop).toHaveBeenCalledTimes(1)
    })

    it("a superseded attempt rejecting into a turn's own catch tears down only its own connection, never the newer one", async () => {
      // The generation guard above keeps a stale attempt from *installing*
      // itself, but the attempt still rejects — and when it was started by
      // onMessage rather than onStarted, that rejection lands in the
      // connection-establishment catch, whose stop() is global. An attempt may
      // only tear down the connection generation it actually owns.
      let attempt = 0
      let resolveSlowInit: (value: { protocolVersion: number; agentCapabilities: Record<string, unknown> }) => void = () => undefined
      const slowInit = new Promise<{ protocolVersion: number; agentCapabilities: Record<string, unknown> }>((resolve) => { resolveSlowInit = resolve })
      let staleInitializeCalled: () => void = () => undefined
      const staleInitializeCalledSignal = new Promise<void>((resolve) => { staleInitializeCalled = resolve })
      const staleHandleStop = vi.fn(async () => undefined)
      const freshHandleStop = vi.fn(async () => undefined)
      const firstConnection = new AbortController()

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          attempt += 1
          if (attempt === 1) {
            return {
              connection: fakeConnection({
                signal: firstConnection.signal,
                newSession: vi.fn(),
                prompt: vi.fn(),
              }),
              stop: vi.fn(async () => undefined),
            }
          }

          if (attempt === 2) {
            return {
              connection: fakeConnection({
                initialize: vi.fn(async () => {
                  staleInitializeCalled()
                  return slowInit
                }),
                newSession: vi.fn(),
                prompt: vi.fn(),
              }),
              stop: staleHandleStop,
            }
          }

          return {
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: "session-fresh" })),
            }),
            stop: freshHandleStop,
          }
        },
      })

      await adapter.onStarted("Agent", "desc")

      // The live connection drops, so this room's turn reconnects (attempt 2)
      // and gets stuck in `initialize`.
      firstConnection.abort()
      const staleTools = new FakeTools()
      const staleTurn = adapter.onMessage(
        makeMessage("hello", "room-stale"),
        staleTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-stale" },
      )
      await staleInitializeCalledSignal

      // Another room's connection-level failure stops the adapter, then a
      // fresh connection (attempt 3) is established and serves a full turn.
      await adapter.stop()
      const freshTools = new FakeTools()
      await adapter.onMessage(
        makeMessage("hello", "room-fresh"),
        freshTools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-fresh" },
      )
      expect(freshTools.events.some((event) => event.messageType === "task")).toBe(true)

      // Only now does the stale attempt reject, into room-stale's catch.
      resolveSlowInit({ protocolVersion: 1, agentCapabilities: {} })
      await expectTurnFailed(staleTurn)

      expect(staleHandleStop).toHaveBeenCalledTimes(1)
      expect(freshHandleStop).not.toHaveBeenCalled()
      expect(findFailureEvent(staleTools)?.metadata?.failure)
        .toMatchObject({ provider: "acp", message: expect.stringMatching(/superseded by stop\(\)/) })

      // The fresh connection is not merely un-stopped but still usable: its
      // session survives, so this turn reuses it instead of spawning a fourth.
      await adapter.onMessage(
        makeMessage("again", "room-fresh"),
        new FakeTools(),
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-fresh" },
      )
      expect(attempt).toBe(3)
    })

    it("a rejecting handle.stop() during the connection-establishment catch's cleanup still lets the original failure reach sendFailure", async () => {
      const rejectingStop = vi.fn(async () => { throw new Error("handle.stop failed") })
      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          const controller = new AbortController()
          return {
            connection: fakeConnection({
              signal: controller.signal,
              newSession: vi.fn(async () => { throw new Error("newSession failed") }),
              prompt: vi.fn(),
            }),
            stop: rejectingStop,
          }
        },
      })
      await adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      await expectTurnFailed(
        adapter.onMessage(
          makeMessage("hello", "room-cleanup-fail"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-cleanup-fail" },
        ),
      )

      expect(rejectingStop).toHaveBeenCalledTimes(1)
      const failureEvent = findFailureEvent(tools)
      expect(failureEvent?.metadata?.failure).toMatchObject({
        provider: "acp",
        message: "newSession failed",
        code: null,
        detail: null,
      })
    })

    it("a silent reconnect (no explicit stop()) bumps the generation, so a stale turn's own failure does not tear down the fresh connection", async () => {
      // Unlike the generation-token tests above, nothing calls adapter.stop()
      // here — the first connection just dies (subprocess crash / stream
      // EOF), and ensureConnection() reconnects on its own the next time a
      // turn needs it. That silent reconnect has to bump the generation
      // counter itself, or a turn that captured the *old* generation before
      // reconnecting — and then fails for an unrelated reason — would still
      // match and tear the brand-new connection down.
      let attempt = 0
      const firstConnectionController = new AbortController()
      const secondStop = vi.fn(async () => undefined)
      let secondConnNewSessionCalls = 0
      const newSessionOnSecondConnection = vi.fn(async () => {
        secondConnNewSessionCalls += 1
        if (secondConnNewSessionCalls === 1) {
          // room-a's own session-establishment request fails for a reason
          // that has nothing to do with the (freshly reconnected) connection.
          throw new Error("room-a session create failed")
        }
        return { sessionId: `session-${secondConnNewSessionCalls}` }
      })

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async () => {
          attempt += 1
          if (attempt === 1) {
            return {
              connection: fakeConnection({ signal: firstConnectionController.signal }),
              stop: vi.fn(async () => undefined),
            }
          }
          return {
            connection: fakeConnection({ newSession: newSessionOnSecondConnection }),
            stop: secondStop,
          }
        },
      })

      await adapter.onStarted("Agent", "desc")
      // Connection 1 dies without anyone calling stop().
      firstConnectionController.abort()

      const tools = new FakeTools()
      await expectTurnFailed(
        adapter.onMessage(
          makeMessage("hello", "room-a"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-a" },
        ),
      )

      // room-a's own failure must not have torn down the connection it just
      // silently reconnected to.
      expect(secondStop).not.toHaveBeenCalled()
      expect(attempt).toBe(2)

      // The fresh connection is still live and usable by another room.
      const toolsB = new FakeTools()
      await adapter.onMessage(
        makeMessage("hello", "room-b"),
        toolsB,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-b" },
      )
      expect(toolsB.events.some((event) => event.messageType === "task")).toBe(true)
      expect(attempt).toBe(2)
    })

    it("a hang past turnTimeoutMs produces code: 'timeout', calls connection.cancel, and does not call this.stop() (only onCleanup for that room)", async () => {
      vi.useFakeTimers()
      try {
        const cancel = vi.fn(async () => undefined)
        const hangingPrompt = new Promise<{ stopReason: string }>(() => undefined)
        let promptStarted: () => void = () => undefined
        const promptStartedSignal = new Promise<void>((resolve) => { promptStarted = resolve })
        let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory: async (client) => {
            clientHandle = client as unknown as typeof clientHandle
            const controller = new AbortController()
            return {
              connection: fakeConnection({
                signal: controller.signal,
                newSession: vi.fn(async () => ({ sessionId: "session-timeout" })),
                prompt: vi.fn(async (params: { sessionId: string }) => {
                  await clientHandle?.sessionUpdate({
                    sessionId: params.sessionId,
                    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "work done before wedging" } },
                  })
                  promptStarted()
                  return hangingPrompt
                }),
                cancel,
              }),
              stop: vi.fn(async () => undefined),
            }
          },
        })
        await adapter.onStarted("Agent", "desc")
        const stopSpy = vi.spyOn(adapter, "stop")

        const tools = new FakeTools()
        const onMessage = adapter.onMessage(
          makeMessage("hello", "room-timeout"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-timeout" },
        )
        await promptStartedSignal
        // Attached before the timer fires: `advanceTimersByTimeAsync` drives
        // the rejection synchronously within this tick, and a handler must
        // already be on the promise by then or Node flags it as unhandled.
        const failed = expectTurnFailed(onMessage)
        await vi.advanceTimersByTimeAsync(1_000)
        await failed

        expect(cancel).toHaveBeenCalledWith({ sessionId: "session-timeout" })
        expect(stopSpy).not.toHaveBeenCalled()
        const failureEvent = findFailureEvent(tools)
        expect(failureEvent?.metadata?.failure).toMatchObject({
          provider: "acp",
          code: "timeout",
          message: "ACP turn timed out.",
        })
        // Cleanup drops the session's buffer, so anything the agent streamed
        // before wedging has to be posted first — on the 60-minute default that
        // is up to an hour of a coding agent's output.
        expect(tools.messages).toEqual(["work done before wedging"])
      } finally {
        vi.useRealTimers()
      }
    })

    it("a cancel that never settles still lets the timed-out turn clean up and report", async () => {
      // The turn timeout exists for an agent that has stopped responding, and
      // an agent that has stopped draining its stdin leaves `cancel`'s write
      // pending forever. Reporting the timeout must not depend on the peer we
      // just gave up on answering us.
      vi.useFakeTimers()
      try {
        const cancel = vi.fn(() => new Promise<void>(() => undefined))
        let promptStarted: () => void = () => undefined
        const promptStartedSignal = new Promise<void>((resolve) => { promptStarted = resolve })
        let sessionCounter = 0

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory: async () => ({
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: `session-${sessionCounter++}` })),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                if (params.sessionId !== "session-0") {
                  return { stopReason: "end_turn" }
                }
                promptStarted()
                return new Promise<{ stopReason: string }>(() => undefined)
              }),
              cancel,
            }),
            stop: vi.fn(async () => undefined),
          }),
        })
        await adapter.onStarted("Agent", "desc")

        const tools = new FakeTools()
        const onMessage = adapter.onMessage(
          makeMessage("hello", "room-wedged"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-wedged" },
        )
        await promptStartedSignal
        const failed = expectTurnFailed(onMessage)
        await vi.advanceTimersByTimeAsync(1_000)
        await failed

        expect(cancel).toHaveBeenCalledWith({ sessionId: "session-0" })
        expect(findFailureEvent(tools)?.metadata?.failure)
          .toMatchObject({ provider: "acp", code: "timeout" })

        // Cleanup ran too: the wedged session was released, so the next turn
        // in this room opens a new one rather than reusing it.
        await adapter.onMessage(
          makeMessage("again", "room-wedged"),
          new FakeTools(),
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-wedged" },
        )
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(sessionCounter).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a stale turn's own timeout cleanup does not clobber a replacement session that already took over the same room", async () => {
      // The race this guards: something outside this adapter (AgentRuntime,
      // on its own reset path) can tear a stuck room down and let a
      // replacement turn open a fresh session for it before the original,
      // still-hanging turn ever hits its own timeout. That stale timeout's
      // cleanup is keyed by roomId alone and must not blow away the
      // replacement's session just because it shares the same room.
      vi.useFakeTimers()
      try {
        const cancel = vi.fn(async () => undefined)
        let sessionCounter = 0
        const staleHangingPrompt = new Promise<{ stopReason: string }>(() => undefined)
        let staleStarted: () => void = () => undefined
        const staleStartedSignal = new Promise<void>((resolve) => { staleStarted = resolve })

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory: async () => ({
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: `session-${sessionCounter++}` })),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                if (params.sessionId === "session-0") {
                  staleStarted()
                  return staleHangingPrompt
                }
                return { stopReason: "end_turn" }
              }),
              cancel,
            }),
            stop: vi.fn(async () => undefined),
          }),
        })
        await adapter.onStarted("Agent", "desc")

        const staleTurn = adapter.onMessage(
          makeMessage("hello", "room-race"),
          new FakeTools(),
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-race" },
        )
        await staleStartedSignal

        // Simulates the external teardown-and-replace: the stuck room is
        // reset and a replacement execution opens a fresh session for it,
        // both well ahead of the stale turn's own timeout below.
        await adapter.onCleanup("room-race")
        await adapter.onMessage(
          makeMessage("replacement turn", "room-race"),
          new FakeTools(),
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-race" },
        )
        expect(sessionCounter).toBe(2)

        const failed = expectTurnFailed(staleTurn)
        await vi.advanceTimersByTimeAsync(1_000)
        await failed
        expect(cancel).toHaveBeenCalledWith({ sessionId: "session-0" })

        // The replacement's session must still be the one this room resolves
        // to -- a third turn reusing it (no new session created) is the
        // observable proof the stale cleanup didn't delete its mapping.
        await adapter.onMessage(
          makeMessage("third turn", "room-race"),
          new FakeTools(),
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: false, roomId: "room-race" },
        )
        expect(sessionCounter).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a stale turn's timeout flush reads the client it actually streamed through, not one a reconnect installed after it started", async () => {
      // `flushChunks` used to read `this.client` — the *live* client — at
      // cleanup time, rather than the one this turn's session was actually
      // established against. A silent reconnect between "turn starts
      // streaming" and "turn times out" (subprocess crash / stream EOF, the
      // same trigger as the silent-reconnect test above) swaps `this.client`
      // out from under it: the new client never saw this turn's session, so
      // flushing against it silently drops whatever the old client had
      // buffered instead of posting it.
      vi.useFakeTimers()
      try {
        const firstConnectionController = new AbortController()
        let attempt = 0
        let staleStarted: () => void = () => undefined
        const staleStartedSignal = new Promise<void>((resolve) => { staleStarted = resolve })
        const staleHangingPrompt = new Promise<{ stopReason: string }>(() => undefined)

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory: async (client) => {
            attempt += 1
            if (attempt === 1) {
              return {
                connection: fakeConnection({
                  signal: firstConnectionController.signal,
                  newSession: vi.fn(async () => ({ sessionId: "session-stale" })),
                  prompt: vi.fn(async (params: { sessionId: string }) => {
                    await (client as { sessionUpdate(p: Record<string, unknown>): Promise<void> }).sessionUpdate({
                      sessionId: params.sessionId,
                      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "work done before wedging" } },
                    })
                    staleStarted()
                    return staleHangingPrompt
                  }),
                }),
                stop: vi.fn(async () => undefined),
              }
            }
            return {
              connection: fakeConnection({
                newSession: vi.fn(async () => ({ sessionId: "session-fresh" })),
              }),
              stop: vi.fn(async () => undefined),
            }
          },
        })
        await adapter.onStarted("Agent", "desc")

        const staleTools = new FakeTools()
        const staleTurn = adapter.onMessage(
          makeMessage("hello", "room-stale"),
          staleTools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-stale" },
        )
        await staleStartedSignal

        // Connection 1 dies (crash / EOF) while room-stale's turn is still
        // hanging on it — nothing calls adapter.stop().
        firstConnectionController.abort()

        // A different room's turn forces ensureConnection() to reconnect
        // (attempt 2), installing a brand-new `this.client` before
        // room-stale's own timeout ever fires.
        await adapter.onMessage(
          makeMessage("hello", "room-other"),
          new FakeTools(),
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-other" },
        )
        expect(attempt).toBe(2)

        const failed = expectTurnFailed(staleTurn)
        await vi.advanceTimersByTimeAsync(1_000)
        await failed

        // The stale turn's own buffered output — captured on connection 1's
        // client before it was swapped out — must still reach the room.
        expect(staleTools.messages).toEqual(["work done before wedging"])
      } finally {
        vi.useRealTimers()
      }
    })

    it("repeatedly failed turns do not accumulate their sessions' buffered output", async () => {
      // A failed turn used to stop() the adapter, which discarded the whole
      // ACP client along with its buffers. Now the client outlives the turn to
      // keep other rooms up, so per-room cleanup owns discarding what the
      // abandoned session buffered — otherwise every failure leaks a session.
      let acpClient!: {
        sessionUpdate(params: Record<string, unknown>): Promise<void>
        getCollectedChunks(sessionId?: string): unknown[]
      }
      let sessionCounter = 0

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async (client) => {
          acpClient = client as never
          return {
            connection: fakeConnection({
              newSession: vi.fn(async () => ({ sessionId: `session-${sessionCounter++}` })),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                await acpClient.sessionUpdate({
                  sessionId: params.sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } },
                })
                throw new Error("prompt failed")
              }),
            }),
            stop: vi.fn(async () => undefined),
          }
        },
      })
      await adapter.onStarted("Agent", "desc")

      for (let turn = 0; turn < 3; turn++) {
        const tools = new FakeTools()
        await expectTurnFailed(
          adapter.onMessage(
            makeMessage("hello", "room-leak"),
            tools,
            { roomToSession: {} },
            null,
            null,
            { isSessionBootstrap: turn === 0, roomId: "room-leak" },
          ),
        )
        expect(findFailureEvent(tools)?.metadata?.failure)
          .toMatchObject({ provider: "acp", message: "prompt failed" })
      }

      expect(sessionCounter).toBe(3)
      expect(acpClient.getCollectedChunks()).toEqual([])
    })

    it("a concurrent second room's turn is unaffected by another room's timeout, and the shared connection survives", async () => {
      vi.useFakeTimers()
      try {
        let roomAPromptStarted: () => void = () => undefined
        const roomAStarted = new Promise<void>((resolve) => { roomAPromptStarted = resolve })
        const roomAHangingPrompt = new Promise<{ stopReason: string }>(() => undefined)
        let sessionCounter = 0

        const connectionFactory = vi.fn(async () => {
          const controller = new AbortController()
          return {
            connection: fakeConnection({
              signal: controller.signal,
              newSession: vi.fn(async () => ({ sessionId: `session-${sessionCounter++}` })),
              prompt: vi.fn(async (params: { sessionId: string }) => {
                if (params.sessionId === "session-0") {
                  roomAPromptStarted()
                  return roomAHangingPrompt
                }
                return { stopReason: "end_turn" }
              }),
              cancel: vi.fn(async () => undefined),
            }),
            stop: vi.fn(async () => undefined),
          }
        })

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory,
        })

        await adapter.onStarted("Agent", "desc")
        const toolsA = new FakeTools()
        const toolsB = new FakeTools()

        const onMessageA = adapter.onMessage(
          makeMessage("hello A", "room-a"), toolsA, { roomToSession: {} }, null, null,
          { isSessionBootstrap: true, roomId: "room-a" },
        )
        await roomAStarted

        const onMessageB = adapter.onMessage(
          makeMessage("hello B", "room-b"), toolsB, { roomToSession: {} }, null, null,
          { isSessionBootstrap: true, roomId: "room-b" },
        )
        await onMessageB
        const failedA = expectTurnFailed(onMessageA)
        await vi.advanceTimersByTimeAsync(1_000)
        await failedA

        // Only ever one connection established — a stray reconnect here would
        // mean room A's timeout tore down the shared connection.
        expect(connectionFactory).toHaveBeenCalledTimes(1)
        expect(toolsA.events.some((event) =>
          event.messageType === "error"
          && (event.metadata?.failure as Record<string, unknown> | undefined)?.code === "timeout"
        )).toBe(true)
        expect(toolsB.events.some((event) => event.messageType === "task")).toBe(true)
        expect(toolsB.events.some((event) => event.messageType === "error")).toBe(false)
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

    it("a resolved prompt() with a non-end_turn stopReason fails the turn, after flushing any partial content and reporting stopReason as the failure code", async () => {
      let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null
      const prompt = vi.fn(async (params: { sessionId: string }) => {
        await clientHandle?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } },
        })
        return { stopReason: "max_tokens" }
      })

      const adapter = new ACPClientAdapter({
        command: ["acp-agent"],
        enableMcpTools: false,
        connectionFactory: async (client) => {
          clientHandle = client as unknown as typeof clientHandle
          const controller = new AbortController()
          return {
            connection: fakeConnection({
              signal: controller.signal,
              newSession: vi.fn(async () => ({ sessionId: "session-maxtok" })),
              prompt,
            }),
            stop: async () => { controller.abort() },
          }
        },
      })
      await adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      await expectTurnFailed(
        adapter.onMessage(
          makeMessage("hello", "room-maxtok"),
          tools,
          { roomToSession: {} },
          null,
          null,
          { isSessionBootstrap: true, roomId: "room-maxtok" },
        ),
      )

      expect(tools.messages).toEqual(["partial answer"])
      const failureEvent = findFailureEvent(tools)
      expect(failureEvent?.metadata?.failure).toMatchObject({
        provider: "acp",
        code: "max_tokens",
        message: "ACP turn ended with stop reason: max_tokens.",
      })
      // The session survives a non-success stop reason, and this event's
      // metadata is the only thing rehydration rebuilds the mapping from —
      // drive the real converter, so the room does not silently start a fresh
      // session after the next restart.
      expect(
        new ACPClientHistoryConverter().convert(
          tools.events.map((event) => ({ metadata: event.metadata })),
        ).roomToSession,
      ).toEqual({ "room-maxtok": "session-maxtok" })
    })

    it("a late-resolving connection.prompt after a timeout does not post a second event, and frees the session's buffered chunks", async () => {
      vi.useFakeTimers()
      try {
        type LateTestClientHandle = {
          sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
          getCollectedChunks: (sessionId?: string) => unknown[];
        }
        const clientHandleRef: { current: LateTestClientHandle | null } = { current: null }
        let resolvePrompt: (value: { stopReason: string }) => void = () => undefined
        let promptStarted: () => void = () => undefined
        const promptStartedSignal = new Promise<void>((resolve) => { promptStarted = resolve })

        const prompt = vi.fn(async (params: { sessionId: string }) => {
          // Buffer a chunk before the timeout fires, so we can prove it's
          // freed once the abandoned call finally settles.
          await clientHandleRef.current?.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late chunk" } },
          })
          promptStarted()
          return new Promise<{ stopReason: string }>((resolve) => { resolvePrompt = resolve })
        })

        const adapter = new ACPClientAdapter({
          command: ["acp-agent"],
          enableMcpTools: false,
          turnTimeoutMs: 1_000,
          connectionFactory: async (client) => {
            clientHandleRef.current = client as unknown as LateTestClientHandle
            const controller = new AbortController()
            return {
              connection: fakeConnection({
                signal: controller.signal,
                newSession: vi.fn(async () => ({ sessionId: "session-late" })),
                prompt,
                cancel: vi.fn(async () => undefined),
              }),
              stop: vi.fn(async () => undefined),
            }
          },
        })

        await adapter.onStarted("Agent", "desc")
        const tools = new FakeTools()
        const onMessage = adapter.onMessage(
          makeMessage("hello", "room-late"), tools, { roomToSession: {} }, null, null,
          { isSessionBootstrap: true, roomId: "room-late" },
        )
        await promptStartedSignal
        const failed = expectTurnFailed(onMessage)
        await vi.advanceTimersByTimeAsync(1_000)
        await failed

        expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1)
        // Buffered before the timeout fired, so the timeout flushes it on the
        // way out rather than dropping it with the session.
        expect(tools.messages).toEqual(["late chunk"])

        // Now let the abandoned prompt finally resolve, late.
        resolvePrompt({ stopReason: "end_turn" })
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        // No second event or message posted for the same, already-failed turn.
        expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1)
        expect(tools.messages).toEqual(["late chunk"])
        expect(clientHandleRef.current?.getCollectedChunks("session-late")).toEqual([])
      } finally {
        vi.useRealTimers()
      }
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
      // bivariance lets an `async` implementation satisfy it — a bare
      // try/catch around the call alone would only catch a synchronous
      // throw, not this; `GuardedLogger.emit` guards both.
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
        // `unhandledRejection` if the guard didn't actually catch it.
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

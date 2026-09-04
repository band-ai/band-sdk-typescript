import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { hasVisibleContent } from "../src/contracts/content";
import { FakeTools, makeMessage } from "./testUtils";

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

  // Recreates the original trigger sequence against the real send path
  // (AgentTools -> FernRestAdapter), not FakeTools: a status-only
  // `tool_call_update` (no rawOutput, no content) collects as a blank
  // `tool_result` chunk. When flushChunks forwarded that to sendEvent, the
  // platform 422'd, and the rejection escaped the try/catch around
  // `connection.prompt` (the adapter's only one) and killed the runtime — so
  // the turn that produced the blank chunk would answer, but every later turn
  // in the room would not. The fake below 422s exactly like the platform, so
  // the test fails if either guard (flushChunks or FernRestAdapter) is lost.
  it("keeps answering after a status-only tool_call_update collects as a blank event", async () => {
    // Stands in for the platform's own `validate_has_visible_content`: a blank
    // event is a 422, i.e. a rejected promise, not a quiet no-op.
    const createAgentChatEvent = vi.fn(async (_chatId: string, payload: { event: { content: string } }) => {
      if (!hasVisibleContent(payload.event.content)) {
        throw new Error("422 Unprocessable Entity: content can't be blank");
      }
      return { data: { ok: true, id: "evt-1" } };
    });
    const createAgentChatMessage = vi.fn(async (_chatId: string, _payload: { message: { content: string } }) => ({
      data: { ok: true, id: "msg-1" },
    }));
    const rest = new FernRestAdapter({
      agentApiEvents: { createAgentChatEvent },
      agentApiMessages: { createAgentChatMessage },
    });
    const tools = new AgentTools({ roomId: "room-blank-event", rest }).getAdapterTools();

    let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null;
    let turn = 0;
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      turn += 1;
      if (turn === 1) {
        await clientHandle?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } },
        });
        await clientHandle?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "ToolSearch", status: "pending" },
        });
        // Status-only: no rawOutput, no content.
        await clientHandle?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
        });
      } else {
        await clientHandle?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still here" } },
        });
      }
      return { stopReason: "end_turn" };
    });

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async (client) => {
        clientHandle = client as unknown as typeof clientHandle;
        const controller = new AbortController();
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
            newSession: vi.fn(async () => ({ sessionId: "session-blank-event" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort();
          },
        };
      },
    });

    await adapter.onStarted("Blank Event Agent", "blank event test");

    await adapter.onMessage(
      makeMessage("first", "room-blank-event"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-blank-event" },
    );
    await adapter.onMessage(
      makeMessage("second", "room-blank-event"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-blank-event" },
    );

    // The blank tool_result never reached the platform.
    expect(createAgentChatEvent).not.toHaveBeenCalledWith(
      "room-blank-event",
      expect.objectContaining({ event: expect.objectContaining({ content: "" }) }),
      expect.any(Object),
    );
    // And the turn survived it: both messages made it out.
    expect(createAgentChatMessage.mock.calls.map((call) => call[1].message.content)).toEqual([
      "on it",
      "still here",
    ]);
  });

  // Same failure class as the blank-event regression above, but via the "text"
  // branch: unlike sendEvent, AgentTools.sendMessage rejects on a blank-content
  // refusal, and flushChunks runs outside the try/catch around
  // connection.prompt. Without the flushChunks filter, a whitespace-only
  // agent_message_chunk would reach sendMessage and reject onMessage itself,
  // not just skip a room post.
  it("keeps answering after a whitespace-only agent_message_chunk collects as blank text", async () => {
    const createAgentChatMessage = vi.fn(async (_chatId: string, payload: { message: { content: string } }) => {
      if (!hasVisibleContent(payload.message.content)) {
        throw new Error("422 Unprocessable Entity: content can't be blank");
      }
      return { data: { ok: true, id: "msg-1" } };
    });
    const createAgentChatEvent = vi.fn(async () => ({ data: { ok: true, id: "evt-1" } }));
    const rest = new FernRestAdapter({
      agentApiMessages: { createAgentChatMessage },
      agentApiEvents: { createAgentChatEvent },
    });
    const tools = new AgentTools({ roomId: "room-blank-text", rest }).getAdapterTools();

    let clientHandle: { sessionUpdate: (params: Record<string, unknown>) => Promise<void> } | null = null;
    let turn = 0;
    const prompt = vi.fn(async (params: { sessionId: string }) => {
      turn += 1;
      await clientHandle?.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: turn === 1 ? "   " : "still here" },
        },
      });
      return { stopReason: "end_turn" };
    });

    const adapter = new ACPClientAdapter({
      command: ["acp-agent"],
      connectionFactory: async (client) => {
        clientHandle = client as unknown as typeof clientHandle;
        const controller = new AbortController();
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
            newSession: vi.fn(async () => ({ sessionId: "session-blank-text" })),
            prompt,
          } as never,
          stop: async () => {
            controller.abort();
          },
        };
      },
    });

    await adapter.onStarted("Blank Text Agent", "blank text test");

    await expect(adapter.onMessage(
      makeMessage("first", "room-blank-text"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-blank-text" },
    )).resolves.toBeUndefined();

    await adapter.onMessage(
      makeMessage("second", "room-blank-text"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-blank-text" },
    );

    // The blank text chunk never reached the platform.
    expect(createAgentChatMessage).not.toHaveBeenCalledWith(
      "room-blank-text",
      expect.objectContaining({ message: expect.objectContaining({ content: "   " }) }),
      expect.any(Object),
    );
    // And the turn survived it: the second turn's message still made it out.
    expect(createAgentChatMessage.mock.calls.map((call) => call[1].message.content)).toEqual(["still here"]);
  });

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
          clientHandle = client as typeof clientHandle
          const controller = new AbortController()
          return {
            connection: {
              signal: controller.signal,
              closed: new Promise<void>(() => undefined),
              initialize: vi.fn(async () => ({
                protocolVersion: 1,
                agentCapabilities: {},
              })),
              authenticate: vi.fn(async () => ({})),
              loadSession: vi.fn(),
              unstable_resumeSession: vi.fn(),
              newSession: vi.fn(async () => ({ sessionId: "session-1" })),
              prompt,
            } as never,
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
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
});

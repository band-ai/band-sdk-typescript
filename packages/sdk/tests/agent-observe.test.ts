import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type PromptRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent } from "../src/contracts/events";
import { MCP_SERVER_NAME } from "../src/contracts/toolSchemas";
import { createDeferred } from "../src/core/deferred";
import { BandLink } from "../src/platform/BandLink";
import { WebSocketDisconnectError, type WebSocketDisconnectReason } from "../src/platform/streaming/disconnectReason";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person, type BandRoom } from "./flows/support/bandPlatform";
import { codexNamedBandTool, cursorLateNamedBandTool } from "./fixtures/providerTraces";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

const ROOM = "room-1";

const TERMINAL_REASON = {
  source: "agent_control",
  code: "session.already_connected",
  message: "superseded",
  retryable: false,
  retryAfter: null,
  targetSocketId: null,
  correlationId: null,
} satisfies WebSocketDisconnectReason;

/** Claude Code's ACP bridge on one Bash call, as recorded: the call arrives twice, first with no input, and its title is display copy. */
const CLAUDE_BASH_CALL: SessionUpdate[] = [
  { sessionUpdate: "tool_call", toolCallId: "toolu_01", _meta: { claudeCode: { toolName: "Bash" } }, rawInput: {}, status: "pending", title: "Terminal", kind: "execute", content: [] },
  {
    sessionUpdate: "tool_call", toolCallId: "toolu_01", _meta: { claudeCode: { toolName: "Bash" } },
    rawInput: { command: "echo hi", description: "Print \"hi\" to stdout" }, status: "pending", title: "`echo hi`", kind: "execute",
    content: [{ type: "content", content: { type: "text", text: "Print \"hi\" to stdout" } }],
  },
  {
    sessionUpdate: "tool_call_update", toolCallId: "toolu_01",
    _meta: { claudeCode: { toolName: "Bash", toolResponse: { stdout: "hi", stderr: "", interrupted: false, isImage: false, noOutputExpected: false } } },
  },
  {
    sessionUpdate: "tool_call_update", toolCallId: "toolu_01", _meta: { claudeCode: { toolName: "Bash" } },
    status: "completed", rawOutput: "hi", content: [{ type: "content", content: { type: "text", text: "hi" } }],
  },
];

/** The Copilot CLI's shape, as recorded: no bridge tool name, a sentence for a title, and a denied call. */
const COPILOT_DENIED_CALL: SessionUpdate[] = [
  {
    sessionUpdate: "tool_call", toolCallId: "call_01", title: "Run the requested shell command and capture its output", kind: "execute", status: "pending",
    rawInput: { command: "echo hi", description: "Run the requested shell command and capture its output", mode: "sync", initial_wait: 10 },
  },
  { sessionUpdate: "tool_call_update", toolCallId: "call_01", status: "failed", rawOutput: { message: "Denied by a preToolUse hook", code: "denied" } },
];

/** A call that genuinely takes no input: its only call frame is empty. */
const EMPTY_INPUT_CALL: SessionUpdate[] = [
  { sessionUpdate: "tool_call", toolCallId: "call_02", title: "Listing the workspace", kind: "read", status: "pending", rawInput: {} },
  { sessionUpdate: "tool_call_update", toolCallId: "call_02", status: "completed", rawOutput: "notes.md" },
];

/** A real ACP agent behind the adapter; each prompt runs `onPrompt`. */
function acpAdapter(
  onPrompt: (peer: AgentSideConnection, request: PromptRequest) => Promise<{ stopReason: "end_turn" | "cancelled" }>,
  options: Partial<ACPClientAdapterOptions> = {},
) {
  return new ACPClientAdapter({
    command: ["acp-fixture"],
    cwd: tmpRoot(),
    enableMcpTools: false,
    connectionFactory: inMemoryAgent((peer): AcpAgent => ({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      authenticate: async () => ({}),
      newSession: async () => ({ sessionId: "session-1" }),
      cancel: async () => {},
      prompt: (request) => onPrompt(peer, request),
    })),
    ...options,
  });
}

/** One turn's worth of agent output: a thought, a tool call and its result, then the reply. */
async function workThenAnswer(peer: AgentSideConnection, sessionId: string, beforeAnswer: () => Promise<void> = async () => {}) {
  await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "weighing the options" } } });
  await peer.sessionUpdate({ sessionId, update: {
    sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read notes.md", kind: "read", status: "in_progress", rawInput: { path: "notes.md" },
  } });
  await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "three notes" } });
  await beforeAnswer();
  await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Found three notes." } } });
  return { stopReason: "end_turn" as const };
}

async function startAgent(adapter: ACPClientAdapter, { observe = true }: { observe?: boolean } = {}) {
  const platform = BandPlatform.host([person("owner")]);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
  });
  const events: AgentEvent[] = [];
  if (observe) {
    agent.observe((event) => { events.push(event); });
  }
  await agent.start();
  onTestFinished(async () => { if (agent.isRunning) await agent.stop(); });
  return { agent, platform, events, room: await platform.room(ROOM) };
}

const posted = (room: BandRoom) => room.posted.map(({ messageType, content }) => [messageType, content]);
const ofTypes = (events: AgentEvent[], ...types: AgentEvent["type"][]) => events.filter((event) => types.includes(event.type));

describe("Agent.observe", () => {
  it("reports an ACP turn's thought and tool call locally, before and without posting anything for them", async () => {
    const observed = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const { agent, events, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId, async () => {
      await observed.promise;
      await release.promise;
    })));
    agent.observe((event) => { if (event.type === "tool.result") observed.resolve(); });

    const message = await room.say("owner", "what is in my notes?");
    await observed.promise;
    expect(ofTypes(events, "thought", "tool.call", "tool.result")).toEqual([
      { type: "thought", roomId: ROOM, text: "weighing the options" },
      { type: "tool.call", roomId: ROOM, toolCallId: "call-1", name: "read", kind: "read", input: { path: "notes.md" } },
      { type: "tool.result", roomId: ROOM, toolCallId: "call-1", status: "completed", output: "three notes" },
    ]);
    expect(room.posted, "observing posted nothing").toEqual([]);

    release.resolve();
    expect(await room.outcome(message)).toBe("processed");
    expect(ofTypes(events, "turn.started", "message", "turn.completed")).toEqual([
      { type: "turn.started", roomId: ROOM, messageId: message },
      { type: "message", roomId: ROOM, text: "Found three notes." },
      { type: "turn.completed", roomId: ROOM, messageId: message },
    ]);
    expect(ofTypes(events, "room.joined", "link.connected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "room.joined", roomId: ROOM },
    ]);
  });

  it("leaves what the room sees unchanged", async () => {
    const turn = async (observe: boolean) => {
      const { room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)), { observe });
      expect(await room.outcome(await room.say("owner", "what is in my notes?"))).toBe("processed");
      return posted(room);
    };
    expect(await turn(true)).toEqual(await turn(false));
  });

  it("keeps a turn and the other listeners going when one listener throws or rejects", async () => {
    const { agent, events, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    agent.observe(() => { throw new Error("listener bug"); });
    agent.observe(async () => { throw new Error("async listener bug"); });
    const later: AgentEvent[] = [];
    agent.observe((event) => { later.push(event); });

    const message = await room.say("owner", "what is in my notes?");
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.map((entry) => entry.content)).toEqual(["Found three notes."]);
    for (const seen of [events, later]) {
      expect(ofTypes(seen, "turn.started", "thought", "tool.call", "tool.result", "turn.completed").map((event) => event.type))
        .toEqual(["turn.started", "thought", "tool.call", "tool.result", "turn.completed"]);
    }
  });

  it("stops delivering to a listener once it is removed", async () => {
    const { agent, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    const seen: AgentEvent[] = [];
    const stop = agent.observe((event) => { seen.push(event); });

    expect(await room.outcome(await room.say("owner", "first"))).toBe("processed");
    const before = seen.length;
    expect(before).toBeGreaterThan(0);
    stop();
    expect(await room.outcome(await room.say("owner", "second"))).toBe("processed");
    expect(seen).toHaveLength(before);
  });

  it("reports a permission request and its answer", async () => {
    const adapter = acpAdapter(async (peer, { sessionId }) => {
      await peer.requestPermission({
        sessionId,
        toolCall: { toolCallId: "edit-1", title: "Edit notes.md", name: "Edit", kind: "edit" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
      });
      return workThenAnswer(peer, sessionId);
    }, { resolvePermission: async () => "allow" });
    const { events, room } = await startAgent(adapter);

    expect(await room.outcome(await room.say("owner", "edit my notes"))).toBe("processed");
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([
      {
        type: "approval.requested",
        roomId: ROOM,
        toolCallId: "edit-1",
        toolName: "Edit",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      },
      { type: "approval.resolved", roomId: ROOM, toolCallId: "edit-1", outcome: "selected", optionId: "allow" },
    ]);
  });

  it("reports approval.resolved cancelled when cancelTurn runs while permission is pending", async () => {
    const asked = createDeferred();
    const adapter = acpAdapter(async (peer, { sessionId }) => {
      await peer.requestPermission({
        sessionId,
        toolCall: { toolCallId: "edit-1", title: "Edit notes.md", name: "Edit", kind: "edit" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
      });
      return { stopReason: "cancelled" as const };
    }, {
      resolvePermission: (_request, signal) => {
        const answer = createDeferred<string | undefined>();
        signal.addEventListener("abort", () => answer.resolve(undefined));
        asked.resolve();
        return answer.promise;
      },
    });
    const { agent, events, room } = await startAgent(adapter);

    const message = await room.say("owner", "edit my notes");
    await asked.promise;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(message)).toBe("processed");
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([
      {
        type: "approval.requested",
        roomId: ROOM,
        toolCallId: "edit-1",
        toolName: "Edit",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      },
      { type: "approval.resolved", roomId: ROOM, toolCallId: "edit-1", outcome: "cancelled" },
    ]);
  });

  it("reports a turn the adapter fails", async () => {
    const { events, room } = await startAgent(acpAdapter(async () => { throw new Error("agent crashed"); }));
    const message = await room.say("owner", "hello");
    expect(await room.outcome(message)).toBe("failed");
    expect(ofTypes(events, "turn.started", "turn.completed", "turn.failed")).toEqual([
      { type: "turn.started", roomId: ROOM, messageId: message },
      // ACP carries the agent's throw as a wire "Internal error"; the event mirrors the room's failure label.
      { type: "turn.failed", roomId: ROOM, messageId: message, error: "Internal error" },
    ]);
  });

  it("reports a room whose agent process cannot start", async () => {
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: async () => { throw new Error("acp-fixture: command not found"); },
    });
    const { events, room } = await startAgent(adapter);
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("failed");
    expect(ofTypes(events, "room.failed")).toEqual([
      { type: "room.failed", roomId: ROOM, error: expect.stringContaining("command not found") },
    ]);
  });

  it("reports process exit as room.failed, and a reused toolCallId still as tool.call", async () => {
    let kill = () => {};
    let prompts = 0;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: async (client) => {
        let closeOutgoing!: () => void;
        let closeIncoming!: () => void;
        const outgoing = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeOutgoing = () => controller.terminate(); } });
        const incoming = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeIncoming = () => controller.terminate(); } });
        const peer = new AgentSideConnection((served): AcpAgent => ({
          initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
          authenticate: async () => ({}),
          newSession: async () => ({ sessionId: `session-${prompts + 1}` }),
          cancel: async () => {},
          prompt: async ({ sessionId }) => {
            prompts += 1;
            await served.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "reuse-1",
                title: "Run echo",
                kind: "execute",
                status: "pending",
                rawInput: { command: "echo hi" },
              },
            });
            if (prompts === 1) {
              kill();
              await new Promise(() => {});
            }
            await served.sessionUpdate({
              sessionId,
              update: { sessionUpdate: "tool_call_update", toolCallId: "reuse-1", status: "completed", rawOutput: "hi" },
            });
            await served.sessionUpdate({
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
            });
            return { stopReason: "end_turn" };
          },
        }), ndJsonStream(incoming.writable, outgoing.readable));
        const connection = new ClientSideConnection(() => client, ndJsonStream(outgoing.writable, incoming.readable));
        kill = () => { closeOutgoing(); closeIncoming(); };
        return {
          connection,
          stop: async () => {
            closeOutgoing();
            closeIncoming();
            await Promise.all([connection.closed, peer.closed]);
          },
        };
      },
    });
    const { events, room } = await startAgent(adapter);

    const first = await room.say("owner", "run it");
    await vi.waitFor(() => {
      expect(ofTypes(events, "room.failed")).toEqual([
        { type: "room.failed", roomId: ROOM, error: "The ACP agent process exited" },
      ]);
    });
    expect(await room.outcome(first)).toBe("failed");
    expect(ofTypes(events, "tool.call")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
    ]);

    expect(await room.outcome(await room.say("owner", "run it again"))).toBe("processed");
    expect(ofTypes(events, "tool.call")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
    ]);
  });

  it("reports leaving a room, and the link closing when the agent stops", async () => {
    const { agent, events, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");

    await room.remove();
    await room.left();
    await agent.stop();
    expect(ofTypes(events, "room.joined", "room.stopped", "room.left", "link.connected", "link.disconnected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "room.joined", roomId: ROOM },
      { type: "room.stopped", roomId: ROOM },
      { type: "room.left", roomId: ROOM },
      { type: "link.disconnected", reason: "closed" },
    ]);
  });

  it("reports link dropped, reconnected, and terminal", async () => {
    const { events, platform } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    expect(ofTypes(events, "link.connected")).toEqual([{ type: "link.connected", reconnected: false }]);

    platform.transport.triggerDrop();
    expect(ofTypes(events, "link.disconnected")).toEqual([{ type: "link.disconnected", reason: "dropped" }]);

    await platform.transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set(platform.transport.bound.entries),
    });
    expect(ofTypes(events, "link.connected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "link.connected", reconnected: true },
    ]);

    platform.transport.terminate(new WebSocketDisconnectError(TERMINAL_REASON));
    expect(ofTypes(events, "link.disconnected")).toEqual([
      { type: "link.disconnected", reason: "dropped" },
      { type: "link.disconnected", reason: "terminal" },
    ]);
  });

  it("reports only terminal when the link disconnects after a terminal down", async () => {
    const { agent, events, platform } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    platform.transport.terminate(new WebSocketDisconnectError(TERMINAL_REASON));
    await agent.stop();
    expect(ofTypes(events, "link.disconnected")).toEqual([
      { type: "link.disconnected", reason: "terminal" },
    ]);
  });

  it.each([
    {
      bridge: "Claude Code's",
      frames: CLAUDE_BASH_CALL,
      call: { toolCallId: "toolu_01", name: "Bash", kind: "execute", input: { command: "echo hi", description: "Print \"hi\" to stdout" } },
      result: { toolCallId: "toolu_01", status: "completed", output: "hi" },
    },
    {
      bridge: "Copilot's",
      frames: COPILOT_DENIED_CALL,
      call: {
        toolCallId: "call_01",
        name: "execute",
        kind: "execute",
        input: { command: "echo hi", description: "Run the requested shell command and capture its output", mode: "sync", initial_wait: 10 },
      },
      result: { toolCallId: "call_01", status: "failed", output: JSON.stringify({ message: "Denied by a preToolUse hook", code: "denied" }) },
    },
    {
      bridge: "an input-less",
      frames: EMPTY_INPUT_CALL,
      call: { toolCallId: "call_02", name: "read", kind: "read" },
      result: { toolCallId: "call_02", status: "completed", output: "notes.md" },
    },
    {
      bridge: "Cursor's",
      frames: cursorLateNamedBandTool("cursor-1"),
      call: {
        toolCallId: "cursor-1",
        name: `${MCP_SERVER_NAME}-band_send_message`,
        kind: "other",
        input: { providerIdentifier: MCP_SERVER_NAME, toolName: "band_send_message", args: { content: "hi" } },
      },
      result: { toolCallId: "cursor-1", status: "completed", output: "{}" },
    },
    {
      bridge: "Codex's",
      frames: codexNamedBandTool("codex-1"),
      call: {
        toolCallId: "codex-1",
        name: `${MCP_SERVER_NAME}-band_send_message`,
        input: { server: MCP_SERVER_NAME, tool: "band_send_message", arguments: {} },
      },
      result: { toolCallId: "codex-1", status: "completed", output: "{}" },
    },
  ])("reports $bridge recorded tool call once, by its tool name or kind and never its title", async ({ frames, call, result }) => {
    const { events, room } = await startAgent(acpAdapter(async (peer, { sessionId }) => {
      for (const update of frames) await peer.sessionUpdate({ sessionId, update });
      await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
      return { stopReason: "end_turn" };
    }));

    expect(await room.outcome(await room.say("owner", "run it"))).toBe("processed");
    expect(ofTypes(events, "tool.call", "tool.result")).toEqual([
      { type: "tool.call", roomId: ROOM, ...call },
      { type: "tool.result", roomId: ROOM, ...result },
    ]);
  });

  it("ignores a duplicate terminal tool_call_update after tool.result", async () => {
    const frames: SessionUpdate[] = [
      { sessionUpdate: "tool_call", toolCallId: "dup-1", title: "Read notes.md", kind: "read", status: "pending", rawInput: { path: "notes.md" } },
      { sessionUpdate: "tool_call_update", toolCallId: "dup-1", status: "completed", rawOutput: "notes" },
      { sessionUpdate: "tool_call_update", toolCallId: "dup-1", status: "completed", rawOutput: "notes again" },
    ];
    const { events, room } = await startAgent(acpAdapter(async (peer, { sessionId }) => {
      for (const update of frames) await peer.sessionUpdate({ sessionId, update });
      await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
      return { stopReason: "end_turn" };
    }));

    expect(await room.outcome(await room.say("owner", "run it"))).toBe("processed");
    expect(ofTypes(events, "tool.call", "tool.result")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "dup-1", name: "read", kind: "read", input: { path: "notes.md" } },
      { type: "tool.result", roomId: ROOM, toolCallId: "dup-1", status: "completed", output: "notes" },
    ]);
  });
});

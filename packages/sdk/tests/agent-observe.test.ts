import {
  AgentSideConnection,
  type Agent as AcpAgent,
  type PromptRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentContactsTopic, agentRoomsTopic, chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { CursorACPAdapter } from "../src/adapters/cursor-acp";
import { CURSOR_PROJECT_CONFIG } from "../src/adapters/cursor-acp/permissions";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { DEFAULT_WORKSPACE_DIRECTORY } from "../src/adapters/shared/roomWorkspace";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent, AgentEventListener } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
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

/** ACP lets a call arrive already finished: one `tool_call` frame with its status and output. */
const ONE_FRAME_CALL: SessionUpdate[] = [
  { sessionUpdate: "tool_call", toolCallId: "call_03", title: "Read notes.md", kind: "read", status: "completed", rawInput: { path: "notes.md" }, rawOutput: "three notes" },
];

const RUN_ECHO_CALL: SessionUpdate = {
  sessionUpdate: "tool_call", toolCallId: "reuse-1", title: "Run echo", kind: "execute", status: "pending", rawInput: { command: "echo hi" },
};

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

/** An agent on `platform`, not yet started; `events` is everything it reports, when `observe`. */
function createAgent(adapter: FrameworkAdapter, platform: BandPlatform, { observe = true }: { observe?: boolean } = {}) {
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
  onTestFinished(async () => { if (agent.isRunning) await agent.stop(); });
  return { agent, events };
}

async function startAgent(adapter: FrameworkAdapter, options: { observe?: boolean } = {}) {
  const platform = BandPlatform.host([person("owner")]);
  const { agent, events } = createAgent(adapter, platform, options);
  await agent.start();
  return { agent, platform, events, room: await platform.room(ROOM) };
}

/** Resolves with the next event `agent` reports of `type`, in `roomId` when given. */
function nextEvent<T extends AgentEvent["type"]>(agent: Agent, type: T, roomId?: string): Promise<Extract<AgentEvent, { type: T }>> {
  const seen = createDeferred<Extract<AgentEvent, { type: T }>>();
  const stop = agent.observe((event) => {
    if (event.type === type && (roomId === undefined || ("roomId" in event && event.roomId === roomId))) {
      stop();
      seen.resolve(event as Extract<AgentEvent, { type: T }>);
    }
  });
  return seen.promise;
}

/** What the room sees of one `workThenAnswer` turn, as on a build without `observe`. */
const POSTED_FOR_WORK_THEN_ANSWER = [
  ["thought", "weighing the options"],
  ["tool_call", "Read notes.md"],
  ["tool_result", "three notes"],
  ["text", "Found three notes."],
  ["task", "ACP client session"],
];

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

  it.each([true, false])("posts the turn to the room as it always has, observed: %s", async (observe) => {
    const { room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)), { observe });
    expect(await room.outcome(await room.say("owner", "what is in my notes?"))).toBe("processed");
    expect(posted(room)).toEqual(POSTED_FOR_WORK_THEN_ANSWER);
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

  it("answers a permission request cancelled at once when a listener cancels the turn on approval.requested", async () => {
    let asked = 0;
    const answered = createDeferred<string>();
    const adapter = acpAdapter(async (peer, { sessionId }) => {
      const { outcome } = await peer.requestPermission({
        sessionId,
        toolCall: { toolCallId: "edit-1", title: "Edit notes.md", name: "Edit", kind: "edit" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }],
      });
      answered.resolve(outcome.outcome);
      return { stopReason: "cancelled" as const };
    }, { resolvePermission: async () => { asked += 1; return "allow"; } });
    const { agent, events, room } = await startAgent(adapter);
    let cancelled: Promise<boolean> | undefined;
    agent.observe((event) => {
      if (event.type === "approval.requested") cancelled = agent.cancelTurn(ROOM);
    });

    const message = await room.say("owner", "edit my notes");
    expect(await answered.promise).toBe("cancelled");
    expect(await cancelled).toBe(true);
    expect(await room.outcome(message)).toBe("processed");
    // Cancelled before anyone was asked: the host is not asked and the room is not told.
    expect({ asked, posted: posted(room) }).toEqual({ asked: 0, posted: [] });
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([
      expect.objectContaining({ type: "approval.requested", toolCallId: "edit-1" }),
      { type: "approval.resolved", roomId: ROOM, toolCallId: "edit-1", outcome: "cancelled" },
    ]);
  });

  it("reports a permission request cancelled when resolvePermission rejects", async () => {
    const adapter = acpAdapter(async (peer, { sessionId }) => {
      const answer = await peer.requestPermission({
        sessionId,
        toolCall: { toolCallId: "edit-1", title: "Edit notes.md", name: "Edit", kind: "edit" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }],
      });
      expect(answer.outcome).toEqual({ outcome: "cancelled" });
      return workThenAnswer(peer, sessionId);
    }, { resolvePermission: async () => { throw new Error("approval UI unavailable"); } });
    const { events, room } = await startAgent(adapter);

    expect(await room.outcome(await room.say("owner", "edit my notes"))).toBe("processed");
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([
      {
        type: "approval.requested",
        roomId: ROOM,
        toolCallId: "edit-1",
        toolName: "Edit",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
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

  it("marks a failed turn with its error's own message, and reports that same label", async () => {
    const { events, room } = await startAgent(new GenericAdapter(async ({ tools }) => {
      await tools.sendMessage("On it.", ["owner"]);
    }));
    const refused = room.holdMessage((content) => content === "On it.", { error: new Error("platform unavailable") });

    const message = await room.say("owner", "hello");
    await refused.sending;
    refused.release();
    expect(await room.outcome(message)).toBe("failed");
    // The reply's delivery failure carries its cause; the label is still only the message, as before observe.
    expect(room.failureLabels(message)).toEqual(["platform unavailable"]);
    expect(ofTypes(events, "turn.failed")).toEqual([
      { type: "turn.failed", roomId: ROOM, messageId: message, error: "platform unavailable" },
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

  it("reports a room whose engine cannot start in its workspace", async () => {
    const root = tmpRoot();
    const config = join(root, DEFAULT_WORKSPACE_DIRECTORY, ROOM, CURSOR_PROJECT_CONFIG);
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, "{ allow: ");
    const adapter = new CursorACPAdapter({
      cwd: root,
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      })),
    });
    const { events, room } = await startAgent(adapter);

    expect(await room.outcome(await room.say("owner", "hello"))).toBe("failed");
    expect(ofTypes(events, "room.failed")).toEqual([
      { type: "room.failed", roomId: ROOM, error: expect.stringContaining("is not valid JSON") },
    ]);
  });

  it("reports a room whose workspace another room already holds", async () => {
    const shared = join(tmpRoot(), "shared");
    const adapter = acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId), { cwd: undefined, workspaceForRoom: () => shared });
    const { events, platform, room } = await startAgent(adapter);
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");

    const other = await platform.room("room-2");
    expect(await other.outcome(await other.say("owner", "hello"))).toBe("failed");
    expect(ofTypes(events, "room.failed")).toEqual([
      { type: "room.failed", roomId: "room-2", error: expect.stringContaining("already in use by room room-1") },
    ]);
  });

  it("does not report room.failed for a room removed while its agent process is still handshaking", async () => {
    const initializing = createDeferred();
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => ({
        initialize: () => { initializing.resolve(); return new Promise(() => {}); },
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      })),
    });
    const { agent, events, room } = await startAgent(adapter);

    await room.say("owner", "hello");
    await initializing.promise;
    await room.remove();
    await room.left();
    await agent.stop();
    expect(ofTypes(events, "room.failed", "room.stopped", "room.left")).toEqual([
      { type: "room.stopped", roomId: ROOM },
      { type: "room.left", roomId: ROOM },
    ]);
  });

  it("reports process exit as room.failed, and a reused toolCallId still as tool.call", async () => {
    let prompts = 0;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((served, exit): AcpAgent => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: `session-${prompts + 1}` }),
        cancel: async () => {},
        prompt: async ({ sessionId }) => {
          prompts += 1;
          await served.sessionUpdate({ sessionId, update: RUN_ECHO_CALL });
          if (prompts === 1) {
            exit();
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
      })),
    });
    const { agent, events, room } = await startAgent(adapter);
    const failed = nextEvent(agent, "room.failed");

    const first = await room.say("owner", "run it");
    await failed;
    expect(await room.outcome(first)).toBe("failed");
    expect(ofTypes(events, "room.failed")).toEqual([
      { type: "room.failed", roomId: ROOM, error: "The ACP agent process exited" },
    ]);
    expect(ofTypes(events, "tool.call")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
    ]);

    expect(await room.outcome(await room.say("owner", "run it again"))).toBe("processed");
    expect(ofTypes(events, "tool.call")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
      { type: "tool.call", roomId: ROOM, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } },
    ]);
  });

  it("keeps one room's process exit to that room while another room's tool call runs on", async () => {
    const OTHER = "room-2";
    const otherReleased = createDeferred();
    onTestFinished(() => otherReleased.resolve());
    let exited = false;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((served, exit): AcpAgent => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        authenticate: async () => ({}),
        // Each room's process runs in that room's own workspace.
        newSession: async ({ cwd }) => ({ sessionId: basename(cwd) }),
        cancel: async () => {},
        prompt: async ({ sessionId }) => {
          // Both rooms use the same toolCallId, so a reset leaking across rooms would show.
          await served.sessionUpdate({ sessionId, update: RUN_ECHO_CALL });
          if (sessionId === ROOM && !exited) {
            exited = true;
            exit();
            await new Promise(() => {});
          }
          if (sessionId === OTHER) await otherReleased.promise;
          await served.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "reuse-1", status: "completed", rawOutput: sessionId } });
          await served.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
          return { stopReason: "end_turn" };
        },
      })),
    });
    const { agent, events, platform, room } = await startAgent(adapter);
    const other = await platform.room(OTHER);

    const otherCalled = nextEvent(agent, "tool.call", OTHER);
    const pending = await other.say("owner", "run it there");
    await otherCalled;
    const failed = nextEvent(agent, "room.failed");
    const crashed = await room.say("owner", "run it here");
    await failed;
    expect(await room.outcome(crashed)).toBe("failed");

    otherReleased.resolve();
    expect(await other.outcome(pending)).toBe("processed");
    expect(await room.outcome(await room.say("owner", "run it here again"))).toBe("processed");

    expect(ofTypes(events, "room.failed")).toEqual([
      { type: "room.failed", roomId: ROOM, error: "The ACP agent process exited" },
    ]);
    const call = (roomId: string) => ({ type: "tool.call", roomId, toolCallId: "reuse-1", name: "execute", kind: "execute", input: { command: "echo hi" } });
    const result = (roomId: string) => ({ type: "tool.result", roomId, toolCallId: "reuse-1", status: "completed", output: roomId });
    expect(ofTypes(events, "tool.call", "tool.result")).toEqual([
      call(OTHER),
      call(ROOM),
      result(OTHER),
      call(ROOM),
      result(ROOM),
    ]);
  });

  it("reports leaving a room, and the link closing when the agent stops", async () => {
    const { agent, events, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");

    await room.remove();
    await room.left();
    await agent.stop();
    // No room.failed: retiring a live process is not the process exiting on its own.
    expect(ofTypes(events, "room.joined", "room.stopped", "room.left", "room.failed", "link.connected", "link.disconnected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "room.joined", roomId: ROOM },
      { type: "room.stopped", roomId: ROOM },
      { type: "room.left", roomId: ROOM },
      { type: "link.disconnected", reason: "closed" },
    ]);
  });

  it("reports a room it still belongs to as stopped, not left, when the agent stops", async () => {
    const { agent, events, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");

    await agent.stop();
    expect(ofTypes(events, "room.joined", "room.stopped", "room.left", "room.failed", "link.connected", "link.disconnected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "room.joined", roomId: ROOM },
      { type: "room.stopped", roomId: ROOM },
      { type: "link.disconnected", reason: "closed" },
    ]);
  });

  it("reports a room stopped once when a session reset and a removal overlap", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const { agent, events, room } = await startAgent(new GenericAdapter(async ({ tools }) => {
      entered.resolve();
      await release.promise;
      tools.turn.settle();
    }));

    const message = await room.say("owner", "hello");
    await entered.promise;
    const reset = agent.resetRoomSession(ROOM);
    await room.remove();
    release.resolve();
    await reset;
    await room.left();
    await agent.stop();
    // The turn in flight across both still ends exactly once.
    expect(ofTypes(events, "turn.started", "turn.completed", "turn.failed", "room.stopped", "room.left")).toEqual([
      { type: "turn.started", roomId: ROOM, messageId: message },
      { type: "turn.completed", roomId: ROOM, messageId: message },
      { type: "room.stopped", roomId: ROOM },
      { type: "room.left", roomId: ROOM },
    ]);
  });

  it("reports no turn for a message still queued when its room is removed", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const { agent, events, platform, room } = await startAgent(new GenericAdapter(async ({ message, tools }) => {
      if (message.content === "first") {
        entered.resolve();
        await release.promise;
      }
      tools.turn.settle();
    }));

    const first = await room.say("owner", "first");
    await entered.promise;
    await room.say("owner", "second");
    // Rooms' events are dispatched in order, so this turn starting means "second" is queued.
    const other = await platform.room("room-2");
    const otherStarted = nextEvent(agent, "turn.started", other.id);
    await other.say("owner", "elsewhere");
    await otherStarted;
    await room.remove();
    await room.left();
    release.resolve();
    await agent.stop();

    expect(ofTypes(events, "turn.started", "turn.completed", "turn.failed").filter((event) => "roomId" in event && event.roomId === ROOM)).toEqual([
      { type: "turn.started", roomId: ROOM, messageId: first },
      { type: "turn.completed", roomId: ROOM, messageId: first },
    ]);
  });

  it("reports the room joined again when its handling resumes after a reset", async () => {
    const { agent, events, room } = await startAgent(new GenericAdapter(async ({ tools }) => { tools.turn.settle(); }));
    const first = await room.say("owner", "first");
    expect(await room.outcome(first)).toBe("processed");

    await agent.resetRoomSession(ROOM);
    const second = await room.say("owner", "second");
    expect(await room.outcome(second)).toBe("processed");

    expect(ofTypes(events, "room.joined", "room.stopped", "turn.started", "turn.completed")).toEqual([
      { type: "room.joined", roomId: ROOM },
      { type: "turn.started", roomId: ROOM, messageId: first },
      { type: "turn.completed", roomId: ROOM, messageId: first },
      { type: "room.stopped", roomId: ROOM },
      { type: "room.joined", roomId: ROOM },
      { type: "turn.started", roomId: ROOM, messageId: second },
      { type: "turn.completed", roomId: ROOM, messageId: second },
    ]);
  });

  it("reports leaving a room even when the adapter's cleanup for it throws", async () => {
    class CleanupFailsAdapter extends GenericAdapter {
      public override async onCleanup(): Promise<void> {
        throw new Error("cleanup failed");
      }
    }
    const { agent, events, room } = await startAgent(new CleanupFailsAdapter(async ({ tools }) => { tools.turn.settle(); }));
    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");
    const ended = agent.runForever();

    await room.remove();
    // The cleanup failure still fails the agent, as it did before observe.
    await expect(ended).rejects.toThrow("cleanup failed");
    await expect(agent.stop()).rejects.toThrow("cleanup failed");
    expect(ofTypes(events, "room.stopped", "room.left")).toEqual([
      { type: "room.stopped", roomId: ROOM },
      { type: "room.left", roomId: ROOM },
    ]);
  });

  it("reports a room gone from Band's list after a reconnect as stopped then left, and rejoins none still listed", async () => {
    const { events, platform, room } = await startAgent(new GenericAdapter(async ({ tools }) => { tools.turn.settle(); }));
    const gone = await platform.room("room-2");

    platform.transport.triggerDrop();
    platform.rest.removeRoom(gone.id);
    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });
    // Queued behind the reconnect, so its turn runs only once the reconcile finished.
    expect(await room.outcome(await room.say("owner", "still here"))).toBe("processed");

    expect(ofTypes(events, "room.joined", "room.stopped", "room.left")).toEqual([
      { type: "room.joined", roomId: ROOM },
      { type: "room.joined", roomId: gone.id },
      { type: "room.stopped", roomId: gone.id },
      { type: "room.left", roomId: gone.id },
    ]);
  });

  it("reports a contact hub room joined once when Band announces it after its first turn", async () => {
    const platform = BandPlatform.host([person("owner")]);
    const announce = platform.rest.onRoomCreated!;
    const created = createDeferred<string>();
    // Band's push of the new hub room is held, so its first turn runs before admission.
    platform.rest.onRoomCreated = (roomId) => created.resolve(roomId);
    const hubTurn = createDeferred();
    const agent = Agent.create({
      adapter: new GenericAdapter(async ({ tools }) => { hubTurn.resolve(); tools.turn.settle(); }),
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
      contactConfig: { strategy: "hub_room", hubTaskId: "contacts" },
    });
    const events: AgentEvent[] = [];
    agent.observe((event) => { events.push(event); });
    onTestFinished(async () => { if (agent.isRunning) await agent.stop(); });
    await agent.start();

    await platform.transport.emit(agentContactsTopic(AGENT_ID), "contact_request_received", {
      id: "request-1", from_handle: "alice", from_name: "Alice", message: "Hello", status: "pending", inserted_at: new Date().toISOString(),
    });
    const hub = await created.promise;
    await hubTurn.promise;
    announce(hub);
    // Queued behind the announce, so once it is handled the admission was too.
    const room = platform.created(hub);
    expect(await room.outcome(await platform.post(hub, "owner", "hello"))).toBe("processed");
    await agent.stop();

    expect(ofTypes(events, "room.joined")).toEqual([{ type: "room.joined", roomId: hub }]);
  });

  it("reports a room joined once when Band announces it again", async () => {
    const { events, platform, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    await platform.room(ROOM);

    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");
    expect(ofTypes(events, "room.joined")).toEqual([{ type: "room.joined", roomId: ROOM }]);
  });

  it("reports a room joined once when Band announces it while startup is already joining it", async () => {
    const platform = BandPlatform.host([person("owner")]);
    platform.rest.addRoom(ROOM);
    const releaseJoin = platform.transport.gateJoin(chatRoomTopic(ROOM));
    const { agent, events } = createAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)), platform);

    const starting = agent.start();
    await platform.transport.bound.until(() => platform.transport.hasTopic(agentRoomsTopic(AGENT_ID)));
    const room = await platform.room(ROOM);
    releaseJoin();
    await starting;

    expect(await room.outcome(await room.say("owner", "hello"))).toBe("processed");
    expect(ofTypes(events, "room.joined")).toEqual([{ type: "room.joined", roomId: ROOM }]);
  });

  it.each(["attachObserver", "onStarted"] as const)("cleans up a start whose %s throws, so a restart reports its link once", async (failing) => {
    let failOnce = true;
    const failFirst = (): void => {
      if (failOnce) {
        failOnce = false;
        throw new Error(`${failing} failed`);
      }
    };
    let runtimeStops = 0;
    class FailingStartAdapter extends GenericAdapter {
      public attachObserver(_sink: AgentEventListener): void {
        if (failing === "attachObserver") failFirst();
      }
      public override async onStarted(agentName: string, agentDescription: string): Promise<void> {
        if (failing === "onStarted") failFirst();
        await super.onStarted(agentName, agentDescription);
      }
      public async onRuntimeStop(): Promise<void> {
        runtimeStops += 1;
      }
    }
    const platform = BandPlatform.host([person("owner")]);
    const { agent, events } = createAgent(new FailingStartAdapter(async ({ tools }) => { tools.turn.settle(); }), platform);

    await expect(agent.start()).rejects.toThrow(`${failing} failed`);
    expect(runtimeStops).toBe(1);
    await agent.start();
    await agent.stop();

    expect(ofTypes(events, "link.connected", "link.disconnected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "link.disconnected", reason: "closed" },
    ]);
  });

  it("reports each start's link once when the agent restarts", async () => {
    const { agent, events } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
    await agent.stop();
    await agent.start();
    await agent.stop();

    expect(ofTypes(events, "link.connected", "link.disconnected")).toEqual([
      { type: "link.connected", reconnected: false },
      { type: "link.disconnected", reason: "closed" },
      { type: "link.connected", reconnected: false },
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
      bridge: "a one-frame",
      frames: ONE_FRAME_CALL,
      call: { toolCallId: "call_03", name: "read", kind: "read", input: { path: "notes.md" } },
      result: { toolCallId: "call_03", status: "completed", output: "three notes" },
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

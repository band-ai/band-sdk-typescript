import type { AgentSideConnection, Agent as AcpAgent, PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent } from "../src/contracts/events";
import { createDeferred } from "../src/core/deferred";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person, type BandRoom } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

const ROOM = "room-1";

/** A real ACP agent behind the adapter; each prompt runs `onPrompt`. */
function acpAdapter(onPrompt: (peer: AgentSideConnection, request: PromptRequest) => Promise<{ stopReason: "end_turn" }>, options: Partial<ACPClientAdapterOptions> = {}) {
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

async function startAgent(adapter: ACPClientAdapter) {
  const platform = BandPlatform.host([person("owner")]);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
  });
  const events: AgentEvent[] = [];
  agent.observe((event) => { events.push(event); });
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
      { type: "tool.call", roomId: ROOM, toolCallId: "call-1", name: "Read notes.md", kind: "read", input: { path: "notes.md" } },
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
      const { agent, room } = await startAgent(acpAdapter((peer, { sessionId }) => workThenAnswer(peer, sessionId)));
      if (observe) agent.observe(() => {});
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
        toolCall: { toolCallId: "edit-1", title: "Edit notes.md" },
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
        toolName: "Edit notes.md",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      },
      { type: "approval.resolved", roomId: ROOM, toolCallId: "edit-1", outcome: "selected", optionId: "allow" },
    ]);
  });

  it("reports a turn the adapter fails", async () => {
    const { events, room } = await startAgent(acpAdapter(async () => { throw new Error("agent crashed"); }));
    const message = await room.say("owner", "hello");
    expect(await room.outcome(message)).toBe("failed");
    expect(ofTypes(events, "turn.started", "turn.completed", "turn.failed")).toEqual([
      { type: "turn.started", roomId: ROOM, messageId: message },
      { type: "turn.failed", roomId: ROOM, messageId: message, error: expect.any(String) },
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
});

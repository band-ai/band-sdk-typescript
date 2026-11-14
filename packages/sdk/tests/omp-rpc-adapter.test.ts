import { describe, expect, it, onTestFinished } from "vitest";

import { OmpRpcAdapter, type OmpPermissionRequest, type OmpRpcAdapterOptions } from "../src/adapters/omp-rpc";
import type { McpToolRegistration } from "../src/mcp/registrations";
import { Agent } from "../src/agent/Agent";
import { TASK_TOOL_NAMES } from "../src/contracts/toolSchemas";
import type { AgentEvent } from "../src/contracts/events";
import { createDeferred } from "../src/core/deferred";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { fakeOmpProcesses, type FakeOmp } from "./support/fakeOmp";
import { FakeTools, tmpRoot } from "./testUtils";
import {
  ACT_ARGS,
  ACT_TOOL,
  CLOSING_TEXT,
  NO_REPLY_ARGS,
  TOOL_REPLY_ARGS,
  describeTurnOutcomeContract,
  turnInput,
  type TurnScript,
} from "./turnOutcomeContract";

const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const APPROVAL = { method: "select", title: "Allow tool: bash", options: ["Approve", "Approve bash for this session", "Deny"] };

function ompAdapter(processes: ReturnType<typeof fakeOmpProcesses>, options: Partial<OmpRpcAdapterOptions> = {}) {
  return new OmpRpcAdapter({ cwd: tmpRoot(), spawnProcess: processes.spawnProcess, ...options });
}

async function startAgent(adapter: OmpRpcAdapter, admit: (roomId: string) => boolean = () => true) {
  const platform = BandPlatform.host([person("owner")]);
  const room = await platform.room(ROOM);
  const otherRoom = await platform.room(OTHER_ROOM);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    roomFilter: (candidate) => admit(String(candidate.id)),
  });
  const events: AgentEvent[] = [];
  agent.observe((event) => { events.push(event); });
  await agent.start();
  onTestFinished(async () => { if (agent.isRunning) await agent.stop(); });
  return { agent, platform, room, otherRoom, events };
}

/** Resolves with the next event `matches` reports. */
function nextEvent(agent: Agent, matches: (event: AgentEvent) => boolean): Promise<AgentEvent> {
  const seen = createDeferred<AgentEvent>();
  const stop = agent.observe((event) => { if (matches(event)) seen.resolve(event); });
  return seen.promise.finally(stop);
}

const ofTypes = (events: AgentEvent[], ...types: AgentEvent["type"][]) => events.filter((event) => types.includes(event.type));
const assistant = (...content: Array<Record<string, unknown>>) => ({ type: "message_end", message: { role: "assistant", content } });
const text = (value: string) => ({ type: "text", text: value });
const toolText = (frame: Record<string, unknown>) => ((frame.result as { content: Array<{ text: string }> }).content[0]!).text;

/** How long a probe waits; a live turn answers at once, a closed one never does. */
const PROBE_WAIT_MS = 1_000;

/**
 * Calls a host tool mid-turn: what the adapter answers says whether the turn
 * is still running. A turn that already ended may leave the call unanswered,
 * so the wait is bounded and named rather than left to the test timeout.
 */
async function probeTurn(peer: FakeOmp, id: string): Promise<string> {
  // A real timer, cleared on the answer: it only bounds the failure path, where
  // a closed turn never answers. A live turn answers on the next stream tick.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unanswered = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`no answer within ${PROBE_WAIT_MS}ms`), PROBE_WAIT_MS);
  });
  const answered = peer.callHostTool(id, "band_send_message", { content: "probe", mentions: ["owner"] }).then(toolText);
  try {
    return await Promise.race([answered, unanswered]);
  } finally {
    clearTimeout(timer);
  }
}

describe("OmpRpcAdapter", () => {
  it("streams reasoning to observers while the room records nothing, then posts the reply and redacted tool records", async () => {
    const omp = fakeOmpProcesses();
    const { agent, room, events } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "check the deploy");
    const { peer, prompt } = await prompted;

    const thought = nextEvent(agent, (event) => event.type === "thought");
    peer.send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing the options" } });
    expect(await thought).toEqual({ type: "thought", roomId: ROOM, text: "weighing the options" });
    expect(room.posted, "nothing is posted while the agent thinks").toEqual([]);

    peer.send(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer sk-live-123' https://deploy", api_key: "sk-secret" } },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [text("token=abc123; deployed")] }, isError: false },
      assistant({ type: "thinking", thinking: "weighing the options", thinkingSignature: "ENCRYPTED-REASONING" }, text("Deploy is live.")),
    );
    peer.finish(prompt.id);

    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["Deploy is live."]);
    expect(room.posted.map(({ messageType }) => messageType)).toEqual(["tool_call", "tool_result", "text"]);
    const [call, result] = room.posted;
    expect(call!.content).toBe("bash");
    expect(call!.metadata).toEqual({
      tool_call_id: "call-1",
      status: "in_progress",
      raw_input: { command: "curl -H 'Authorization=[REDACTED] https://deploy", api_key: "[REDACTED]" },
    });
    expect(result!.content).toBe("token=[REDACTED]; deployed");
    expect(ofTypes(events, "tool.call", "tool.result")).toEqual([
      { type: "tool.call", roomId: ROOM, toolCallId: "call-1", name: "bash", input: { command: "curl -H 'Authorization: Bearer sk-live-123' https://deploy", api_key: "sk-secret" } },
      { type: "tool.result", roomId: ROOM, toolCallId: "call-1", status: "completed", output: "token=abc123; deployed" },
    ]);
    expect(JSON.stringify([room.posted, events]), "the encrypted reasoning signature goes nowhere").not.toContain("ENCRYPTED-REASONING");
  });

  it("keeps a cancelled turn running after OMP acknowledges abort, until its aborted prompt_result and the settle after it", async () => {
    const omp = fakeOmpProcesses();
    const { agent, room, events } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "count to a million");
    const { peer, prompt } = await prompted;
    peer.send(assistant(text("1, 2, 3")));

    const aborted = peer.nextOfType("abort");
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    await aborted;
    expect(await probeTurn(peer, "probe-1"), "abort's success response did not end the turn").toBe("The turn was cancelled.");

    peer.send({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "aborted", sessionSettled: true });
    expect(await probeTurn(peer, "probe-2"), "the result alone did not end it either").toBe("The turn was cancelled.");
    expect(room.outcomes(message)).toEqual([]);
    expect(ofTypes(events, "turn.completed")).toEqual([]);

    peer.send({ type: "session_settled" });
    expect(await room.outcome(message)).toBe("processed");
    expect(room.posted, "a cancelled turn posts nothing").toEqual([]);
    expect(await agent.cancelTurn(ROOM), "the turn already ended").toBe(false);

    const next = omp.nextPrompt(peer);
    const second = await room.say("owner", "never mind, say hi");
    const { prompt: secondPrompt } = await next;
    peer.send(assistant(text("hi")));
    peer.finish(secondPrompt.id);
    expect(await room.outcome(second)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["hi"]);
    expect(omp.peers, "the room kept its process").toHaveLength(1);
  });

  it("fails the turn when its OMP process dies, and seeds the room's next process with the room's history", async () => {
    const omp = fakeOmpProcesses();
    const { room, events } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "first question");
    const { peer } = await prompted;

    peer.die(1);

    expect(await room.outcome(message)).toBe("failed");
    expect(room.failures).toEqual([{ content: expect.stringContaining("The OMP agent process exited with code 1"), provider: "omp-rpc" }]);
    expect(ofTypes(events, "room.failed", "turn.failed").map((event) => event.type)).toEqual(["room.failed", "turn.failed"]);

    const replaced = omp.nextProcess();
    const second = await room.say("owner", "second question");
    const next = await replaced;
    const prompt = await next.next((frame) => frame.type === "prompt");
    expect(next).not.toBe(peer);
    expect(prompt.message).toContain("[Conversation History]");
    expect(prompt.message).toContain("[owner]: first question");
    next.send(assistant(text("answered")));
    next.finish(prompt.id);
    expect(await room.outcome(second)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
  });

  it("gives OMP the room's Band tools as host tools, board and task tools included, run against the turn", async () => {
    const omp = fakeOmpProcesses();
    const { room } = await startAgent(ompAdapter(omp, { enableTaskTools: true }));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "post an update");
    const { peer, prompt } = await prompted;

    const declared = (peer.received.find((frame) => frame.type === "set_host_tools")!.tools as Array<{ name: string; loadMode: string }>);
    const names = declared.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["band_send_message", "band_no_reply", ...TASK_TOOL_NAMES]));
    expect(new Set(declared.map((tool) => tool.loadMode))).toEqual(new Set(["essential"]));

    const sent = await peer.callHostTool("tool-1", "band_send_message", { content: "Shipped @owner", mentions: ["owner"] });
    expect(sent.isError).toBeUndefined();
    expect(toolText(await peer.callHostTool("tool-2", "band_not_a_tool", {}))).toBe("Tool is not available in this session");
    peer.send(assistant(text("closing text the reply already covered")));
    peer.finish(prompt.id);

    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["Shipped @owner"]);
  });

  it("leaves the board and task tools out unless enabled", async () => {
    const omp = fakeOmpProcesses();
    const { room } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "list your tools");
    const { peer, prompt } = await prompted;

    const names = (peer.received.find((frame) => frame.type === "set_host_tools")!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("band_send_message");
    expect(names.filter((name) => TASK_TOOL_NAMES.has(name))).toEqual([]);

    peer.send(assistant(text("done")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");
  });

  it("asks resolvePermission about OMP's tool approval and answers with the label it chose", async () => {
    const omp = fakeOmpProcesses();
    const asked: OmpPermissionRequest[] = [];
    const { room, events } = await startAgent(ompAdapter(omp, {
      resolvePermission: async (request) => {
        asked.push(request);
        return "Deny";
      },
    }));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "list the files");
    const { peer, prompt } = await prompted;
    peer.send({ type: "tool_execution_start", toolCallId: "call-7", toolName: "bash", args: { command: "ls" } });

    expect(await peer.ask("ui-1", APPROVAL)).toEqual({ type: "extension_ui_response", id: "ui-1", value: "Deny" });
    expect(asked).toEqual([{ roomId: ROOM, sessionId: "omp-session-1", title: "Allow tool: bash", options: APPROVAL.options }]);
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([
      {
        type: "approval.requested",
        roomId: ROOM,
        toolCallId: "call-7",
        toolName: "bash",
        options: [
          { optionId: "Approve", name: "Approve", kind: "allow_once" },
          { optionId: "Approve bash for this session", name: "Approve bash for this session", kind: "allow_always" },
          { optionId: "Deny", name: "Deny", kind: "reject_once" },
        ],
      },
      { type: "approval.resolved", roomId: ROOM, toolCallId: "call-7", outcome: "selected", optionId: "Deny" },
    ]);
    peer.send(assistant(text("Not running that.")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");
  });

  it("runs a host tool on the child's own gate, with no approval raised anywhere else", async () => {
    const omp = fakeOmpProcesses();
    const gates: string[] = [];
    const permissions: OmpPermissionRequest[] = [];
    const { room, events } = await startAgent(ompAdapter(omp, {
      resolvePermission: async (request) => {
        permissions.push(request);
        return "Approve";
      },
      additionalTools: [
        {
          name: "linear__search",
          description: "Search an authorized server.",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: [] },
          execute: async () => {
            gates.push("linear__search");
            return { content: [{ type: "text", text: "found" }] };
          },
        },
      ],
    }));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "search for ada");
    const { peer, prompt } = await prompted;

    expect(toolText(await peer.callHostTool("tool-1", "linear__search", { query: "ada" }))).toBe("found");

    // The measurement this unit rests on, pinned rather than asserted in prose: OMP raises no
    // approval of its own for a host tool, so nothing but the tool's own gate stands between a
    // proxied call and the person's service. A host tool wired into the permission path would
    // fail all three lines below.
    expect(gates).toEqual(["linear__search"]);
    expect(permissions).toEqual([]);
    expect(ofTypes(events, "approval.requested", "approval.resolved")).toEqual([]);

    peer.send(assistant(text("Ada.")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");
  });

  /** A host tool that names the room whose registration build produced it. */
  function roomProbe(marker: string): McpToolRegistration {
    return {
      name: "room_probe",
      description: "Names the room it was built for.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: [{ type: "text", text: `built-for:${marker}` }] }),
    };
  }

  describe("additionalToolsForRoom", () => {
    it("binds each room's proxied host tool to that room, never to another's", async () => {
      const omp = fakeOmpProcesses();
      const built: string[] = [];
      const { room, otherRoom } = await startAgent(
        ompAdapter(omp, {
          additionalToolsForRoom: (roomId: string) => {
            built.push(roomId);
            return [roomProbe(roomId)];
          },
        }),
      );

      const promptedA = omp.nextPrompt();
      const messageA = await room.say("owner", "in room one");
      const { peer: peerA, prompt: promptA } = await promptedA;

      // Each room runs its own process, so the second one must be awaited by identity: asking for
      // "the next prompt" without naming a peer would hand back the first room's process again.
      const peerBSpawned = omp.nextProcess();
      const messageB = await otherRoom.say("owner", "in room two");
      const peerB = await peerBSpawned;
      const promptedB = omp.nextPrompt(peerB);
      const { prompt: promptB } = await promptedB;

      // The same tool name, answered by two rooms' processes. Each answer has to carry the room whose
      // build produced it: one shared registration would answer both with whichever room came first.
      expect(toolText(await peerA.callHostTool("tool-a", "room_probe", {}))).toBe("built-for:room-1");
      expect(toolText(await peerB.callHostTool("tool-b", "room_probe", {}))).toBe("built-for:room-2");
      expect(built.sort()).toEqual(["room-1", "room-2"]);

      peerA.send(assistant(text("One.")));
      peerA.finish(promptA.id);
      peerB.send(assistant(text("Two.")));
      peerB.finish(promptB.id);
      expect(await room.outcome(messageA)).toBe("processed");
      expect(await otherRoom.outcome(messageB)).toBe("processed");
    });

    it("refuses to create a room whose own tool collides with a shared one", async () => {
      const omp = fakeOmpProcesses();
      const { room } = await startAgent(
        ompAdapter(omp, {
          additionalTools: [roomProbe("shared")],
          additionalToolsForRoom: () => [roomProbe("per-room")],
        }),
      );

      let refusal = "";
      try {
        const message = await room.say("owner", "hello");
        refusal = `outcome:${String(await room.outcome(message))}`;
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }

      // The collision is refused where the room is made, so the room never gets a process and its turn
      // cannot run. Without the seam this is unreachable: no per-room set, so no collision, and the
      // turn processes normally — which is what makes these two lines a test rather than a tautology.
      expect(refusal).toBe("outcome:failed");
      expect(omp.peers).toHaveLength(0);
    });
  });

  it("refuses a host tool call that arrives after its turn ended, and never reaches the tool", async () => {
    const omp = fakeOmpProcesses();
    let reached = 0;
    const { room } = await startAgent(ompAdapter(omp, {
      additionalTools: [
        {
          name: "band_probe",
          description: "Records whether it was reached.",
          inputSchema: { type: "object", properties: {}, required: [] },
          execute: async () => {
            reached += 1;
            return { content: [{ type: "text", text: "probe ran" }] };
          },
        },
      ],
    }));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "say hello");
    const { peer, prompt } = await prompted;
    peer.send(assistant(text("Hello.")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");

    // A guard for behaviour that holds today, not a fix. The RPC client answers a host tool call that
    // arrives with no run in flight (OmpRpcClient.onHostToolCall's `if (!run)`) straight from the
    // client, without dispatching it: a call that outlived its turn can neither reach a host tool
    // nor speak in the room. Proven to bite by deleting that branch, which lets the call through to a
    // dispatch that has no turn to answer on.
    const late = toolText(await peer.callHostTool("tool-late", "band_probe", {}));

    expect(late).toBe("No turn is running.");
    expect(reached).toBe(0);
    expect(room.messages.map((posted) => posted.content)).not.toContain("probe ran");
  });

  it("grants an approval once by default", async () => {
    const omp = fakeOmpProcesses();
    const { room } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "list the files");
    const { peer, prompt } = await prompted;
    expect(await peer.ask("ui-1", APPROVAL)).toEqual({ type: "extension_ui_response", id: "ui-1", value: "Approve" });
    peer.send(assistant(text("a.txt")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");
  });

  it("cancels an approval still pending when its turn is cancelled, and drops the late answer", async () => {
    const omp = fakeOmpProcesses();
    const reasons: unknown[] = [];
    const { agent, room } = await startAgent(ompAdapter(omp, {
      resolvePermission: (_request, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          reasons.push(signal.reason);
          resolve("Approve");
        });
      }),
    }));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "delete the build");
    const { peer, prompt } = await prompted;
    const requested = nextEvent(agent, (event) => event.type === "approval.requested");
    const answer = peer.ask("ui-1", APPROVAL);
    await requested;

    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await answer, "a late answer cannot approve").toEqual({ type: "extension_ui_response", id: "ui-1", cancelled: true });
    expect(reasons).toEqual(["turn-cancelled"]);
    peer.finish(prompt.id, "aborted");
    expect(await room.outcome(message)).toBe("processed");
    expect(room.posted).toEqual([]);
  });

  it("reassembles a frame OMP splits into rpc_chunk frames", async () => {
    const omp = fakeOmpProcesses();
    const { agent, room } = await startAgent(ompAdapter(omp));
    const prompted = omp.nextPrompt();
    const message = await room.say("owner", "read the big file");
    const { peer, prompt } = await prompted;
    peer.send({ type: "tool_execution_start", toolCallId: "call-big", toolName: "read", args: { path: "big.txt" } });

    const whole = Buffer.from(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-big", toolName: "read", result: { content: [text("x".repeat(5000))] } }));
    const parts = [whole.subarray(0, 2000), whole.subarray(2000)];
    const result = nextEvent(agent, (event) => event.type === "tool.result");
    peer.send(...parts.map((part, index) => ({
      type: "rpc_chunk", chunkId: "c1", index, count: parts.length, byteLength: whole.length, data: part.toString("base64"),
    })));
    expect(await result).toMatchObject({ toolCallId: "call-big", output: "x".repeat(5000) });

    peer.send(assistant(text("It is all x.")));
    peer.finish(prompt.id);
    expect(await room.outcome(message)).toBe("processed");
  });
});

/** What the scripted model does in each contract turn, played through OMP's host tools and messages. */
const CONTRACT_TURNS: Record<TurnScript, (peer: FakeOmp) => Promise<void>> = {
  decline: async (peer) => {
    await peer.callHostTool("tool-1", "band_no_reply", NO_REPLY_ARGS);
    peer.send(assistant(text(CLOSING_TEXT)));
  },
  toolReply: async (peer) => {
    await peer.callHostTool("tool-1", "band_send_message", TOOL_REPLY_ARGS);
    peer.send(assistant(text(CLOSING_TEXT)));
  },
  act: async (peer) => {
    await peer.callHostTool("tool-1", ACT_TOOL, ACT_ARGS);
  },
  finalText: async (peer) => {
    peer.send(assistant(text(CLOSING_TEXT)));
  },
  nothing: async () => undefined,
};

async function judgedTurn(script: TurnScript, tools: FakeTools): Promise<void> {
  const adapter = new OmpRpcAdapter({
    cwd: tmpRoot(),
    spawnProcess: fakeOmpProcesses({
      onPrompt: async (peer, prompt) => {
        await CONTRACT_TURNS[script](peer);
        peer.finish(prompt.id);
      },
    }).spawnProcess,
  });
  await adapter.onStarted("Agent", "desc");
  try {
    await adapter.onEvent(turnInput(tools));
  } finally {
    await adapter.stop();
  }
}

describe("OmpRpcAdapter turn outcome", () => {
  describeTurnOutcomeContract([{ adapter: "OmpRpcAdapter", turn: judgedTurn }]);
});

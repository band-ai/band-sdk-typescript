import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../src/contracts/events";
import { MCP_SERVER_NAME } from "../src/contracts/toolSchemas";
import { createDeferred } from "../src/core/deferred";
import { Agent } from "../src/agent/Agent";
import { ClaudeCliAdapter, DENIED_CLAUDE_CLI_TOOLS, validateClaudeArgs } from "../src/adapters/claude-cli";
import type { ClaudeCliAdapterOptions, ClaudePermissionDecision } from "../src/adapters/claude-cli";
import { ValidationError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { controlSuccess, fakeClaudeProcesses, initResponse, type FakeClaude } from "./support/fakeClaudeCli";
import { turnFrames, addressed } from "./support/claudeCaptures";
import { FakeTools, tmpRoot } from "./testUtils";
import { ACT_ARGS, ACT_TOOL, CLOSING_TEXT, TOOL_REPLY, describeTurnOutcomeContract, turnInput, type TurnScript } from "./turnOutcomeContract";

const ROOM = "room-1";
const OTHER_ROOM = "room-2";
/** The session the frames below name. One process runs one session, so a test
 * that names its own sets it before building that turn's frames. */
const SESSION_DEFAULT = "SESSION-1";
let SESSION = SESSION_DEFAULT;
const useSession = (sessionId: string) => {
  SESSION = sessionId;
};

// The frame builders name this module's session, so each test starts from the
// default rather than from whichever session a previous test named.
beforeEach(() => {
  useSession(SESSION_DEFAULT);
});
const PERMISSION_TOOL = "band_permission_decision";

const systemInit = (sessionId = SESSION) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  tools: ["Bash"],
  mcp_servers: [{ name: "band", status: "connected", source: "dynamic" }],
  capabilities: [],
});

const assistant = (...blocks: Array<Record<string, unknown>>) => ({
  type: "assistant",
  message: { role: "assistant", content: blocks },
  parent_tool_use_id: null,
  session_id: SESSION,
});

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, value: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content: value,
  ...(isError ? { is_error: true } : {}),
});
const userFrame = (...blocks: Array<Record<string, unknown>>) => ({
  type: "user",
  message: { role: "user", content: blocks },
  parent_tool_use_id: null,
  session_id: SESSION,
});
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  terminal_reason: "completed",
  result: "done",
  session_id: SESSION,
  errors: [],
  permission_denials: [],
  ...over,
});

/** A process that answers `initialize` as soon as it is asked, like a real CLI. */
function rig(onSpawn?: (peer: FakeClaude) => void) {
  return fakeClaudeProcesses((peer) => {
    // A real CLI answers every control request the host sends: initialize, and the
    // interrupt a cancellation waits on. A fake that answers only the handshake
    // leaves the adapter waiting out its ACK timeout for a reply no one will write.
    const answered = new Set<string>();
    const answerNextRequest = (): void => {
      void peer.waitFor((frame) => frame.type === "control_request" && !answered.has(String(frame.request_id))).then((request) => {
        const requestId = String(request.request_id);
        answered.add(requestId);
        const subtype = (request.request as { subtype?: string } | undefined)?.subtype;
        peer.send(subtype === "initialize" ? initResponse(requestId) : controlSuccess(requestId));
        answerNextRequest();
      });
    };
    answerNextRequest();
    onSpawn?.(peer);
  });
}

/** Resolves when the runtime reports this room's turn finished, one way or another. */
function turnSettled(agent: Agent): Promise<AgentEvent> {
  const seen = createDeferred<AgentEvent>();
  const stop = agent.observe((event) => {
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.stopped") {
      seen.resolve(event);
      stop();
    }
  });
  return seen.promise;
}

/** Waits until the CLI has been handed this turn's user envelope. */
function waitForPrompt(peer: FakeClaude): Promise<void> {
  return peer.waitFor((frame) => frame.type === "user").then(() => undefined);
}

function adapter(rigged: ReturnType<typeof rig>, options: Partial<ClaudeCliAdapterOptions> = {}): ClaudeCliAdapter {
  return new ClaudeCliAdapter({ cwd: tmpRoot(), spawnProcess: rigged.spawnProcess, ...options });
}

async function started(claude: ClaudeCliAdapter, admit: (roomId: string) => boolean = () => true) {
  const platform = BandPlatform.host([person("owner")]);
  const room = await platform.room(ROOM);
  await platform.room(OTHER_ROOM);
  const agent = Agent.create({
    adapter: claude,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    roomFilter: (candidate) => admit(String(candidate.id)),
  });
  const events: AgentEvent[] = [];
  agent.observe((event) => {
    events.push(event);
  });
  await agent.start();
  return { agent, platform, room, events };
}

/** The `--mcp-config` document one process was launched with. */
function mcpConfig(peer: FakeClaude): { mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }> } {
  const index = peer.options.command.indexOf("--mcp-config");
  expect(index, "the CLI was launched with an --mcp-config").toBeGreaterThan(-1);
  return JSON.parse(peer.options.command[index + 1]!) as {
    mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
  };
}

/** The values passed to one list flag, up to the next flag. */
function approvedTools(peer: FakeClaude, flag = "--allowedTools"): string[] {
  const index = peer.options.command.indexOf(flag);
  if (index === -1) {
    return [];
  }
  const values: string[] = [];
  for (const argument of peer.options.command.slice(index + 1)) {
    if (argument.startsWith("--")) break;
    values.push(argument);
  }
  return values;
}

function argPair(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index === -1 ? undefined : command[index + 1];
}

/** Reaches one generation's Band server the way the CLI would: over loopback, with its token. */
async function connectBand(peer: FakeClaude): Promise<{ client: Client; close(): Promise<void> }> {
  const band = mcpConfig(peer).mcpServers.band;
  expect(band?.type).toBe("http");
  const transport = new StreamableHTTPClientTransport(new URL(band.url!), { requestInit: { headers: band.headers } });
  const client = new Client({ name: "claude-cli-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: async () => transport.close() };
}

async function callBand(peer: FakeClaude, name: string, args: Record<string, unknown>) {
  const { client, close } = await connectBand(peer);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await close();
  }
}

/**
 * A call to a generation's Band server, bounded: a generation that has been
 * closed is refused by its transport dying as much as by its tools answering
 * "this turn is closed", and a test must not wait on either.
 */
async function tryCallBand(peer: FakeClaude, name: string, args: Record<string, unknown>, budgetMs = 3_000) {
  const attempt = callBand(peer, name, args).then(
    (result) => ({ refused: false as const, result }),
    () => ({ refused: true as const, result: undefined }),
  );
  const budget = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), budgetMs));
  const outcome = await Promise.race([attempt, budget]);
  return outcome === "late" ? { refused: true as const, result: undefined } : outcome;
}

describe("ClaudeCliAdapter", () => {
  it("replies once with the model's closing text and records its own tool use", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "check the deploy");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(
        systemInit(),
        assistant(toolUse("toolu-1", "Bash", { command: "ls" })),
        userFrame(toolResult("toolu-1", "file list")),
        assistant(text("deployed")),
        result({ result: "deployed" }),
      );
      await prompted;
      await promptedDone;
      expect(room.messages.map((message) => message.content)).toEqual(["deployed"]);
      expect(room.events("tool_call").map((event) => event.content)).toEqual(["Bash"]);
      expect(room.events("tool_result").map((event) => event.content)).toEqual(["file list"]);
    } finally {
      await agent.stop();
    }
  });

  it("gives each turn its own process and resumes the room's session in the next", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "one");
      const peerOne = await rigged.nextPeer();
      await peerOne.scriptTurn(systemInit(), assistant(text("reply one")), result({ result: "reply one" }));
      await first;
      await firstDone;

      const secondDone = turnSettled(agent);
      const second = room.say("owner", "two");
      const peerTwo = await rigged.nextPeer();
      expect(peerTwo).not.toBe(peerOne);
      expect(argPair(peerTwo.options.command, "--resume")).toBe(SESSION);
      // The first process is gone: its stdin closed and it was stopped.
      expect(peerOne.stdinEnded).toBe(true);
      expect(peerOne.stopped).toBe(true);
      await peerTwo.scriptTurn(systemInit(), assistant(text("reply two")), result({ result: "reply two" }));
      await second;
      await secondDone;
      expect(room.messages.map((message) => message.content)).toEqual(["reply one", "reply two"]);
    } finally {
      await agent.stop();
    }
  });

  it("seeds a room's first turn with its history and never again", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      await room.say("owner", "earlier question");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      const secondTurnDone = turnSettled(agent);
      const secondTurn = room.say("owner", "and now?");
      const second = await rigged.nextPeer();
      const content = await second.scriptTurnAndRead();
      // Turn two continues the session the CLI named, so nothing is replayed at it:
      // the room's history framing appears only on a turn that owes a replay.
      expect(content).not.toContain("[Conversation History]");
      void secondTurn;
      void secondTurnDone;
    } finally {
      await agent.stop();
    }
  });

  it("runs a Band tool through that turn's MCP generation", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "greet them");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "mcp__band__band_send_message", { content: "hello there", mentions: ["@owner"] })));
      const called = await callBand(peer, "band_send_message", { content: "hello there", mentions: ["@owner"] });
      expect(called.isError).not.toBe(true);
      peer.send(userFrame(toolResult("toolu-1", "sent")), assistant(text("said it")), result({ result: "said it" }));
      await prompted;
      await promptedDone;
      // The tool's post is the reply; the model's closing text is not relayed a
      // second time. The Band call is still reported as tool activity, under the
      // CLI's own tool name.
      expect(room.messages.map((message) => message.content)).toEqual(["hello there"]);
      expect(room.events("tool_call").map((event) => event.content)).toEqual(["mcp__band__band_send_message"]);
    } finally {
      await agent.stop();
    }
  });

  it("refuses the previous turn's MCP call while the new turn's succeeds", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "one");
      const old = await rigged.nextPeer();
      await old.scriptTurn(systemInit(), assistant(text("done one")), result({ result: "done one" }));
      await first;
      await firstDone;

      const secondDone = turnSettled(agent);
      const second = room.say("owner", "two");
      const next = await rigged.nextPeer();
      const stale = await tryCallBand(old, "band_send_message", { content: "from the old turn", mentions: ["@owner"] });
      expect(stale.refused, "the closed generation still served a Band call").toBe(true);

      const fresh = await tryCallBand(next, "band_send_message", { content: "from the live turn", mentions: ["@owner"] });
      expect(fresh.refused, "the live turn's Band server refused its own call").toBe(false);
      expect(fresh.result?.isError).not.toBe(true);
      await next.scriptTurn(systemInit(), assistant(text("done two")), result({ result: "done two" }));
      await second;
      await secondDone;
      // Turn one's relay and the live generation's Band post; turn two's closing
      // text is not relayed a second time because its turn already replied.
      // Nothing at all came from the closed generation.
      expect(room.messages.map((message) => message.content)).toEqual(["done one", "from the live turn"]);
      expect(room.messages.map((message) => message.content)).not.toContain("from the old turn");
    } finally {
      await agent.stop();
    }
  });

  it("refuses a previous turn's pending permission decision after the room moved on", async () => {
    let release: (decision: ClaudePermissionDecision | undefined) => void = () => undefined;
    let askedHost: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      askedHost = resolve;
    });
    const rigged = rig();
    const claude = adapter(rigged, {
      resolvePermission: (_prompt, signal) =>
        new Promise<ClaudePermissionDecision | undefined>((resolve) => {
          release = resolve;
          askedHost();
          signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
      permissionTimeoutMs: 60_000,
    });
    const { agent, room } = await started(claude);
    try {
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "run it");
      const old = await rigged.nextPeer();
      await old.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "Bash", { command: "ls" })));
      const pending = callBand(old, PERMISSION_TOOL, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu-1" });
      await asked;
      // The host never answers this one: the turn is ended with the approval still
      // waiting, which is what taking the room away from it does.
      release(undefined);
      old.send(userFrame(toolResult("toolu-1", "refused", true)), result({ result: "left it" }));
      await first;
      await firstDone;
      await pending;

      // The room has moved on: a new turn with a generation of its own.
      const secondDone = turnSettled(agent);
      const second = room.say("owner", "and now?");
      const next = await rigged.nextPeer();
      await next.scriptTurn(systemInit(), assistant(text("onwards")), result({ result: "onwards" }));
      await second;
      await secondDone;

      // Only now does a late answer arrive for the closed turn's tool use. It must
      // not resurrect that turn: the ask is refused however it is refused - the
      // server is gone, or the answer is a deny - nothing runs, and nothing posts.
      release({ behavior: "allow", updatedInput: { command: "ls" } });
      const late = await tryCallBand(old, PERMISSION_TOOL, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu-1" }, 2_000);
      expect(late.refused || late.result?.isError === true, "the closed turn's approval was served again").toBe(true);
      expect(room.messages.map((message) => message.content)).toEqual(["onwards"]);
    } finally {
      await agent.stop();
    }
  });

  it("asks the host about a native tool and runs it once approved, in the shape the CLI accepts", async () => {
    const asked: Array<{ tool: string; input: unknown }> = [];
    const rigged = rig();
    const claude = adapter(rigged, {
      resolvePermission: async (prompt) => {
        asked.push({ tool: prompt.toolName, input: prompt.input });
        return { behavior: "allow", updatedInput: prompt.input };
      },
    });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "list files");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "Bash", { command: "ls" })));
      const answer = await callBand(peer, PERMISSION_TOOL, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu-1" });
      // The CLI rejects any answer that is not exactly one text block holding the
      // decision, so the shape is part of the contract.
      expect(Object.keys(answer)).toEqual(["content"]);
      expect(answer.content).toHaveLength(1);
      const block = (answer.content as Array<{ type: string; text: string }>)[0]!;
      expect(block.type).toBe("text");
      expect(JSON.parse(block.text)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
      expect(asked).toEqual([{ tool: "Bash", input: { command: "ls" } }]);
      peer.send(userFrame(toolResult("toolu-1", "file list")), assistant(text("listed")), result({ result: "listed" }));
      await prompted;
      await promptedDone;
      expect(room.messages.map((message) => message.content)).toEqual(["listed"]);
    } finally {
      await agent.stop();
    }
  });

  it("declines every approval when no permission handler is configured", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "list files");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "Bash", { command: "ls" })));
      const answer = await callBand(peer, PERMISSION_TOOL, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu-1" });
      expect(JSON.parse((answer.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ behavior: "deny" });
      peer.send(userFrame(toolResult("toolu-1", "denied", true)), assistant(text("no")), result({ result: "no" }));
      await prompted;
      await promptedDone;
      expect(room.events("tool_result").map((event) => event.content)).toContain("denied");
    } finally {
      await agent.stop();
    }
  });

  it("settles a second ask for an already-answered tool use without asking the host again", async () => {
    let asks = 0;
    const rigged = rig();
    const claude = adapter(rigged, {
      resolvePermission: async () => {
        asks += 1;
        return { behavior: "allow", updatedInput: {} };
      },
    });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "do it");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "Bash")));
      const args = { tool_name: "Bash", input: {}, tool_use_id: "toolu-1" };
      await callBand(peer, PERMISSION_TOOL, args);
      const again = await callBand(peer, PERMISSION_TOOL, args);
      expect(asks).toBe(1);
      expect(JSON.parse((again.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ behavior: "deny" });
      peer.send(result({ result: "ok" }));
      await prompted;
      await promptedDone;
    } finally {
      await agent.stop();
    }
  });

  it("denies an approval the host never answers, at the bound", async () => {
    const rigged = rig();
    const claude = adapter(rigged, {
      resolvePermission: () => new Promise<ClaudePermissionDecision>(() => undefined),
      permissionTimeoutMs: 25,
    });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "do it");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(toolUse("toolu-1", "Bash")));
      const answer = await callBand(peer, PERMISSION_TOOL, { tool_name: "Bash", input: {}, tool_use_id: "toolu-1" });
      expect(JSON.parse((answer.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ behavior: "deny" });
      peer.send(result({ result: "ok" }));
      await prompted;
      await promptedDone;
    } finally {
      await agent.stop();
    }
  });

  it("settles a cancelled turn quietly on the captured error-shaped result, posting nothing", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room, events } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "run it");
      const peer = await rigged.nextPeer();
      await waitForPrompt(peer);
      const frames = turnFrames("interrupt-pending-permission");
      peer.send(frames[0]!, frames[1]!);
      await new Promise((resolve) => setImmediate(resolve));
      const cancelled = await agent.cancelTurn(ROOM);
      expect(cancelled).toBe(true);
      const interrupt = await peer.controlRequest("interrupt");
      expect(interrupt).toBeDefined();
      peer.send(...frames.slice(2));
      await prompted;
      await promptedDone;
      // The CLI's error-shaped result and exit 1 are a cancellation the host asked
      // for, not a failure: nothing posted, nothing reported failed, and the turn
      // settled. `turn.stopped` is a platform Stop's event, not an adapter
      // cancellation's, so it is not asserted here.
      expect(room.messages).toEqual([]);
      expect(room.events("error")).toEqual([]);
      expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
      expect(events.some((event) => event.type === "turn.completed" && event.roomId === ROOM)).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("reports an error result the host did not ask for as a failure with the CLI's reason", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "do it");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), result({ subtype: "error_during_execution", is_error: true, errors: ["model overloaded"], result: null, terminal_reason: "failed" }));
      await prompted;
      await promptedDone;
      expect(room.messages).toEqual([]);
      expect(room.events("error").some((event) => event.content.includes("model overloaded"))).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("reports a process that died mid-turn as a failure and starts the next turn fresh", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "do it");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit());
      peer.exit(1);
      await prompted;
      await promptedDone;
      expect(room.events("error").length).toBe(1);

      const nextDone = turnSettled(agent);
      const next = room.say("owner", "again");
      const peerTwo = await rigged.nextPeer();
      await peerTwo.scriptTurn(systemInit(), assistant(text("back")), result({ result: "back" }));
      await next;
      await nextDone;
      expect(room.messages.map((message) => message.content)).toEqual(["back"]);
    } finally {
      await agent.stop();
    }
  });

  it("cancels before the prompt is sent and posts nothing", async () => {
    const rigged = rig(() => undefined);
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "do it");
      const peer = await rigged.nextPeer();
      // Hold the handshake: the turn is still starting when the host cancels.
      const request = await peer.controlRequest("initialize");
      expect(await agent.cancelTurn(ROOM)).toBe(true);
      peer.send(initResponse(String(request.request_id)));
      await prompted;
      await promptedDone;
      expect(room.messages).toEqual([]);
      expect(peer.received.some((frame) => frame.type === "user")).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("warm starts and initializes a process, sends no prompt, and reports what the CLI said", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, events } = await started(claude);
    try {
      const warming = agent.rooms.allow(OTHER_ROOM, { warm: true });
      const peer = await rigged.nextPeer();
      const request = await peer.controlRequest("initialize");
      peer.send(initResponse(String(request.request_id), "2.1.319"));
      await expect(warming).resolves.toBe(true);
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "room.ready" && JSON.stringify(event.agent).includes("claude-stream-json"))).toBe(true);
      });
      expect(peer.received.filter((frame) => frame.type === "user")).toEqual([]);
      expect(argPair(peer.options.command, "--resume")).toBeUndefined();
    } finally {
      await agent.stop();
    }
  });

  it("refuses to run a Band tool on a warm process that no turn has bound", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent } = await started(claude);
    try {
      const warming = agent.rooms.allow(OTHER_ROOM, { warm: true });
      const peer = await rigged.nextPeer();
      const request = await peer.controlRequest("initialize");
      peer.send(initResponse(String(request.request_id)));
      await warming;
      const answer = await callBand(peer, "band_send_message", { content: "early", mentions: ["@owner"] });
      expect(answer.isError).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("clears the room's session when its engine retires", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await waitForPrompt(peer);
      useSession("SESSION-A");
      await peer.scriptTurn(systemInit("SESSION-A"), assistant(text("ok")), result({ result: "ok", session_id: "SESSION-A" }));
      await prompted;
      await promptedDone;
      expect(claude.sessionId(ROOM)).toBe("SESSION-A");
      await claude.onCleanup(ROOM);
      expect(claude.sessionId(ROOM)).toBeNull();
    } finally {
      await agent.stop();
    }
  });

  it("reports a resume the CLI answered with another session, and does not quietly start over", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room, events } = await started(claude);
    try {
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "one");
      const peerOne = await rigged.nextPeer();
      await waitForPrompt(peerOne);
      useSession("SESSION-A");
      await peerOne.scriptTurn(systemInit("SESSION-A"), assistant(text("ok")), result({ result: "ok", session_id: "SESSION-A" }));
      await first;
      await firstDone;

      const secondDone = turnSettled(agent);
      const second = room.say("owner", "two");
      const peerTwo = await rigged.nextPeer();
      await waitForPrompt(peerTwo);
      expect(argPair(peerTwo.options.command, "--resume")).toBe("SESSION-A");
      useSession("SESSION-B");
      await peerTwo.scriptTurn(systemInit("SESSION-B"), assistant(text("wrong session")), result({ result: "wrong session", session_id: "SESSION-B" }));
      await second;
      await secondDone;
      // Reported, not swallowed: the room is told the resume failed, as a room
      // error event and as a failed turn the host can see.
      expect(JSON.stringify(room.events("error")) + JSON.stringify(events)).toContain("session");
      // ...and only then is the session cleared, so a later turn bootstraps from history.
      expect(claude.sessionId(ROOM)).toBeNull();
    } finally {
      await agent.stop();
    }
  });

  it("reports the latest turn's usage and never the cumulative totals", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(
        systemInit(),
        assistant(text("ok")),
        result({
          result: "ok",
          total_cost_usd: 0.055,
          modelUsage: { "claude-opus-5-5": { inputTokens: 2, costUSD: 0.055 } },
          model_usage_since_last_result: { "claude-opus-5-5": { inputTokens: 2, costUSD: 0.055 } },
        }),
      );
      await first;
      await firstDone;
      expect(claude.turnUsage(ROOM)).toMatchObject({ available: true });
      expect(JSON.stringify(claude.turnUsage(ROOM))).not.toContain("0.107");

      const nextDone = turnSettled(agent);
      const next = room.say("owner", "two");
      const peerTwo = await rigged.nextPeer();
      await peerTwo.scriptTurn(
        systemInit(),
        assistant(text("ok two")),
        result({
          result: "ok two",
          total_cost_usd: 0.107,
          modelUsage: { "claude-opus-5-5": { inputTokens: 6, costUSD: 0.107 } },
          model_usage_since_last_result: { "claude-opus-5-5": { inputTokens: 4, costUSD: 0.052 } },
        }),
      );
      await next;
      await nextDone;
      expect(claude.turnUsage(ROOM)?.byModel).toEqual({ "claude-opus-5-5": { inputTokens: 4, costUSD: 0.052 } });
    } finally {
      await agent.stop();
    }
  });

  it("reports usage unavailable rather than inventing a number", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      await prompted;
      await promptedDone;
      expect(claude.turnUsage(ROOM)).toMatchObject({ available: false, byModel: null });
      expect(claude.turnUsage(ROOM)?.reason).toBeTruthy();
    } finally {
      await agent.stop();
    }
  });

  it("keeps reasoning out of the reply and never carries its signature", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room, events } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "think about it");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(
        systemInit(),
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "the private reasoning", signature: "Eq8ClongAttestingBlob" },
              text("the answer"),
            ],
          },
          parent_tool_use_id: null,
          session_id: SESSION,
        },
        result({ result: "the answer" }),
      );
      await prompted;
      await promptedDone;
      expect(room.messages.map((message) => message.content)).toEqual(["the answer"]);
      expect([...room.messages.map((m) => m.content), ...room.events("tool_call").map((e) => e.content)].join("\n")).not.toContain("private reasoning");
      expect(JSON.stringify(events)).not.toContain("Eq8ClongAttestingBlob");
      expect(events.filter((event) => event.type === "thought").map((event) => (event as { text: string }).text)).toEqual(["the private reasoning"]);
    } finally {
      await agent.stop();
    }
  });

  it("launches apart from the host's own Claude configuration", async () => {
    const rigged = rig();
    const claude = adapter(rigged, { model: "sonnet", effort: "high", permissionMode: "acceptEdits", pluginDirs: ["/opt/role-plugin"], allowedTools: ["Read"] });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      await prompted;
      await promptedDone;
      const command = peer.options.command;
      expect(argPair(command, "--setting-sources")).toBe("");
      expect(command).toContain("--strict-mcp-config");
      expect(argPair(command, "--permission-prompt-tool")).toBe(`mcp__band__${PERMISSION_TOOL}`);
      expect(command.slice(command.indexOf("--disallowedTools"))).toEqual(
        expect.arrayContaining([...DENIED_CLAUDE_CLI_TOOLS]),
      );
      expect(argPair(command, "--model")).toBe("sonnet");
      expect(argPair(command, "--effort")).toBe("high");
      expect(argPair(command, "--permission-mode")).toBe("acceptEdits");
      expect(command).toContain("/opt/role-plugin");
      expect(command).toContain("Read");
    } finally {
      await agent.stop();
    }
  });

  it("maps the manual permission mode to the CLI's default rather than accepting an unknown one", async () => {
    const rigged = rig();
    const claude = adapter(rigged, { permissionMode: "manual" as "default" });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      await prompted;
      await promptedDone;
      expect(argPair(peer.options.command, "--permission-mode")).toBe("default");
    } finally {
      await agent.stop();
    }
  });

  it("refuses a custom argument that would override a flag the transport owns", () => {
    expect(() => validateClaudeArgs(["--permission-prompt-tool", "mcp__evil__gate"])).toThrow(ValidationError);
    expect(() => validateClaudeArgs(["--setting-sources=user,project"])).toThrow(/reserved/);
    expect(() => validateClaudeArgs(["--no-session-persistence"])).toThrow(/reserved/);
    expect(validateClaudeArgs(["--include-partial-messages"])).toEqual(["--include-partial-messages"]);
    expect(() => new ClaudeCliAdapter({ command: ["claude", "--dangerously-skip-permissions"] })).toThrow(ValidationError);
  });

  it("serves Band over one authenticated loopback server and appends authorized servers beside it", async () => {
    const rigged = rig();
    const claude = adapter(rigged, {
      extraMcpServers: [
        {
          name: "linear",
          type: "http",
          url: "https://mcp.linear.test/sse",
          headers: [{ name: "Authorization", value: "Bearer linear-token" }],
        },
        // A server named like Band's must not be able to shadow it.
        { name: MCP_SERVER_NAME, type: "sse", url: "http://127.0.0.1:1/shadow", headers: [] },
        { name: "local-tools", command: "npx", args: ["-y", "local-mcp"], env: [{ name: "KEY", value: "v" }] },
      ],
    });
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      const config = mcpConfig(peer);
      // Given order kept, Band's own server last and unshadowed.
      expect(Object.keys(config.mcpServers)).toEqual(["linear", "local-tools", "band"]);
      expect(config.mcpServers.linear).toEqual({
        type: "http",
        url: "https://mcp.linear.test/sse",
        headers: { Authorization: "Bearer linear-token" },
      });
      expect(config.mcpServers["local-tools"]).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "local-mcp"],
        env: { KEY: "v" },
      });
      expect(config.mcpServers.band?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      expect(config.mcpServers.band?.headers?.Authorization).toMatch(/^Bearer .{16,}$/);
      // An authorized server's tools are never pre-approved: every call to one
      // reaches the permission callback.
      const approved = approvedTools(peer);
      expect(approved).toContain("mcp__band__band_send_message");
      expect(approved.filter((name) => name.includes("linear") || name.includes("local-tools"))).toEqual([]);
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      await prompted;
      await promptedDone;
    } finally {
      await agent.stop();
    }
  });

  it("gives two rooms their own process, session and tools", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room, platform } = await started(claude);
    try {
      const other = await platform.room(OTHER_ROOM);
      useSession(SESSION_DEFAULT);
      const firstDone = turnSettled(agent);
      const first = room.say("owner", "one");
      const peerOne = await rigged.nextPeer();
      await waitForPrompt(peerOne);
      useSession("SESSION-A");
      await peerOne.scriptTurn(systemInit("SESSION-A"), assistant(text("reply a")), result({ result: "reply a", session_id: "SESSION-A" }));
      await first;
      await firstDone;
      const secondDone = turnSettled(agent);
      const second = other.say("owner", "two");
      const peerTwo = await rigged.nextPeer();
      await waitForPrompt(peerTwo);
      useSession("SESSION-B");
      await peerTwo.scriptTurn(systemInit("SESSION-B"), assistant(text("reply b")), result({ result: "reply b", session_id: "SESSION-B" }));
      await second;
      await secondDone;
      expect(peerOne).not.toBe(peerTwo);
      expect(room.messages.map((message) => message.content)).toEqual(["reply a"]);
      expect(other.messages.map((message) => message.content)).toEqual(["reply b"]);
      expect(claude.sessionId(ROOM)).toBe("SESSION-A");
      expect(claude.sessionId(OTHER_ROOM)).toBe("SESSION-B");
    } finally {
      await agent.stop();
    }
  });

  it("stops a process that ignores stdin closing and says it had to", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      // A process that ignores stdin closing: the turn's own drain has to escalate
      // to a stop, so this is set before the turn is scripted, not after.
      peer.exitsOnEof = false;
      await waitForPrompt(peer);
      peer.writeStderr("stuck before exit");
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));
      await prompted;
      await promptedDone;
      expect(peer.stopped).toBe(true);
      expect(room.messages.map((message) => message.content)).toEqual(["ok"]);
    } finally {
      await agent.stop();
    }
  });

  it("makes every caller wait for one teardown while the process drains", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room } = await started(claude);
    try {
      const turnDone = turnSettled(agent);
      const posted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      // The OS is slow to take the process down: its exit is held back.
      peer.holdExit();
      await peer.scriptTurn(systemInit(), assistant(text("ok")), result({ result: "ok" }));

      // The turn's own teardown is draining. A second caller - the agent stopping
      // the room - must join that drain, not report that the process is gone.
      const stopping = agent.stop();
      const raced = await Promise.race([
        stopping.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
      ]);
      expect(raced, "the stop returned while the first drain was still running").toBe("pending");

      peer.releaseExit(0);
      await stopping;
      await posted;
      await turnDone;
      expect(peer.hasExited, "the held process never actually went").toBe(true);
      expect(peer.exitCalls, "the same process was torn down twice").toBeLessThanOrEqual(1);
    } finally {
      await agent.stop();
    }
  });

  it("settles each observer event once per turn", async () => {
    const rigged = rig();
    const claude = adapter(rigged);
    const { agent, room, events } = await started(claude);
    try {
      const promptedDone = turnSettled(agent);
      const prompted = room.say("owner", "one");
      const peer = await rigged.nextPeer();
      await peer.scriptTurn(
        systemInit(),
        assistant(toolUse("toolu-1", "Bash", { command: "ls" })),
        userFrame(toolResult("toolu-1", "files")),
        assistant(text("ok")),
        result({ result: "ok" }),
      );
      await prompted;
      await promptedDone;
      const calls = events.filter((event) => event.type === "tool.call");
      const results = events.filter((event) => event.type === "tool.result");
      expect(calls).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect((calls[0] as { toolCallId: string }).toolCallId).toBe("toolu-1");
      expect((results[0] as { status: string }).status).toBe("completed");
    } finally {
      await agent.stop();
    }
  });
});

const CONTRACT_TURNS: Record<TurnScript, (peer: FakeClaude, tool?: { name: string }) => Promise<void>> = {
  // The CLI runs a Band or custom tool by calling the turn's own MCP server, so
  // a contract turn that "calls" a tool has to reach it for real: announcing a
  // tool use and typing its result by hand would settle nothing on the turn.
  decline: async (peer) => {
    peer.send(systemInit(), assistant(toolUse("toolu-1", "mcp__band__band_no_reply", { reason: "FYI only" })));
    await callBand(peer, "band_no_reply", { reason: "FYI only" });
    peer.send(userFrame(toolResult("toolu-1", "ok")), assistant(text(CLOSING_TEXT)), result({ result: CLOSING_TEXT }));
  },
  toolReply: async (peer) => {
    peer.send(systemInit(), assistant(toolUse("toolu-1", "mcp__band__band_send_message", { content: TOOL_REPLY, mentions: ["@user"] })));
    await callBand(peer, "band_send_message", { content: TOOL_REPLY, mentions: ["@user"] });
    peer.send(userFrame(toolResult("toolu-1", "ok")), assistant(text(CLOSING_TEXT)), result({ result: CLOSING_TEXT }));
  },
  act: async (peer, tool) => {
    // A turn that only acted: a Band tool by default, or the custom tool the
    // contract hands in.
    const name = tool?.name ?? ACT_TOOL;
    peer.send(systemInit(), assistant(toolUse("toolu-1", `mcp__band__${name}`, tool ? {} : ACT_ARGS)));
    await callBand(peer, name, tool ? {} : ACT_ARGS);
    peer.send(userFrame(toolResult("toolu-1", "ok")), result({ result: "" }));
  },
  finalText: async (peer) => {
    peer.send(systemInit(), assistant(text(CLOSING_TEXT)), result({ result: CLOSING_TEXT }));
  },
  nothing: async (peer) => {
    peer.send(systemInit(), result({ result: "" }));
  },
};

async function judgedTurn(
  script: TurnScript,
  tools: FakeTools,
  tool?: { name: string; schema: unknown; handler: () => Promise<unknown>; effect?: unknown },
): Promise<void> {
  const rigged = rig((peer) => {
    // The CLI scripts its turn after it is handed the prompt; it never sends a
    // `user-prompt` control request, so the prompt frame is the gate.
    void peer.waitFor((frame) => frame.type === "user").then(() => CONTRACT_TURNS[script](peer, tool));
  });
  const claude = new ClaudeCliAdapter({
    cwd: tmpRoot(),
    spawnProcess: rigged.spawnProcess,
    ...(tool ? { additionalTools: [tool as never] } : {}),
  });
  await claude.onStarted("Agent", "desc");
  try {
    await claude.onEvent({ ...(await turnInput(tools)), roomId: ROOM } as never);
  } finally {
    await claude.stop();
  }
}

describe("ClaudeCliAdapter turn outcome", () => {
  describeTurnOutcomeContract([{ adapter: "ClaudeCliAdapter", turn: judgedTurn }]);
});

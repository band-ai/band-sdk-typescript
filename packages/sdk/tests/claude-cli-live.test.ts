import { describe, expect, it } from "vitest";
import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { Agent } from "../src/agent/Agent";
import { BandLink } from "../src/platform/BandLink";
import { ClaudeCliAdapter, type ClaudePermissionDecision, type ClaudePermissionPrompt } from "../src/adapters/claude-cli";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { tmpRoot } from "./testUtils";

/**
 * Opt-in check against the installed Claude Code CLI: the offline suites replay
 * captured frames, this one drives the real program. It is skipped unless
 * `BAND_CLAUDE_LIVE=1`, and a missing CLI or login is reported as unavailable -
 * never as a pass, because an untested adapter is not a working one.
 */
const CLAUDE_BIN = process.env.BAND_CLAUDE_BIN ?? "/Users/cozmonat/.local/bin/claude";
const LIVE = process.env.BAND_CLAUDE_LIVE === "1";

const ROOM = "room-1";
const SESSION_PROTOCOL = "claude-stream-json";

type LiveRoom = Awaited<ReturnType<BandPlatform["room"]>>;

interface Live {
  agent: Agent;
  claude: ClaudeCliAdapter;
  room: LiveRoom;
  events: AgentEvent[];
  prompts: ClaudePermissionPrompt[];
  decide: (decision: ClaudePermissionDecision | undefined) => void;
  held: () => Promise<ClaudePermissionPrompt>;
}

async function live(): Promise<Live> {
  const platform = BandPlatform.host([person("owner")]);
  const room = await platform.room(ROOM);
  const prompts: ClaudePermissionPrompt[] = [];
  let release: (decision: ClaudePermissionDecision | undefined) => void = () => undefined;
  let waiting: ((prompt: ClaudePermissionPrompt) => void) | undefined;
  const claude = new ClaudeCliAdapter({
    cwd: tmpRoot(),
    command: [CLAUDE_BIN],
    resolvePermission: (prompt, signal) =>
      new Promise<ClaudePermissionDecision | undefined>((resolve) => {
        prompts.push(prompt);
        release = resolve;
        waiting?.(prompt);
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    permissionTimeoutMs: 120_000,
    turnTimeoutMs: 240_000,
  });
  const agent = Agent.create({
    adapter: claude,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    roomFilter: () => true,
  });
  const events: AgentEvent[] = [];
  agent.observe((event) => events.push(event));
  await agent.start();
  return {
    agent,
    claude,
    room,
    events,
    prompts,
    decide: (decision) => release(decision),
    held: () => new Promise<ClaudePermissionPrompt>((resolve) => {
      waiting = resolve;
      if (prompts[0]) {
        resolve(prompts[0]!);
      }
    }),
  };
}

/**
 * The check is opt-in. Once opted in, a missing CLI or login is reported as
 * unavailable by failing the run: an untested adapter must never look green.
 */
async function liveOrReport(): Promise<Live> {
  const reason = await unavailable();
  if (reason) {
    throw new Error(`UNAVAILABLE: the real-CLI check could not run - ${reason}`);
  }
  return live();
}

async function unavailable(): Promise<string | null> {
  if (!LIVE) {
    return "BAND_CLAUDE_LIVE is not set";
  }
  if (!existsSync(CLAUDE_BIN)) {
    return `no Claude CLI at ${CLAUDE_BIN}`;
  }
  try {
    accessSync(CLAUDE_BIN, constants.X_OK);
  } catch {
    return `${CLAUDE_BIN} is not executable`;
  }
  const version = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (version.status !== 0) {
    return `claude --version failed: ${version.stderr.slice(0, 200)}`;
  }
  // A logged-out CLI answers every turn with an auth error, which would look like
  // an adapter failure rather than an unavailable environment.
  const auth = spawnSync(CLAUDE_BIN, ["auth", "status"], { encoding: "utf8", timeout: 30_000, env: process.env });
  if (auth.status !== 0) {
    return `no Claude login reported by auth status: ${auth.stdout.slice(0, 200)}${auth.stderr.slice(0, 200)}`;
  }
  return null;
}

describe.skipIf(!LIVE)("Claude CLI adapter against the installed CLI", () => {
  it("warms a room, reports the CLI's own identity, and answers a turn over the Band MCP server", async () => {
    const started = await liveOrReport();
    const { agent, claude, room, events } = started;
    try {
      await expect(agent.rooms.allow(ROOM, { warm: true })).resolves.toBe(true);
      const warmed = events.find((event) => event.type === "room.ready");
      expect(JSON.stringify(warmed), "room.ready never reported the CLI's identity").toContain(SESSION_PROTOCOL);

      const posted = await room.say("owner", 'Call the band_send_message tool exactly once with content "live check" and mentions ["@owner"], then reply with the single word DONE. Do not answer in prose.');
      await agent.stop();
      await posted;
      expect(room.messages.map((message) => message.content)).toContain("live check");
      expect(claude.sessionId(ROOM), "the CLI never named a session").toBeTruthy();
    } finally {
      await agent.stop();
    }
  }, 240_000);

  it("asks the host before a native tool runs, and runs it once approved", async () => {
    const started = await liveOrReport();
    const { agent, room, prompts, held, decide } = started;
    try {
      const posted = room.say("owner", 'Run the Bash tool exactly once with the command `printf live-approved`. Then reply with the single word DONE.');
      const prompt = await held();
      expect(prompt.toolName, "the CLI asked about something other than Bash").toBe("Bash");
      decide({ behavior: "allow", updatedInput: prompt.input ?? {} });
      await posted;
      expect(prompts.length).toBeGreaterThanOrEqual(1);
      const everything = JSON.stringify([room.messages, room.events("tool_call"), room.events("tool_result")]);
      expect(everything).toContain("live-approved");
    } finally {
      await agent.stop();
    }
  }, 240_000);

  it("refuses a native tool the host denies, and never runs it", async () => {
    const started = await liveOrReport();
    const { agent, room, held, decide } = started;
    try {
      const posted = room.say("owner", 'Run the Bash tool exactly once with the command `printf live-denied-marker`. Then reply with the single word DONE.');
      await held();
      decide({ behavior: "deny", message: "the host declined this run" });
      await posted;
      expect(JSON.stringify(room.messages)).not.toContain("live-denied-marker");
    } finally {
      await agent.stop();
    }
  }, 240_000);

  it("ends a turn quietly when the host stops it while an approval is held", async () => {
    const started = await liveOrReport();
    const { agent, room, held } = started;
    try {
      const posted = room.say("owner", 'Run the Bash tool exactly once with the command `printf should-not-run`. Then reply with the single word DONE.');
      await held();
      expect(await agent.cancelTurn(ROOM)).toBe(true);
      await posted;
      expect(room.messages.map((message) => message.content)).toEqual([]);
      expect(JSON.stringify(room.events("error"))).not.toContain("should-not-run");
    } finally {
      await agent.stop();
    }
  }, 240_000);

  it("continues the room's session across turns with the CLI's own --resume", async () => {
    const started = await liveOrReport();
    const { agent, claude, room } = started;
    try {
      const one = await room.say("owner", 'Remember the word MARIGOLD. Reply with the single word OK.');
      await one;
      const first = claude.sessionId(ROOM);
      expect(first).toBeTruthy();
      const two = await room.say("owner", 'Which word did I ask you to remember? Call band_send_message exactly once with that word as content and mentions ["@owner"].');
      await two;
      expect(claude.sessionId(ROOM)).toBe(first);
      expect(room.messages.map((message) => message.content).join(" ")).toContain("MARIGOLD");
    } finally {
      await agent.stop();
    }
  }, 300_000);

});

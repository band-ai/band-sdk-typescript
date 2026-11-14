import { describe, expect, it } from "vitest";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent } from "../src/agent/Agent";
import { BandLink } from "../src/platform/BandLink";
import { ClaudeCliAdapter, type ClaudePermissionDecision, type ClaudePermissionPrompt } from "../src/adapters/claude-cli";
import type { ClaudeExitInfo, ClaudeProcessOptions } from "../src/adapters/claude-cli/client";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { tmpRoot } from "./testUtils";

/**
 * Opt-in check against the installed Claude Code CLI. The offline suites replay
 * captured frames; this one drives the real program, so it is skipped unless
 * `BAND_CLAUDE_LIVE=1`, and a missing CLI or login fails the run as unavailable
 * rather than passing quietly - an untested adapter is not a working one.
 *
 * What the CLI decides to do is not scriptable, so a turn that ends without the
 * asked-for tool use is reported as such, with the events recorded, instead of
 * waiting out the turn timeout for a callback that was never going to come.
 */
const CLAUDE_BIN = process.env.BAND_CLAUDE_BIN ?? "/Users/cozmonat/.local/bin/claude";
const LIVE = process.env.BAND_CLAUDE_LIVE === "1";
const ROOM = "room-1";

interface Live {
  agent: Agent;
  claude: ClaudeCliAdapter;
  room: Awaited<ReturnType<BandPlatform["room"]>>;
  events: AgentEvent[];
  launches: string[][];
  prompts: ClaudePermissionPrompt[];
  /** Resolves with the prompt the CLI asked about, or null once the turn has ended without asking. */
  askedOrEnded: () => Promise<ClaudePermissionPrompt | null>;
  decide: (decision: ClaudePermissionDecision | undefined) => void;
  /** Resolves when this room's running turn reports its end. */
  turnEnd: () => Promise<AgentEvent>;
}

async function liveOrReport(): Promise<Live> {
  const reason = await unavailable();
  if (reason) {
    throw new Error(`UNAVAILABLE: the real-CLI check could not run - ${reason}`);
  }
  return live();
}

async function live(): Promise<Live> {
  const platform = BandPlatform.host([person("owner")]);
  const room = await platform.room(ROOM);
  const launches: string[][] = [];
  const prompts: ClaudePermissionPrompt[] = [];
  let release: (decision: ClaudePermissionDecision | undefined) => void = () => undefined;
  let waiting: ((prompt: ClaudePermissionPrompt) => void) | undefined;
  const spawnProcess = async (options: ClaudeProcessOptions) => {
    launches.push([...options.command]);
    // The real program, launched exactly as the adapter asks for it.
    const child = spawn(options.command[0]!, options.command.slice(1), {
      cwd: options.cwd,
      // The CLI is an installed program: it needs the host environment the adapter
      // does not name, so the adapter's env is layered over process.env.
      env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `\nspawn error: ${String(error)}`;
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise<ClaudeExitInfo>((resolve) => child.on("close", (code, signal) => resolve({ code, signal }))),
      endStdin: () => child.stdin.end(),
      stderrTail: () => stderr.slice(-2000),
      stop: async () => {
        child.kill("SIGKILL");
      },
    };
  };
  const claude = new ClaudeCliAdapter({
    cwd: tmpRoot(),
    command: [CLAUDE_BIN],
    spawnProcess,
    permissionTimeoutMs: 120_000,
    turnTimeoutMs: 180_000,
    resolvePermission: (prompt, signal) =>
      new Promise<ClaudePermissionDecision | undefined>((resolve) => {
        prompts.push(prompt);
        release = resolve;
        waiting?.(prompt);
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
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
    launches,
    prompts,
    decide: (decision) => release(decision),
    turnEnd: () =>
      new Promise<AgentEvent>((resolve) => {
        const stop = agent.observe((event) => {
          if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.stopped") {
            stop();
            resolve(event);
          }
        });
      }),
    askedOrEnded: () =>
      new Promise<ClaudePermissionPrompt | null>((resolve) => {
        const settle = () => resolve(prompts[prompts.length - 1] ?? null);
        waiting = (prompt) => resolve(prompt);
        if (prompts.length > 0) {
          settle();
          return;
        }
        // The turn ending is the honest deadline: a model that answered without a
        // tool use never asks, and the check says so instead of waiting it out.
        const stop = agent.observe((event) => {
          if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.stopped") {
            stop();
            settle();
          }
        });
      }),
  };
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
  const auth = spawnSync(CLAUDE_BIN, ["auth", "status"], { encoding: "utf8", timeout: 30_000, env: process.env });
  if (auth.status !== 0) {
    return `no Claude login reported by auth status: ${auth.stdout.slice(0, 200)}${auth.stderr.slice(0, 200)}`;
  }
  return null;
}

/** The frames the CLI produced, for a failure that would otherwise be a mystery. */
const record = (run: Live) =>
  `events=${JSON.stringify(run.events.map((event) => event.type))} toolCalls=${JSON.stringify(run.room.events("tool_call").map((event) => event.content))} prompts=${JSON.stringify(run.prompts.map((prompt) => prompt.toolName))} messages=${JSON.stringify(run.room.messages.map((message) => message.content))}`;

describe.skipIf(!LIVE)("Claude CLI adapter against the installed CLI", () => {
  it("launches apart from the host's own Claude configuration", async () => {
    const run = await liveOrReport();
    try {
      const posted = run.room.say("owner", "Reply with the single word OK.");
      const ended = run.turnEnd();
      await posted;
      await ended;
      const argv = run.launches[0] ?? [];
      const index = (flag: string) => argv.indexOf(flag);
      expect(index("--setting-sources"), "the CLI was launched without an empty settings source").toBeGreaterThan(-1);
      expect(argv[index("--setting-sources") + 1], "settings sources were not emptied").toBe("");
      expect(index("--strict-mcp-config"), "MCP was not pinned to what the adapter passes").toBeGreaterThan(-1);
      const config = JSON.parse(argv[index("--mcp-config") + 1]!) as { mcpServers: Record<string, { url?: string }> };
      expect(Object.keys(config.mcpServers), "servers other than Band's were passed").toEqual(["band"]);
      expect(config.mcpServers.band?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?/);
      expect(argv[index("--permission-prompt-tool") + 1]).toBe("mcp__band__band_permission_decision");
      expect(argv.slice(index("--disallowedTools") + 1)).toEqual(expect.arrayContaining(["ListAgents", "SendMessage", "SendFile", "ToolSearch"]));
    } finally {
      await run.agent.stop();
    }
  }, 180_000);

  it("warms a room and reports the CLI's own identity", async () => {
    const run = await liveOrReport();
    try {
      await expect(run.agent.rooms.allow(ROOM, { warm: true })).resolves.toBe(true);
      const ready = run.events.find((event) => event.type === "room.ready");
      expect(JSON.stringify(ready), "room.ready never reported the CLI's identity").toContain("claude-stream-json");
      expect(JSON.stringify(ready)).toContain("2.1.");
    } finally {
      await run.agent.stop();
    }
  }, 180_000);

  it("answers a turn over the Band MCP server", async () => {
    const run = await liveOrReport();
    try {
      const posted = run.room.say("owner", 'Call the band_send_message tool exactly once with content "live check" and mentions ["@owner"], then reply with the single word DONE.');
      const ended = run.turnEnd();
      await posted;
      await ended;
      expect(run.room.messages.map((message) => message.content), `the Band tool never reached the room: ${record(run)}`).toContain("live check");
      expect(run.claude.sessionId(ROOM), `the CLI never named a session: ${record(run)}`).toBeTruthy();
    } finally {
      await run.agent.stop();
    }
  }, 180_000);

  it("continues the room's session across turns with the CLI's own --resume", async () => {
    const run = await liveOrReport();
    try {
      const oneEnd = run.turnEnd();
      const one = await run.room.say("owner", 'Remember the word MARIGOLD. Reply with the single word OK.');
      await oneEnd;
      const first = run.claude.sessionId(ROOM);
      expect(first, `the first turn named no session: ${record(run)}`).toBeTruthy();
      const twoEnd = run.turnEnd();
      const two = await run.room.say("owner", 'Which word did I ask you to remember? Call band_send_message exactly once with that word as content and mentions ["@owner"].');
      await two;
      await twoEnd;
      expect(run.claude.sessionId(ROOM), `the session changed between turns: ${record(run)}`).toBe(first);
      expect(run.launches[1]?.[run.launches[1]!.indexOf("--resume") + 1], "the second process was not resumed").toBe(first);
      expect(run.room.messages.map((message) => message.content).join(" "), `the resumed turn forgot the word: ${record(run)}`).toContain("MARIGOLD");
      void one;
    } finally {
      await run.agent.stop();
    }
  }, 240_000);

  for (const outcome of ["approve", "deny"] as const) {
    it(`${outcome === "approve" ? "asks the host and runs" : "refuses"} a native tool the host ${outcome}s`, async () => {
      const run = await liveOrReport();
      const probeDir = join(tmpdir(), `band-approval-${outcome}-${Date.now()}`);
      mkdirSync(probeDir, { recursive: true });
      const target = join(probeDir, "approval-probe.txt");
      try {
        const ended = run.turnEnd();
        const posted = run.room.say("owner", `Use the Bash tool exactly once with the command \`touch ${target}\`. Then reply with the single word DONE.`);
        const prompt = await run.askedOrEnded();
        if (!prompt) {
          // The CLI decided to run nothing that needed asking. That is a reported
          // outcome, not a pass and not a hang.
          throw new Error(`NO ASK: the turn ended without a permission request; ${record(run)}`);
        }
        expect(prompt.toolName, `the CLI asked about ${prompt.toolName} rather than a native tool`).toMatch(/Bash|Write|Edit|Search|Glob/i);
        run.decide(outcome === "approve"
          // Hand back the input the CLI asked about, unchanged: an empty object
          // would approve a call with no command and run nothing.
          ? { behavior: "allow", updatedInput: (prompt.input ?? {}) as Record<string, unknown> }
          : { behavior: "deny", message: "the host declined this run" });
        await posted;
        await ended;
        expect(run.prompts.length, "the callback was consulted more than once").toBe(1);
        expect(existsSync(target), `${outcome}: ${target} exists=${String(outcome === "approve")} expected; ${record(run)}`).toBe(outcome === "approve");
        if (outcome === "deny") {
          // What the CLI reports back is the host's refusal, not a success: the
          // tool never ran, so no output and the refusal text stand in for it.
          const results = JSON.stringify(run.room.events("tool_result"));
          expect(results + record(run), "the denied tool reported success").toContain("the host declined this run");
        }
      } finally {
        await run.agent.stop();
        rmSync(probeDir, { recursive: true, force: true });
      }
    }, 180_000);
  }

  it("ends a turn quietly when the host stops it while an approval is held", async () => {
    const run = await liveOrReport();
    const probeDir = join(tmpdir(), `band-stop-${Date.now()}`);
    mkdirSync(probeDir, { recursive: true });
    const target = join(probeDir, "should-not-run.txt");
    try {
      const posted = run.room.say("owner", `Use the Bash tool exactly once with the command \`touch ${target}\`. Then reply with the single word DONE.`);
      const prompt = await run.askedOrEnded();
      if (!prompt) {
        throw new Error(`NO ASK: nothing was held to stop; ${record(run)}`);
      }
      expect(await run.agent.cancelTurn(ROOM), "the running turn could not be cancelled").toBe(true);
      await posted;
      expect(run.room.messages.map((message) => message.content), `a cancelled turn posted something: ${record(run)}`).toEqual([]);
      expect(existsSync(target), "the stopped turn ran its tool anyway").toBe(false);
      expect(run.events.filter((event) => event.type === "turn.failed"), `a cancelled turn reported a failure: ${record(run)}`).toEqual([]);
    } finally {
      await run.agent.stop();
      rmSync(probeDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("reports the files a probe left behind, so a failure can be read", async () => {
    const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith("band-approval-") || name.startsWith("band-stop-"));
    expect(leftovers, `probe directories survived: ${leftovers.join(", ")}`).toEqual([]);
  });
});

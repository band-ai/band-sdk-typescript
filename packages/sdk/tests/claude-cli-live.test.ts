import { describe, expect, it } from "vitest";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
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


interface Advertised {
  commands: Array<{ name: string; description?: string }>;
  skills: string[];
  mcpServers: string[];
}

/**
 * Launch the installed CLI directly in `cwd` and report what it advertises about
 * the configuration it loaded. The isolated run replays the argv the adapter
 * itself launched, so the comparison is with the adapter's real flags, not a
 * hand-written copy that could drift.
 */
function advertise(cwd: string, argv: string[], budgetMs = 90_000): Promise<Advertised> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* not a frame */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (ok: boolean) => {
      const control = frames.find((frame) => frame.type === "control_response");
      const response = (control?.response as { response?: Record<string, unknown> } | undefined)?.response ?? {};
      const init = frames.find((frame) => frame.type === "system" && frame.subtype === "init") ?? {};
      const commands = (response.commands ?? []) as Array<{ name: string; description?: string }>;
      resolve({
        commands,
        skills: (init.skills ?? []) as string[],
        mcpServers: ((init.mcp_servers ?? []) as Array<{ name: string }>).map((server) => server.name),
      });
      if (!ok) {
        reject(new Error(`the CLI produced no advertisement: ${stderr.slice(0, 300)}`));
      }
    };
    child.on("close", () => finish(frames.length > 0));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(frames.length > 0);
    }, budgetMs);
    child.on("close", () => clearTimeout(timer));
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "probe-1", request: { subtype: "initialize" } })}\n`);
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] }, parent_tool_use_id: null })}\n`);
  });
}

/** Project-scope configuration the test owns, in a directory of its own. */
function projectFixtures(root: string, marker: string) {
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  mkdirSync(join(root, ".claude", "skills", "probe-skill"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "probe-cmd.md"), "# Probe command\n\nSay OK.\n");
  writeFileSync(join(root, ".claude", "skills", "probe-skill", "SKILL.md"), "---\nname: probe-skill\ndescription: A skill the isolation check owns.\n---\n\nUse when probing.\n");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { command: "node", args: ["-e", "0"] } } }));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
  }));
}

/** A role plugin as task 9 ships one: a directory with a plugin manifest and a command. */
function rolePlugin(root: string) {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "band-role", version: "0.0.1" }));
  writeFileSync(join(root, "commands", "bandrole.md"), "# Band role\n\nSay OK.\n");
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
  it("discriminates project-scope configuration from the CLI's own, in a room the test owns", async () => {
    const run = await liveOrReport();
    const root = mkdtempSync(join(tmpdir(), "band-isolation-"));
    const marker = join(root, "hook-ran.marker");
    const roleRoot = join(root, "role");
    rolePlugin(roleRoot);
    projectFixtures(root, marker);
    try {
      // The adapter runs the room in this directory, and its argv is what the
      // isolated launch replays.
      const isolatedAdapter = new ClaudeCliAdapter({
        // The room's workspace is the fixture directory, so the CLI's own project
        // scope is exactly what the test planted.
        workspaceForRoom: () => root,
        command: [CLAUDE_BIN],
        spawnProcess: async (options) => {
          isolatedArgv.push([...options.command]);
          const child = spawn(options.command[0]!, options.command.slice(1), {
            cwd: options.cwd,
            env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });
          return {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            exited: new Promise<ClaudeExitInfo>((resolve) => child.on("close", (code, signal) => resolve({ code, signal }))),
            endStdin: () => child.stdin.end(),
            stderrTail: () => stderr.slice(-1000),
            stop: async () => {
              child.kill("SIGKILL");
            },
          };
        },
        turnTimeoutMs: 120_000,
      });
      const isolatedArgv: string[][] = [];
      const platform = BandPlatform.host([person("owner")]);
      const isoRoom = await platform.room(ROOM);
      const isoAgent = Agent.create({
        adapter: isolatedAdapter,
        agentId: AGENT_ID,
        apiKey: AGENT_API_KEY,
        link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
        roomFilter: () => true,
      });
      await isoAgent.start();
      try {
        // Await the turn's own end: the post resolves before the CLI is even
        // launched, and stopping early would leave nothing to replay.
        const ended = new Promise<void>((resolve) => {
          const stop = isoAgent.observe((event) => {
            if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.stopped") {
              stop();
              resolve();
            }
          });
        });
        await isoRoom.say("owner", "Reply with the single word OK.");
        await ended;
      } finally {
        await isoAgent.stop();
      }
      expect(isolatedArgv.length, "the adapter never launched the CLI in the test's room").toBeGreaterThan(0);

      // Positive control: with the host's own defaults, the fixtures are loaded.
      const base = [CLAUDE_BIN, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
      const host = await advertise(root, base);
      const hostNames = host.commands.map((command) => command.name);
      expect(hostNames, "the project command never appeared, so its later absence would prove nothing").toContain("probe-cmd");
      expect(host.skills, "the project skill never appeared").toContain("probe-skill");
      expect(host.mcpServers, "the project MCP server never appeared").toContain("probe");
      expect(existsSync(marker), "the project hook never ran, so its later absence would prove nothing").toBe(true);

      // The adapter's flags: none of the project's configuration reaches the room.
      rmSync(marker, { force: true });
      const isolated = await advertise(root, isolatedArgv[0]!);
      const isolatedNames = isolated.commands.map((command) => command.name);
      expect(isolatedNames, "a project-scope command reached the room").not.toContain("probe-cmd");
      expect(isolated.skills, "a project-scope skill reached the room").not.toContain("probe-skill");
      expect(isolated.mcpServers, "anything but the server the adapter passed reached the room").toEqual(["band"]);
      expect(existsSync(marker), "a project-scope hook ran").toBe(false);
      // No advertised command claims user, project or local scope.
      for (const command of isolated.commands) {
        expect(`${command.name} ${command.description ?? ""}`, "a scoped command reached the isolated room").not.toMatch(/\((user|project|local)\)/);
      }

      // And an explicitly passed role plugin still loads under those flags.
      const withRole = await advertise(root, [...isolatedArgv[0]!, "--plugin-dir", roleRoot]);
      const roleNames = withRole.commands.map((command) => command.name).filter((name) => name.startsWith("band-role:"));
      expect(roleNames, "the role plugin's commands did not survive isolation").toEqual(["band-role:bandrole"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await run.agent.stop();
    }
  }, 600_000);

});
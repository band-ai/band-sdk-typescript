/** `/band:agents`: saving agents checked against Band, choosing one per project, and what each session holds. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import {
  agentsFilePath,
  nameFromHandle,
  projectSettingsPath,
  readSavedAgents,
  writeSavedAgents,
} from "../../src/config";
import type { SessionChange } from "../../src/sessions";
import { BandRestPeer, type PeerAgent } from "../support/bandRestPeer";
import { withDirs, type ClaudeCodeDirs } from "../support/claudeCodeDirs";

const DOCS: PeerAgent = { id: "agent-docs", apiKey: "key-docs", name: "Docs", handle: "alex/docs" };
const SDK: PeerAgent = { id: "agent-sdk", apiKey: "key-sdk", name: "SDK", handle: "alex/sdk" };
const UNHANDLED: PeerAgent = { id: "agent-plain", apiKey: "key-plain", name: "Plain", handle: null };
/** Band answers its identity with a status the client doesn't retry. */
const TROUBLED: PeerAgent = { id: "agent-troubled", apiKey: "key-troubled", name: "Troubled", handle: "alex/troubled", failure: 400 };
const OWNER_ONLY = 0o600;

const MAIN: PeerAgent = { id: "agent-main", apiKey: "key-main", name: "Main", handle: "alex/main" };
/** How much earlier an older status was recorded. */
const STALE_MS = 60_000;

const it = withDirs.extend<{ band: BandRestPeer }>({
  band: async ({}, use) => {
    await using band = await BandRestPeer.start([DOCS, SDK, UNHANDLED, TROUBLED]);
    await use(band);
  },
});

function save(dirs: ClaudeCodeDirs, ...agents: PeerAgent[]): void {
  writeSavedAgents(
    dirs.dataDir,
    Object.fromEntries(agents.map((agent) => [nameFromHandle(agent.handle!), { agentId: agent.id, apiKey: agent.apiKey, handle: agent.handle }])),
  );
}

/** The parent of this test's parent: an ancestor of the command only by walking up from its parent. */
function grandparentPid(): number {
  return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
}

/** A session in this project whose server reported `change` while connecting as `agent`. */
function sessionAs(dirs: ClaudeCodeDirs, sessionId: string, agent: string, change: SessionChange): void {
  dirs.openStatus(sessionId, agent).record(change);
}

describe("add", () => {
  it("saves an agent Band accepts, named after its handle, readable only by the user", async ({ dirs, band }) => {
    const output = await dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved "docs" (@alex/docs). Use it in a project with /band:agents use docs');
    expect(readSavedAgents(dirs.dataDir)).toEqual({ docs: { agentId: DOCS.id, apiKey: DOCS.apiKey, handle: DOCS.handle } });
    expect(statSync(agentsFilePath(dirs.dataDir)).mode & 0o777).toBe(OWNER_ONLY);
  });

  it("saves under the name given", async ({ dirs, band }) => {
    await dirs.agents("add", DOCS.id, DOCS.apiKey, "writer", "--ws-url", band.wsUrl);

    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["writer"]);
  });

  it("saves nothing when Band refuses the key", async ({ dirs, band }) => {
    await expect(dirs.agents("add", DOCS.id, "wrong-key", "--ws-url", band.wsUrl)).rejects.toThrow(
      "Band rejected that agent ID or API key. Nothing was saved.",
    );
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("saves nothing when the key belongs to another agent", async ({ dirs, band }) => {
    await expect(dirs.agents("add", DOCS.id, SDK.apiKey, "--ws-url", band.wsUrl)).rejects.toThrow(
      `That API key belongs to agent ${SDK.id}, not ${DOCS.id}. Nothing was saved.`,
    );
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("refuses an agent already saved, leaving the saved agents as they were", async ({ dirs, band }) => {
    save(dirs, DOCS);
    const before = readFileSync(agentsFilePath(dirs.dataDir), "utf8");

    await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, "again", "--ws-url", band.wsUrl)).rejects.toThrow(`Agent ${DOCS.id} is already set up as "docs".`);
    expect(readFileSync(agentsFilePath(dirs.dataDir), "utf8")).toBe(before);
  });

  it("saves an agent again after it was removed, though a session still runs as it", async ({ dirs, band }) => {
    dirs.writeStatus("session-1", { agent: "docs", agentId: DOCS.id });

    expect(await dirs.agents("add", DOCS.id, DOCS.apiKey, "writer", "--ws-url", band.wsUrl)).toContain('✓ Saved "writer"');
  });

  it("refuses a name that can't name an agent", async ({ dirs, band }) => {
    for (const name of ["my agent", "alex/docs"]) {
      await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, name, "--ws-url", band.wsUrl)).rejects.toThrow(`"${name}" can't name an agent`);
    }
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("names an agent without a handle after its Band name", async ({ dirs, band }) => {
    const output = await dirs.agents("add", UNHANDLED.id, UNHANDLED.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved "Plain". Use it in a project with /band:agents use Plain');
  });

  it("keeps every agent saved by adds running at once", async ({ dirs, band }) => {
    await Promise.all([dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl), dirs.agents("add", SDK.id, SDK.apiKey, "--ws-url", band.wsUrl)]);

    expect(Object.keys(readSavedAgents(dirs.dataDir)).sort()).toEqual(["docs", "sdk"]);
  });

  it("keeps an agent removed while Band was checking another", async ({ dirs, band }) => {
    save(dirs, DOCS);
    const adding = dirs.agents("add", SDK.id, SDK.apiKey, "--ws-url", band.wsUrl);

    await dirs.agents("remove", "docs");
    await adding;

    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["sdk"]);
  });

  it("saves nothing when Band fails otherwise", async ({ dirs, band }) => {
    await expect(dirs.agents("add", TROUBLED.id, TROUBLED.apiKey, "--ws-url", band.wsUrl)).rejects.toThrow(
      "Band couldn't check that agent, so nothing was saved: Status code: 400",
    );
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("refuses a name already taken", async ({ dirs, band }) => {
    save(dirs, DOCS);

    await expect(dirs.agents("add", SDK.id, SDK.apiKey, "docs", "--ws-url", band.wsUrl)).rejects.toThrow('An agent named "docs" is already saved.');
    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["docs"]);
  });
});

describe("use", () => {
  it("selects the agent in the project's local settings, keeping what else is there", async ({ dirs }) => {
    save(dirs, DOCS);
    const settingsPath = projectSettingsPath(dirs.projectDir);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { DEBUG: "1" } }));

    const output = await dirs.agents("use", "docs");

    expect(output).toBe('✓ This project now connects as "docs" (@alex/docs). To switch this session, run /mcp and reconnect the band server; new sessions here connect as it.');
    expect(dirs.projectSettings()).toEqual({ permissions: { allow: ["Bash(ls)"] }, env: { DEBUG: "1", BAND_AGENT: "docs" } });
  });

  it("refuses an agent that isn't saved, naming those that are", async ({ dirs }) => {
    save(dirs, DOCS);

    await expect(dirs.agents("use", "sdk")).rejects.toThrow('No Band agent named "sdk". Saved: docs.');
    expect(existsSync(projectSettingsPath(dirs.projectDir))).toBe(false);
  });
});

describe("remove", () => {
  it("forgets the agent and warns when this project still selects it", async ({ dirs }) => {
    save(dirs, DOCS, SDK);
    await dirs.agents("use", "docs");

    const output = await dirs.agents("remove", "docs");

    expect(output).toBe(
      '✓ Removed "docs". This project still selects it: pick another with /band:agents use <name>. Other projects that select it won\'t connect until they pick another.',
    );
    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["sdk"]);
  });

  it("forgets an agent this project doesn't select without a warning about it", async ({ dirs }) => {
    save(dirs, DOCS, SDK);
    await dirs.agents("use", "docs");

    expect(await dirs.agents("remove", "sdk")).toBe('✓ Removed "sdk". Other projects that select it won\'t connect until they pick another.');
  });

  it("refuses an agent that isn't saved", async ({ dirs }) => {
    await expect(dirs.agents("remove", "sdk")).rejects.toThrow('No Band agent named "sdk". Saved: none.');
  });

  it("refuses a name that is only a property every object has", async ({ dirs }) => {
    await expect(dirs.agents("remove", "constructor")).rejects.toThrow('No Band agent named "constructor".');
  });

});

describe("status", () => {
  it("shows what this session is connected as and which agents other sessions hold", async ({ dirs }) => {
    save(dirs, MAIN, DOCS, SDK);
    sessionAs(dirs, "session-1", "docs", { agentId: DOCS.id, handle: DOCS.handle, state: "connected" });
    sessionAs(dirs, "session-2", "main", { agentId: MAIN.id, handle: MAIN.handle, state: "connected" });

    expect(await dirs.agents("status", "session-1")).toBe(
      [
        'This session: connected as "docs" (@alex/docs).',
        "",
        "Agents:",
        `  main  @alex/main  in use (session in ${dirs.projectDir})`,
        "  docs  @alex/docs  ← this session",
        "  sdk   @alex/sdk   free",
      ].join("\n"),
    );
  });

  it("names the free agents and the next step when this session was refused", async ({ dirs }) => {
    save(dirs, DOCS, SDK);
    sessionAs(dirs, "session-1", "docs", { agentId: DOCS.id, handle: DOCS.handle, state: "connected" });
    sessionAs(dirs, "session-2", "docs", { agentId: DOCS.id, state: "refused", error: 'Band agent "docs" is already connected from another session.' });

    expect(await dirs.agents("status", "session-2")).toBe(
      [
        'This session: refused. Band agent "docs" is already connected from another session.',
        "Free: sdk. Run /band:agents use sdk, then reconnect the band server in /mcp.",
        "",
        "Agents:",
        `  docs  @alex/docs  in use (session in ${dirs.projectDir})`,
        "  sdk   @alex/sdk   free",
      ].join("\n"),
    );
  });

  it("doesn't offer the agent this session was refused, though no session here holds it", async ({ dirs }) => {
    save(dirs, MAIN, DOCS);
    sessionAs(dirs, "session-1", "docs", { agentId: DOCS.id, state: "refused", error: "Taken." });

    expect(await dirs.agents("status", "session-1")).toBe(
      [
        "This session: refused. Taken.",
        "Free: main. Run /band:agents use main, then reconnect the band server in /mcp.",
        "",
        "Agents:",
        "  main  @alex/main  free",
        "  docs  @alex/docs  in use elsewhere",
      ].join("\n"),
    );
  });

  it("says no agent is free when every one is held", async ({ dirs }) => {
    save(dirs, MAIN, DOCS);
    sessionAs(dirs, "session-1", "main", { agentId: MAIN.id, state: "connected" });
    sessionAs(dirs, "session-2", "docs", { agentId: DOCS.id, state: "connected" });
    sessionAs(dirs, "session-3", "docs", { agentId: DOCS.id, state: "refused", error: "Taken." });

    expect(await dirs.agents("status", "session-3")).toContain(
      "This session: refused. Taken.\nNo agent is free: add one with /band:agents add <agent_id> <api_key>.",
    );
  });

  it("shows a session still connecting, and one that found no agent to connect as", async ({ dirs }) => {
    save(dirs, MAIN, DOCS);
    sessionAs(dirs, "session-1", "main", { agentId: MAIN.id });
    dirs.writeStatus("session-2", { agent: null, agentId: null, state: "failed", error: "Band agents main, docs are saved, and this project picks none." });

    expect(await dirs.agents("status", "session-1")).toContain('This session: connecting as "main" (@alex/main).');
    expect(await dirs.agents("status", "session-2")).toContain("This session: not connected. Band agents main, docs are saved, and this project picks none.");
  });

  it("says how to add the first agent", async ({ dirs }) => {
    expect(await dirs.agents("status", "session-1")).toBe(
      ["This session: no Band server is running in it.", "", "No agent saved yet: add one with /band:agents add <agent_id> <api_key>."].join("\n"),
    );
  });

  it("shows an agent held under another name as in use", async ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: { agentId: MAIN.id, apiKey: MAIN.apiKey, handle: MAIN.handle } });
    dirs.writeStatus("session-1", { agent: "main", agentId: MAIN.id });

    expect(await dirs.agents("status", "session-2")).toContain(`  docs  @alex/main  in use (session in ${dirs.projectDir})`);
  });

  it("names the session connected to an agent, not one still connecting to it", async ({ dirs }) => {
    save(dirs, DOCS);
    sessionAs(dirs, "session-a", "docs", { agentId: DOCS.id, state: "connected" });
    sessionAs(dirs, "session-z", "docs", { agentId: DOCS.id, state: "connecting" });

    expect(await dirs.agents("status", "session-a")).toContain("docs  @alex/docs  ← this session");
    expect(await dirs.agents("status", "session-z")).toContain(`docs  @alex/docs  in use (session in ${dirs.projectDir})`);
  });

  it("shows a session that didn't say where it runs as another session", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { agentId: DOCS.id, projectDir: null });

    expect(await dirs.agents("status", "session-2")).toContain("docs  @alex/docs  in use (another session)");
  });

  it("shows a session's project under ~ when it is in the home directory", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { agentId: DOCS.id, projectDir: join(homedir(), "repo", "api") });

    expect(await dirs.agents("status", "session-2")).toContain(`in use (session in ${join("~", "repo", "api")})`);
  });

  it("still knows this session once /clear gave it a new ID, by its Claude Code process", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { pid: grandparentPid(), handle: DOCS.handle });

    const output = await dirs.agents("status", "session-after-clear");

    expect(output).toContain('This session: connected as "docs" (@alex/docs).');
    expect(output).toContain("docs  @alex/docs  ← this session");
  });

  it("takes the latest server of this Claude Code process after /clear, over an earlier one's refusal", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { pid: grandparentPid(), state: "refused", error: "Taken.", updatedAt: Date.now() - STALE_MS });
    dirs.writeStatus("session-2", { pid: grandparentPid(), handle: DOCS.handle, state: "connected" });

    expect(await dirs.agents("status", "session-after-clear")).toContain('This session: connected as "docs" (@alex/docs).');
  });

  it("tells this terminal's session from another resumed with the same ID", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { handle: DOCS.handle, state: "connected" });
    dirs.writeStatus("session-1", { pid: process.ppid, serverPid: process.ppid, state: "refused", error: "Taken." });

    expect(await dirs.agents("status", "session-1")).toContain("This session: refused. Taken.");
  });
});

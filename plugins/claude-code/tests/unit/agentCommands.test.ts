/** `/band:agents`: saving agents checked against Band, choosing one per project, and what each session holds. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import {
  agentCredentials,
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
const OWNER_ONLY = 0o600;

const MAIN_ID = "agent-main";
/** How much earlier an older status was recorded. */
const STALE_MS = 60_000;

const it = withDirs.extend<{ band: BandRestPeer }>({
  band: async ({}, use) => {
    await using band = await BandRestPeer.start([DOCS, SDK, UNHANDLED]);
    await use(band);
  },
});

function save(dirs: ClaudeCodeDirs, ...agents: PeerAgent[]): void {
  writeSavedAgents(
    dirs.dataDir,
    Object.fromEntries(agents.map((agent) => [nameFromHandle(agent.handle!), { agentId: agent.id, apiKey: agent.apiKey, handle: agent.handle }])),
  );
}

/** A session in this project whose server reported `change` while connecting as `agent`. */
function sessionAs(dirs: ClaudeCodeDirs, sessionId: string, agent: string, change: SessionChange): void {
  dirs.openStatus(sessionId, agent).record(change);
}

describe("add", () => {
  it("saves an agent Band accepts, named after its handle, readable only by the user", async ({ dirs, band }) => {
    const output = await dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved "docs" (@alex/docs). Use it in a project with /band:agents use docs');
    expect(agentCredentials("docs", dirs.env("session-1"))).toEqual({ agentId: DOCS.id, apiKey: DOCS.apiKey, wsUrl: band.wsUrl });
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

  it("refuses the default agent under another name, once a session has connected as it", async ({ dirs, band }) => {
    sessionAs(dirs, "session-1", "default", { agentId: DOCS.id, state: "connected" });

    await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl)).rejects.toThrow(`Agent ${DOCS.id} is already set up as "default".`);
  });

  it("saves an agent again after it was removed, though a session still runs as it", async ({ dirs, band }) => {
    dirs.writeStatus("session-1", { agent: "docs", agentId: DOCS.id });

    expect(await dirs.agents("add", DOCS.id, DOCS.apiKey, "writer", "--ws-url", band.wsUrl)).toContain('✓ Saved "writer"');
  });

  it("refuses a name that can't name an agent", async ({ dirs, band }) => {
    for (const name of ["default", "my agent", "alex/docs"]) {
      await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, name, "--ws-url", band.wsUrl)).rejects.toThrow(`"${name}" can't name an agent`);
    }
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("names an agent without a handle after its Band name", async ({ dirs, band }) => {
    const output = await dirs.agents("add", UNHANDLED.id, UNHANDLED.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved "Plain". Use it in a project with /band:agents use Plain');
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

    expect(output).toBe('✓ This project now connects as "docs" (@alex/docs). Start a new Claude Code session here to switch.');
    expect(dirs.projectSettings()).toEqual({ permissions: { allow: ["Bash(ls)"] }, env: { DEBUG: "1", BAND_AGENT: "docs" } });
  });

  it("selects the default explicitly, over a name the project's shared settings commit", async ({ dirs }) => {
    save(dirs, DOCS);
    await dirs.agents("use", "docs");

    await dirs.agents("use", "default");

    expect(dirs.projectSettings()).toEqual({ env: { BAND_AGENT: "default" } });
  });

  it("refuses an agent that isn't saved, naming those that are", async ({ dirs }) => {
    save(dirs, DOCS);

    await expect(dirs.agents("use", "sdk")).rejects.toThrow('No Band agent named "sdk". Agents: default, docs.');
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
    await expect(dirs.agents("remove", "sdk")).rejects.toThrow('No Band agent named "sdk". Agents: default.');
  });

  it("keeps the default, which the plugin's settings own", async ({ dirs }) => {
    await expect(dirs.agents("remove", "default")).rejects.toThrow("change it in /plugin");
  });
});

describe("status", () => {
  it("shows what this session is connected as and which agents other sessions hold", async ({ dirs }) => {
    save(dirs, DOCS, SDK);
    sessionAs(dirs, "session-1", "docs", { agentId: DOCS.id, handle: DOCS.handle, state: "connected" });
    sessionAs(dirs, "session-2", "default", { agentId: MAIN_ID, handle: "alex/main", state: "connected" });

    expect(await dirs.agents("status", "session-1")).toBe(
      [
        'This session: connected as "docs" (@alex/docs).',
        "",
        "Agents:",
        `  default  @alex/main  in use (session in ${dirs.projectDir})`,
        "  docs     @alex/docs  ← this session",
        "  sdk      @alex/sdk   free",
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
        "Free: default, sdk. Run /band:agents use default, then start a new Claude Code session here.",
        "",
        "Agents:",
        `  default              free`,
        `  docs     @alex/docs  in use (session in ${dirs.projectDir})`,
        "  sdk      @alex/sdk   free",
      ].join("\n"),
    );
  });

  it("says no agent is free when every one is held", async ({ dirs }) => {
    save(dirs, DOCS);
    sessionAs(dirs, "session-1", "default", { agentId: MAIN_ID, state: "connected" });
    sessionAs(dirs, "session-2", "docs", { agentId: DOCS.id, state: "connected" });
    sessionAs(dirs, "session-3", "docs", { agentId: DOCS.id, state: "refused", error: "Taken." });

    expect(await dirs.agents("status", "session-3")).toContain(
      "This session: refused. Taken.\nNo agent is free: add one with /band:agents add <agent_id> <api_key>.",
    );
  });

  it("shows a session still connecting, and one that failed with why", async ({ dirs }) => {
    sessionAs(dirs, "session-1", "default", { agentId: MAIN_ID, handle: "alex/main" });
    sessionAs(dirs, "session-2", "docs", { state: "failed", error: 'No Band agent named "docs". Agents: default.' });

    expect(await dirs.agents("status", "session-1")).toContain('This session: connecting as "default" (@alex/main).');
    expect(await dirs.agents("status", "session-2")).toContain('This session: not connected. No Band agent named "docs". Agents: default.');
  });

  it("shows an agent held under another name as in use", async ({ dirs }) => {
    writeSavedAgents(dirs.dataDir, { docs: { agentId: MAIN_ID, apiKey: "key-main", handle: "alex/main" } });
    dirs.writeStatus("session-1", { agent: "default", agentId: MAIN_ID });

    expect(await dirs.agents("status", "session-2")).toContain(`  docs     @alex/main  in use (session in ${dirs.projectDir})`);
  });

  it("names the session connected to an agent, not one still connecting to it", async ({ dirs }) => {
    save(dirs, DOCS);
    sessionAs(dirs, "session-a", "docs", { agentId: DOCS.id, state: "connected" });
    sessionAs(dirs, "session-z", "docs", { agentId: DOCS.id, state: "connecting" });

    expect(await dirs.agents("status", "session-a")).toContain("docs     @alex/docs  ← this session");
    expect(await dirs.agents("status", "session-z")).toContain(`docs     @alex/docs  in use (session in ${dirs.projectDir})`);
  });

  it("shows a session's project under ~ when it is in the home directory", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { agentId: DOCS.id, projectDir: join(homedir(), "repo", "api") });

    expect(await dirs.agents("status", "session-2")).toContain(`in use (session in ${join("~", "repo", "api")})`);
  });

  it("still knows this session once /clear gave it a new ID, by its Claude Code process", async ({ dirs }) => {
    save(dirs, DOCS);
    sessionAs(dirs, "session-1", "docs", { agentId: DOCS.id, handle: DOCS.handle, state: "connected" });

    const output = await dirs.agents("status", "session-after-clear");

    expect(output).toContain('This session: connected as "docs" (@alex/docs).');
    expect(output).toContain("docs     @alex/docs  ← this session");
  });

  it("takes the latest server of this Claude Code process after /clear, over an earlier one's refusal", async ({ dirs }) => {
    save(dirs, DOCS);
    dirs.writeStatus("session-1", { pid: process.ppid, state: "refused", error: "Taken.", updatedAt: Date.now() - STALE_MS });
    dirs.writeStatus("session-2", { pid: process.ppid, handle: DOCS.handle, state: "connected" });

    expect(await dirs.agents("status", "session-after-clear")).toContain('This session: connected as "docs" (@alex/docs).');
  });

  it("says when no Band server runs in this session", async ({ dirs }) => {
    expect(await dirs.agents("status", "session-1")).toBe(["This session: no Band server is running in it.", "", "Agents:", "  default    free"].join("\n"));
  });
});

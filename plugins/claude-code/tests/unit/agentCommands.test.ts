/** `/band:agents`: saving agents checked against Band, choosing one per project, and what each session holds. */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { agentCredentials, AGENTS_FILE, PROJECT_SETTINGS_FILE, readSavedAgents, writeSavedAgents } from "../../src/config";
import { SessionStatusFile } from "../../src/sessions";
import { BandRestPeer, type PeerAgent } from "../support/bandRestPeer";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";

const DOCS: PeerAgent = { id: "agent-docs", apiKey: "key-docs", name: "Docs", handle: "alex/docs" };
const SDK: PeerAgent = { id: "agent-sdk", apiKey: "key-sdk", name: "SDK", handle: "alex/sdk" };
const OWNER_ONLY = 0o600;

const it = test.extend<{ dirs: ClaudeCodeDirs; band: BandRestPeer }>({
  dirs: async ({}, use) => {
    using dirs = new ClaudeCodeDirs();
    await use(dirs);
  },
  band: async ({}, use) => {
    await using band = await BandRestPeer.start([DOCS, SDK]);
    await use(band);
  },
});

function save(dirs: ClaudeCodeDirs, ...agents: PeerAgent[]): void {
  writeSavedAgents(
    dirs.dataDir,
    Object.fromEntries(agents.map((agent) => [agent.handle!.split("/")[1], { agentId: agent.id, apiKey: agent.apiKey, handle: agent.handle }])),
  );
}

describe("add", () => {
  it("saves an agent Band accepts, named after its handle, readable only by the user", async ({ dirs, band }) => {
    const output = await dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved "docs" (@alex/docs). Use it in a project with /band:agents use docs');
    expect(agentCredentials("docs", dirs.env("session-1"))).toEqual({ agentId: DOCS.id, apiKey: DOCS.apiKey, wsUrl: band.wsUrl });
    expect(statSync(join(dirs.dataDir, AGENTS_FILE)).mode & 0o777).toBe(OWNER_ONLY);
  });

  it("saves under the name given", async ({ dirs, band }) => {
    await dirs.agents("add", DOCS.id, DOCS.apiKey, "writer", "--ws-url", band.wsUrl);

    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["writer"]);
  });

  it("saves nothing when Band refuses the key", async ({ dirs, band }) => {
    await expect(dirs.agents("add", DOCS.id, "wrong-key", "--ws-url", band.wsUrl)).rejects.toThrow(
      "Band rejected that agent ID or API key. Nothing was saved.",
    );
    expect(existsSync(join(dirs.dataDir, AGENTS_FILE))).toBe(false);
  });

  it("saves nothing when the key belongs to another agent", async ({ dirs, band }) => {
    await expect(dirs.agents("add", DOCS.id, SDK.apiKey, "--ws-url", band.wsUrl)).rejects.toThrow(
      `That API key belongs to agent ${SDK.id}, not ${DOCS.id}. Nothing was saved.`,
    );
    expect(existsSync(join(dirs.dataDir, AGENTS_FILE))).toBe(false);
  });

  it("refuses an agent already saved", async ({ dirs, band }) => {
    save(dirs, DOCS);

    await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, "again", "--ws-url", band.wsUrl)).rejects.toThrow(`Agent ${DOCS.id} is already saved as "docs".`);
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
    const settingsPath = join(dirs.projectDir, PROJECT_SETTINGS_FILE);
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
    expect(existsSync(join(dirs.projectDir, PROJECT_SETTINGS_FILE))).toBe(false);
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

  it("keeps the default, which the plugin's settings own", async ({ dirs }) => {
    await expect(dirs.agents("remove", "default")).rejects.toThrow("change it in /plugin");
  });
});

describe("status", () => {
  it("shows what this session is connected as and which agents other sessions hold", async ({ dirs }) => {
    save(dirs, DOCS, SDK);
    SessionStatusFile.open(dirs.env("session-1", "docs"), "docs")!.record({ handle: DOCS.handle, state: "connected" });
    SessionStatusFile.open(dirs.env("session-2"), "default")!.record({ handle: "alex/main", state: "connected" });

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
    SessionStatusFile.open(dirs.env("session-1", "docs"), "docs")!.record({ handle: DOCS.handle, state: "connected" });
    SessionStatusFile.open(dirs.env("session-2", "docs"), "docs")!.record({ state: "refused", error: 'Band agent "docs" is already connected from another session.' });

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

  it("says when no Band server runs in this session", async ({ dirs }) => {
    expect(await dirs.agents("status", "session-1")).toBe(["This session: no Band server is running in it.", "", "Agents:", "  default    free"].join("\n"));
  });
});

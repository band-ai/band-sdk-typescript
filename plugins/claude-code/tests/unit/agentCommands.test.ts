/** `/band:agents`: saving agents checked against Band, removing them, and what this session is. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { describe, expect } from "vitest";

import { agentsFilePath, nameFromHandle, readSavedAgents, writeSavedAgents } from "../../src/config";
import { SESSION_TEXT } from "../../src/sessions";
import { BandRestPeer, type PeerAgent } from "../support/bandRestPeer";
import { withDirs, type ClaudeCodeDirs } from "../support/claudeCodeDirs";

const DOCS: PeerAgent = { id: "agent-docs", apiKey: "key-docs", name: "Docs", handle: "alex/docs" };
const SDK: PeerAgent = { id: "agent-sdk", apiKey: "key-sdk", name: "SDK", handle: "alex/sdk" };
const UNHANDLED: PeerAgent = { id: "agent-plain", apiKey: "key-plain", name: "Plain", handle: null };
/** Band answers its identity with a status the client doesn't retry. */
const TROUBLED: PeerAgent = { id: "agent-troubled", apiKey: "key-troubled", name: "Troubled", handle: "alex/troubled", failure: 400 };
const OWNER_ONLY = 0o600;
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


describe("add", () => {
  it("saves an agent Band accepts, named after its handle, readable only by the user", async ({ dirs, band }) => {
    const output = await dirs.agents("add", DOCS.id, DOCS.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved docs (@alex/docs). Say \'join Band\' to connect a session as it.');
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

    expect(await dirs.agents("add", DOCS.id, DOCS.apiKey, "writer", "--ws-url", band.wsUrl)).toContain("✓ Saved writer");
  });

  it("refuses a name that can't name an agent", async ({ dirs, band }) => {
    for (const name of ["my agent", "alex/docs"]) {
      await expect(dirs.agents("add", DOCS.id, DOCS.apiKey, name, "--ws-url", band.wsUrl)).rejects.toThrow(`"${name}" can't name an agent`);
    }
    expect(existsSync(agentsFilePath(dirs.dataDir))).toBe(false);
  });

  it("names an agent without a handle after its Band name", async ({ dirs, band }) => {
    const output = await dirs.agents("add", UNHANDLED.id, UNHANDLED.apiKey, "--ws-url", band.wsUrl);

    expect(output).toBe('✓ Saved Plain. Say \'join Band\' to connect a session as it.');
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

describe("remove", () => {
  it("forgets the agent", async ({ dirs }) => {
    save(dirs, DOCS, SDK);

    expect(await dirs.agents("remove", "docs")).toBe('✓ Removed "docs".');
    expect(Object.keys(readSavedAgents(dirs.dataDir))).toEqual(["sdk"]);
  });

  it("refuses an agent that isn't saved", async ({ dirs }) => {
    await expect(dirs.agents("remove", "sdk")).rejects.toThrow('No Band agent named "sdk". Saved: none.');
  });

  it("refuses a name that is only a property every object has", async ({ dirs }) => {
    await expect(dirs.agents("remove", "constructor")).rejects.toThrow('No Band agent named "constructor".');
  });
});

describe("status", () => {
  it("prints this session's state and its sentence", async ({ dirs }) => {
    dirs.writeStatus("session-1", { state: "off", sentence: SESSION_TEXT.notPicked });
    dirs.writeStatus("session-2", { sentence: SESSION_TEXT.connected("docs (@alex/docs)") });

    expect(await dirs.agents("status", "session-1")).toBe(`off: ${SESSION_TEXT.notPicked}`);
    expect(await dirs.agents("status", "session-2")).toBe("connected: Connected as docs (@alex/docs).");
  });

  it("says how to start Band when no Band server runs in this session", async ({ dirs }) => {
    expect(await dirs.agents("status", "session-1")).toBe(`off: ${SESSION_TEXT.noServer}`);
  });

  it("finds this session by its Claude Code process when given no ID, never printing the usage", async ({ dirs }) => {
    dirs.writeStatus("session-1", { pid: grandparentPid() });

    expect(await dirs.agents("status")).toBe(`connected: ${SESSION_TEXT.connected("docs")}`);
  });

  it("still knows this session once /clear gave it a new ID, by its Claude Code process", async ({ dirs }) => {
    dirs.writeStatus("session-1", { pid: grandparentPid() });

    expect(await dirs.agents("status", "session-after-clear")).toBe(`connected: ${SESSION_TEXT.connected("docs")}`);
  });

  it("takes the latest server of this Claude Code process after /clear", async ({ dirs }) => {
    dirs.writeStatus("session-1", { pid: grandparentPid(), state: "off", sentence: SESSION_TEXT.notPicked, updatedAt: Date.now() - STALE_MS });
    dirs.writeStatus("session-2", { pid: grandparentPid() });

    expect(await dirs.agents("status", "session-after-clear")).toBe(`connected: ${SESSION_TEXT.connected("docs")}`);
  });

  it("tells this terminal's session from another resumed with the same ID", async ({ dirs }) => {
    dirs.writeStatus("session-1", {});
    dirs.writeStatus("session-1", { pid: process.ppid, serverPid: process.ppid, state: "off", sentence: SESSION_TEXT.takenOver("@alex/docs") });

    expect(await dirs.agents("status", "session-1")).toBe(`off: ${SESSION_TEXT.takenOver("@alex/docs")}`);
  });
});

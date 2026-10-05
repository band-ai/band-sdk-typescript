/** Session status files: true while the session they describe is, and never in the channel's way. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { NoopLogger } from "@band-ai/sdk/core";
import { describe, expect } from "vitest";

import { agentHolders, liveSessions, sessionLocation, SessionStatusFile, statusPath, type SessionStatus } from "../../src/sessions";
import { withDirs as it } from "../support/claudeCodeDirs";

const READ_ONLY = 0o500;
const OWNER_ALL = 0o700;

/** The pid of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

/** A status as it is held in memory, for the functions that take one. */
function status(overrides: Partial<SessionStatus>): SessionStatus {
  return {
    agent: "docs",
    agentId: "agent-docs",
    handle: null,
    pid: process.ppid,
    serverPid: process.pid,
    projectDir: null,
    state: "connected",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("session status", () => {
  it("is kept by the session's server until it ends cleanly", ({ dirs }) => {
    const file = dirs.openStatus("session-1", "docs");
    expect(dirs.session("session-1")).toMatchObject({
      agent: "docs",
      agentId: null,
      pid: process.ppid,
      serverPid: process.pid,
      projectDir: dirs.projectDir,
      state: "connecting",
    });

    file.record({ agentId: "agent-docs", handle: "alex/docs", state: "connected" });
    expect(dirs.session("session-1")).toMatchObject({ agentId: "agent-docs", handle: "alex/docs", state: "connected" });

    file.remove();
    expect(dirs.session("session-1")).toBeUndefined();
  });

  it("isn't kept outside Claude Code", () => {
    expect(SessionStatusFile.open({}, "docs", new NoopLogger())).toBeUndefined();
  });

  it("is dropped once its Claude Code process is gone", async ({ dirs }) => {
    const path = dirs.writeStatus("session-gone", { pid: await exitedPid(), state: "refused" });

    expect(liveSessions(dirs.dataDir).has("session-gone")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("no longer holds its agent once the server is gone, though Claude Code lives on", async ({ dirs }) => {
    const path = dirs.writeStatus("session-killed", { serverPid: await exitedPid(), state: "connected" });

    expect(liveSessions(dirs.dataDir).has("session-killed")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a refusal after its server exits, for as long as Claude Code runs", async ({ dirs }) => {
    dirs.writeStatus("session-refused", { serverPid: await exitedPid(), state: "refused" });

    expect(liveSessions(dirs.dataDir).get("session-refused")).toMatchObject({ state: "refused" });
  });

  it("ignores a file that isn't a status", ({ dirs }) => {
    const path = statusPath(dirs.dataDir, "session-garbled");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(liveSessions(dirs.dataDir).has("session-garbled")).toBe(false);
  });

  it("never fails the server when it can't be written", ({ dirs }) => {
    chmodSync(dirs.dataDir, READ_ONLY);
    try {
      const file = dirs.openStatus("session-1", "docs");

      expect(() => file.record({ state: "connected" })).not.toThrow();
      expect(() => file.remove()).not.toThrow();
    } finally {
      chmodSync(dirs.dataDir, OWNER_ALL);
    }
  });
});

describe("the session holding an agent", () => {
  it("is the one connected, not one still connecting to the same agent", () => {
    const sessions = new Map([
      ["session-connected", status({ state: "connected" })],
      ["session-connecting", status({ state: "connecting" })],
    ]);

    expect(agentHolders(sessions).get("agent-docs")?.sessionId).toBe("session-connected");
    expect(agentHolders(new Map([...sessions].reverse())).get("agent-docs")?.sessionId).toBe("session-connected");
  });

  it("is found by Band agent, whatever name each session gave it", ({ dirs }) => {
    dirs.writeStatus("session-default", { agent: "default", agentId: "agent-main", projectDir: "/repo/api" });
    const refused = dirs.openStatus("session-docs", "docs");
    refused.record({ agentId: "agent-main" });

    expect(refused.holder()).toMatchObject({ agent: "default", projectDir: "/repo/api" });
  });
});

describe("where a session runs", () => {
  it("is shown under ~ inside the home directory", () => {
    expect(sessionLocation(status({ projectDir: join(homedir(), "repo", "api") }))).toBe(join("~", "repo", "api"));
  });

  it("is shown whole when it only shares the home directory's name as a prefix", () => {
    const sibling = `${homedir()}x${join("/", "repo")}`;

    expect(sessionLocation(status({ projectDir: sibling }))).toBe(sibling);
  });
});

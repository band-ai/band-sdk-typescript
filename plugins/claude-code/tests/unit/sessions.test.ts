/** Session status files: true while the session they describe is, and never in the channel's way. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { NoopLogger } from "@band-ai/sdk/core";
import { describe, expect } from "vitest";

import { liveSessions, SESSION_TEXT, sessionLocation, SessionStatusFile, statusPath } from "../../src/sessions";
import { sessionStatus as status, withDirs as it, type ClaudeCodeDirs } from "../support/claudeCodeDirs";

const READ_ONLY = 0o500;
const OWNER_ALL = 0o700;

/** The pid of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

/** The directory holding the status files. */
function sessionsDir(dirs: ClaudeCodeDirs): string {
  return dirname(statusPath(dirs.dataDir, status()));
}

describe("session status", () => {
  it("is kept by the session's server until it ends cleanly", ({ dirs }) => {
    const file = dirs.openStatus("session-1");
    expect(dirs.session("session-1")).toMatchObject({
      agent: null,
      agentId: null,
      pid: process.ppid,
      serverPid: process.pid,
      projectDir: dirs.projectDir,
      state: "off",
      sentence: SESSION_TEXT.notPicked,
    });

    file.record({ agent: "docs", agentId: "agent-docs", handle: "alex/docs", state: "connected", sentence: SESSION_TEXT.connected("docs") });
    expect(dirs.session("session-1")).toMatchObject({ agentId: "agent-docs", handle: "alex/docs", state: "connected" });

    file.remove();
    expect(dirs.session("session-1")).toBeUndefined();
  });

  it("isn't kept outside Claude Code", () => {
    expect(SessionStatusFile.open({}, SESSION_TEXT.notPicked, new NoopLogger())).toBeUndefined();
  });

  it("is dropped once its Claude Code process is gone", async ({ dirs }) => {
    const path = dirs.writeStatus("session-gone", { pid: await exitedPid(), state: "off" });

    expect(dirs.session("session-gone")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("no longer holds its agent once the server is gone, though Claude Code lives on", async ({ dirs }) => {
    const path = dirs.writeStatus("session-killed", { serverPid: await exitedPid(), state: "connected" });

    expect(dirs.session("session-killed")).toBeUndefined();
    // The server may have recorded it off just before exiting: only a reader that read that would know.
    expect(existsSync(path)).toBe(true);
  });

  it("keeps an off status after its server exits, for as long as Claude Code runs", async ({ dirs }) => {
    dirs.writeStatus("session-off", { serverPid: await exitedPid(), state: "off" });

    expect(dirs.session("session-off")).toMatchObject({ state: "off" });
  });

  it("ignores a file that isn't a status", ({ dirs }) => {
    const path = statusPath(dirs.dataDir, status({ sessionId: "session-garbled" }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(liveSessions(dirs.dataDir)).toEqual([]);
  });

  it("is kept apart from another server's in the same session, as claude --resume in a second terminal starts one", ({ dirs }) => {
    dirs.writeStatus("session-1", { serverPid: process.ppid, state: "connected" });
    const resumed = dirs.openStatus("session-1");

    expect(liveSessions(dirs.dataDir).map(({ state }) => state).sort()).toEqual(["connected", "off"]);

    resumed.remove();
    expect(dirs.session("session-1")).toMatchObject({ serverPid: process.ppid, state: "connected" });
  });

  it("never fails the server when it can't be written", ({ dirs }) => {
    const file = dirs.openStatus("session-1");
    chmodSync(sessionsDir(dirs), READ_ONLY);
    try {
      expect(() => file.record({ state: "connected", sentence: SESSION_TEXT.connected("docs") })).not.toThrow();
      expect(() => file.remove()).not.toThrow();
    } finally {
      chmodSync(sessionsDir(dirs), OWNER_ALL);
    }
    expect(dirs.session("session-1")).toMatchObject({ state: "off" });
  });
});

describe("where a session runs", () => {
  it("is shown whole when it only shares the home directory's name as a prefix", () => {
    const sibling = `${homedir()}x${join("/", "repo")}`;

    expect(sessionLocation(status({ projectDir: sibling }))).toBe(sibling);
  });
});

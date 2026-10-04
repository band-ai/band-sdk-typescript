/** Session status files outlive the server, but never the Claude Code session. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { liveSessions, SessionStatusFile, statusPath, type SessionStatus } from "../../src/sessions";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";

/** The pid of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

describe("session status", () => {
  it("is kept by the session's server until it ends cleanly", () => {
    using dirs = new ClaudeCodeDirs();
    const status = SessionStatusFile.open(dirs.env("session-1"), "docs")!;
    expect(dirs.session("session-1")).toEqual({ agent: "docs", handle: null, pid: process.ppid, projectDir: dirs.projectDir, state: "connecting" });

    status.record({ handle: "alex/docs", state: "connected" });
    expect(dirs.session("session-1")).toMatchObject({ handle: "alex/docs", state: "connected" });

    status.remove();
    expect(dirs.session("session-1")).toBeUndefined();
  });

  it("isn't kept outside Claude Code", () => {
    expect(SessionStatusFile.open({}, "docs")).toBeUndefined();
  });

  it("is dropped once its Claude Code process is gone", async () => {
    using dirs = new ClaudeCodeDirs();
    const dead: SessionStatus = { agent: "docs", handle: null, pid: await exitedPid(), projectDir: null, state: "refused" };
    const path = statusPath(dirs.dataDir, "session-gone");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(dead));

    expect(liveSessions(dirs.dataDir).has("session-gone")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

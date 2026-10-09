/**
 * The directories Claude Code gives the plugin, fresh for each test: its data
 * directory and the project a session runs in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopLogger } from "@band-ai/sdk/core";
import { test } from "vitest";

import { runAgentsCommand } from "../../src/agentCommands";
import { AGENT_SELECT_ENV, CLAUDE_ENV, readSavedAgents, writeSavedAgents, type SavedAgent } from "../../src/config";
import { writeFileAtomically } from "../../src/files";
import { liveSessions, SESSION_TEXT, SessionStatusFile, statusPath, type SessionStatus } from "../../src/sessions";

/**
 * A status as a server records it: by default, a running server in another live Claude Code process (this test's
 * own, which isn't among the ancestors of a command run in it), connected as "docs".
 */
export function sessionStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    agent: "docs",
    agentId: "agent-docs",
    handle: null,
    pid: process.pid,
    serverPid: process.pid,
    projectDir: null,
    state: "connected",
    sentence: SESSION_TEXT.connected("docs"),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export class ClaudeCodeDirs implements Disposable {
  public readonly dataDir = mkdtempSync(join(tmpdir(), "band-plugin-data-"));
  public readonly projectDir = mkdtempSync(join(tmpdir(), "band-project-"));

  /** The environment Claude Code gives the plugin's server in session `sessionId`, connecting as `agent` when named. */
  public env(sessionId: string, agent?: string): Record<string, string> {
    return {
      [CLAUDE_ENV.pluginData]: this.dataDir,
      [CLAUDE_ENV.projectDir]: this.projectDir,
      [CLAUDE_ENV.sessionId]: sessionId,
      ...(agent ? { [AGENT_SELECT_ENV]: agent } : {}),
    };
  }

  /** Saves `agents` alongside those already saved, as `/band:agents add` does. */
  public save(agents: Readonly<Record<string, SavedAgent>>): void {
    writeSavedAgents(this.dataDir, { ...readSavedAgents(this.dataDir), ...agents });
  }

  /** The status file a server in session `sessionId` keeps, off with `sentence` until it records more. */
  public openStatus(sessionId: string, sentence: string = SESSION_TEXT.notPicked): SessionStatusFile {
    return SessionStatusFile.open(this.env(sessionId), sentence, new NoopLogger())!;
  }

  /** Writes the status a server in session `sessionId` would have left, by default from this project. Returns the file's path. */
  public writeStatus(sessionId: string, overrides: Partial<SessionStatus> = {}): string {
    const status = sessionStatus({ sessionId, projectDir: this.projectDir, ...overrides });
    const path = statusPath(this.dataDir, status);
    writeFileAtomically(path, JSON.stringify(status));
    return path;
  }

  /** The arguments the skill passes before a command. */
  public get cliContext(): string[] {
    return ["--data-dir", this.dataDir];
  }

  /** Runs a `/band:agents` command as the skill does. */
  public agents(...args: string[]): Promise<string> {
    return runAgentsCommand([...this.cliContext, ...args]);
  }

  public session(sessionId: string): SessionStatus | undefined {
    return liveSessions(this.dataDir).find((status) => status.sessionId === sessionId);
  }

  public [Symbol.dispose](): void {
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.projectDir, { recursive: true, force: true });
  }
}

/** A test with fresh Claude Code directories. */
export const withDirs = test.extend<{ dirs: ClaudeCodeDirs }>({
  dirs: async ({}, use) => {
    using dirs = new ClaudeCodeDirs();
    await use(dirs);
  },
});

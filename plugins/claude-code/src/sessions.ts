import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { CLAUDE_ENV, type Env } from "./config";

/** One status file per Claude Code session, in the plugin's data directory. */
export const SESSIONS_DIR = "sessions";

const STATUS_EXTENSION = ".json";
const PARTIAL_EXTENSION = ".partial";

export type SessionState = "connecting" | "connected" | "refused" | "failed";

/** What a session's Band server last reported. */
export interface SessionStatus {
  /** The agent's name, as `BAND_AGENT` selected it. */
  readonly agent: string;
  readonly handle: string | null;
  /** The Claude Code process: the status outlives the server it describes, but not the session. */
  readonly pid: number;
  readonly projectDir: string | null;
  readonly state: SessionState;
  readonly error?: string;
}

export type SessionChange = Partial<Pick<SessionStatus, "handle" | "state" | "error">>;

/** The status file a session's Band server keeps current. */
export class SessionStatusFile {
  private status: SessionStatus;

  private constructor(
    private readonly dataDir: string,
    private readonly sessionId: string,
    agent: string,
    projectDir: string | null,
  ) {
    this.status = { agent, handle: null, pid: process.ppid, projectDir, state: "connecting" };
    mkdirSync(join(dataDir, SESSIONS_DIR), { recursive: true });
    this.write();
  }

  /** Records `agent` connecting for the session Claude Code started the server in; none outside Claude Code. */
  public static open(env: Env, agent: string): SessionStatusFile | undefined {
    const dataDir = env[CLAUDE_ENV.pluginData];
    const sessionId = env[CLAUDE_ENV.sessionId];
    return dataDir && sessionId ? new SessionStatusFile(dataDir, sessionId, agent, env[CLAUDE_ENV.projectDir] ?? null) : undefined;
  }

  public record(change: SessionChange): void {
    this.status = { ...this.status, ...change };
    this.write();
  }

  public failed(error: unknown): void {
    this.record({ state: "failed", error: error instanceof Error ? error.message : String(error) });
  }

  /** Another live session connected as the same agent. */
  public holder(): SessionStatus | undefined {
    return [...liveSessions(this.dataDir)].find(
      ([sessionId, status]) => sessionId !== this.sessionId && status.agent === this.status.agent && status.state === "connected",
    )?.[1];
  }

  /** The session ended cleanly: nothing left to report. */
  public remove(): void {
    rmSync(statusPath(this.dataDir, this.sessionId), { force: true });
  }

  private write(): void {
    const path = statusPath(this.dataDir, this.sessionId);
    // A rename replaces the file whole, so a reader never parses half a status.
    writeFileSync(`${path}${PARTIAL_EXTENSION}`, JSON.stringify(this.status));
    renameSync(`${path}${PARTIAL_EXTENSION}`, path);
  }
}

/** Every live session's status by session ID; a status whose Claude Code process is gone is deleted. */
export function liveSessions(dataDir: string): Map<string, SessionStatus> {
  const dir = join(dataDir, SESSIONS_DIR);
  if (!existsSync(dir)) {
    return new Map();
  }
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(STATUS_EXTENSION));
  const sessions = new Map<string, SessionStatus>();
  for (const { name } of files) {
    const path = join(dir, name);
    const status = readStatus(path);
    if (status && isAlive(status.pid)) {
      sessions.set(basename(name, STATUS_EXTENSION), status);
    } else {
      rmSync(path, { force: true });
    }
  }
  return sessions;
}

export function statusPath(dataDir: string, sessionId: string): string {
  return join(dataDir, SESSIONS_DIR, `${sessionId}${STATUS_EXTENSION}`);
}

/** None when the session ended between listing and reading. */
function readStatus(path: string): SessionStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** This process's parent, its parent, and so on: Claude Code runs a command through a shell of its own. */
export function ancestorPids(): Set<number> {
  const pids = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !pids.has(pid); pid = parentPid(pid)) {
    pids.add(pid);
  }
  return pids;
}

/** 0, ending the walk, where `ps` can't tell (Windows has none). */
function parentPid(pid: number): number {
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

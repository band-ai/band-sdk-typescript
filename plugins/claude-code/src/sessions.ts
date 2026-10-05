import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Logger } from "@band-ai/sdk/core";

import { CLAUDE_ENV, type Env } from "./config";
import { writeFileAtomically } from "./files";

/** One status file per Band server, in the plugin's data directory. */
const SESSIONS_DIR = "sessions";
const STATUS_EXTENSION = ".json";

export type SessionState = "connecting" | "connected" | "refused" | "failed";

/** A session in these states holds its agent, for as long as its server runs. */
const HOLDING_STATES: ReadonlySet<SessionState> = new Set(["connecting", "connected"]);

/** What a session's Band server last reported. */
export interface SessionStatus {
  /** The Claude Code session the server started in. Not unique: `claude --resume` in a second terminal shares it. */
  readonly sessionId: string;
  /** The agent's saved name; none when the server found no agent to connect as. */
  readonly agent: string | null;
  /** The Band agent's ID, once the server has resolved it. */
  readonly agentId: string | null;
  readonly handle: string | null;
  /** The Claude Code process: a refusal or failure outlives the server that recorded it, but not the session. */
  readonly pid: number;
  /** The server itself: a holding status is only true while it runs. */
  readonly serverPid: number;
  readonly projectDir: string | null;
  readonly state: SessionState;
  readonly error?: string;
  /** When the status was last recorded, in ms since the epoch. */
  readonly updatedAt: number;
}

export type SessionChange = Partial<Pick<SessionStatus, "agentId" | "handle" | "state" | "error">>;

/**
 * The status file a session's Band server keeps current. It only reports on the session for `/band:agents`,
 * so failing to keep it is logged and never fails the channel.
 */
export class SessionStatusFile {
  private status: SessionStatus;
  private readonly path: string;

  private constructor(
    private readonly dataDir: string,
    sessionId: string,
    agent: string | null,
    projectDir: string | null,
    private readonly logger: Logger,
  ) {
    this.status = {
      sessionId,
      agent,
      agentId: null,
      handle: null,
      pid: process.ppid,
      serverPid: process.pid,
      projectDir,
      state: "connecting",
      updatedAt: Date.now(),
    };
    this.path = statusPath(dataDir, this.status);
    this.write();
  }

  /** Records `agent` connecting for the session Claude Code started the server in; none outside Claude Code. */
  public static open(env: Env, agent: string | null, logger: Logger): SessionStatusFile | undefined {
    const dataDir = env[CLAUDE_ENV.pluginData];
    const sessionId = env[CLAUDE_ENV.sessionId];
    if (dataDir && !sessionId) {
      logger.warn(`${CLAUDE_ENV.sessionId} is not set, so /band:agents can't show this session`);
    }
    return dataDir && sessionId ? new SessionStatusFile(dataDir, sessionId, agent, env[CLAUDE_ENV.projectDir] ?? null, logger) : undefined;
  }

  public record(change: SessionChange): void {
    this.status = { ...this.status, ...change, updatedAt: Date.now() };
    this.write();
  }

  public failed(error: unknown): void {
    this.record({ state: "failed", error: error instanceof Error ? error.message : String(error) });
  }

  /** Another live session holding Band agent `agentId`; none when that can't be told. */
  public holder(agentId: string): SessionStatus | undefined {
    try {
      const others = liveSessions(this.dataDir).filter((status) => statusPath(this.dataDir, status) !== this.path);
      return agentHolders(others).get(agentId);
    } catch (error) {
      this.logger.warn("Could not read the other sessions' Band status", { error });
      return undefined;
    }
  }

  /** The session ended cleanly: nothing left to report. */
  public remove(): void {
    try {
      rmSync(this.path, { force: true });
    } catch (error) {
      this.logger.warn("Could not remove the session's Band status", { error });
    }
  }

  private write(): void {
    try {
      writeFileAtomically(this.path, JSON.stringify(this.status));
    } catch (error) {
      this.logger.warn("Could not record the session's Band status for /band:agents", { error });
    }
  }
}

/**
 * Every status still true. A status whose Claude Code process is gone is deleted: nothing can rewrite it.
 * One whose server is gone while Claude Code runs is left alone, as that server may have just replaced it.
 */
export function liveSessions(dataDir: string): SessionStatus[] {
  const dir = join(dataDir, SESSIONS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(STATUS_EXTENSION));
  const sessions: SessionStatus[] = [];
  for (const { name } of files) {
    const path = join(dir, name);
    const status = readStatus(path);
    if (status && !isAlive(status.pid)) {
      rmSync(path, { force: true });
    } else if (status && isLive(status)) {
      sessions.push(status);
    }
  }
  return sessions;
}

/** The session holding each Band agent, by agent ID: a connected session over one still connecting. */
export function agentHolders(sessions: readonly SessionStatus[]): Map<string, SessionStatus> {
  const holders = new Map<string, SessionStatus>();
  for (const status of sessions) {
    if (status.agentId !== null && HOLDING_STATES.has(status.state) && holders.get(status.agentId)?.state !== "connected") {
      holders.set(status.agentId, status);
    }
  }
  return holders;
}

/** Where a session runs, as the user reads it: its project, under `~` when in the home directory. */
export function sessionLocation({ projectDir }: SessionStatus): string | null {
  if (!projectDir) {
    return null;
  }
  const fromHome = relative(homedir(), projectDir);
  const inHome = !isAbsolute(fromHome) && fromHome.split(sep)[0] !== "..";
  return inHome ? join("~", fromHome) : projectDir;
}

/** The file only the server that recorded `status` writes. */
export function statusPath(dataDir: string, { sessionId, serverPid }: Pick<SessionStatus, "sessionId" | "serverPid">): string {
  return join(dataDir, SESSIONS_DIR, `${sessionId}.${serverPid}${STATUS_EXTENSION}`);
}

/** None when the session ended between listing and reading, or the file isn't a status. */
function readStatus(path: string): SessionStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

/** A refusal or failure stands while Claude Code runs; holding an agent, only while the server does too. */
function isLive(status: SessionStatus): boolean {
  return !HOLDING_STATES.has(status.state) || isAlive(status.serverPid);
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

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Logger } from "@band-ai/sdk/core";

import { LAUNCH_COMMANDS } from "./channelFlag";
import { AGENT_SELECT_ENV, AGENTS_COMMAND, CLAUDE_ENV, type Env } from "./config";
import { writeFileAtomically } from "./files";
import { parentPid } from "./processes";

/** One status file per Band server, in the plugin's data directory. */
const SESSIONS_DIR = "sessions";
const STATUS_EXTENSION = ".json";

type SessionState = "connected" | "off";

/** A connected session holds its agent, for as long as its server runs. */
const HOLDING_STATE: SessionState = "connected";

/** What the user says to have Claude connect the session, and to add an agent. */
export const JOIN_PHRASE = "'join Band'";
export const ADD_PHRASE = "'add a Band agent'";

/** The one sentence a session's status shows, each ending in what to do next. */
export const SESSION_TEXT = {
  noServer: `No Band server runs in this session. Restart with ${LAUNCH_COMMANDS}.`,
  noChannel: `Band is off: this session was started without Band's channel. Restart with ${LAUNCH_COMMANDS}.`,
  noAgent: `Band is off: no agent is saved yet. Get the agent's ID and API key from Band, then say ${ADD_PHRASE}.`,
  asking: "Waiting for the agent question to be answered.",
  notPicked: `Band is off: no agent was picked. Say ${JOIN_PHRASE} to pick one.`,
  takenOver: (agent: string) => `Band is off: another session took over ${agent}. Say ${JOIN_PHRASE} to pick an agent.`,
  connectFailed: (name: string, reason: string) => `Band is off: couldn't connect as ${name}: ${reason}. Say ${JOIN_PHRASE} to try again.`,
  ended: (name: string, reason: string) => `Band is off: the connection as ${name} ended: ${reason}. Say ${JOIN_PHRASE} to reconnect.`,
  noElicitation: `Band is off: this client can't show the agent question. Start it with ${AGENT_SELECT_ENV}=<name>.`,
  unsavedAgent: (name: string) => `Band is off: ${AGENT_SELECT_ENV} names ${name}, which isn't saved.`,
  connected: (agent: string) => `Connected as ${agent}.`,
} as const;

/** What a session's Band server last reported. */
export interface SessionStatus {
  /** The Claude Code session the server started in. Not unique: `claude --resume` in a second terminal shares it. */
  readonly sessionId: string;
  /** The saved name of the agent the server is connected as, or last was. */
  readonly agent: string | null;
  readonly agentId: string | null;
  readonly handle: string | null;
  /** The Claude Code process: an off status outlives the server that recorded it, but not the session. */
  readonly pid: number;
  /** The server itself: a holding status is only true while it runs. */
  readonly serverPid: number;
  readonly projectDir: string | null;
  readonly state: SessionState;
  /** One of `SESSION_TEXT`. */
  readonly sentence: string;
  /** When the status was last recorded, in ms since the epoch. */
  readonly updatedAt: number;
}

export type SessionChange = Pick<SessionStatus, "state" | "sentence"> & Partial<Pick<SessionStatus, "agent" | "agentId" | "handle">>;

/**
 * The status file a session's Band server keeps current. It only reports on the session for `/band:agents`,
 * so failing to keep it is logged and never fails the channel.
 */
export class SessionStatusFile {
  private status: SessionStatus;
  private readonly path: string;

  private constructor(
    dataDir: string,
    sessionId: string,
    sentence: string,
    projectDir: string | null,
    private readonly logger: Logger,
  ) {
    this.status = {
      sessionId,
      agent: null,
      agentId: null,
      handle: null,
      pid: process.ppid,
      serverPid: process.pid,
      projectDir,
      state: "off",
      sentence,
      updatedAt: Date.now(),
    };
    this.path = statusPath(dataDir, this.status);
    this.write();
  }

  /** Records the session Claude Code started the server in as off, with `sentence`; none outside Claude Code. */
  public static open(env: Env, sentence: string, logger: Logger): SessionStatusFile | undefined {
    const dataDir = env[CLAUDE_ENV.pluginData];
    const sessionId = env[CLAUDE_ENV.sessionId];
    if (dataDir && !sessionId) {
      logger.warn(`${CLAUDE_ENV.sessionId} is not set, so ${AGENTS_COMMAND} can't show this session`);
    }
    return dataDir && sessionId ? new SessionStatusFile(dataDir, sessionId, sentence, env[CLAUDE_ENV.projectDir] ?? null, logger) : undefined;
  }

  public record(change: SessionChange): void {
    this.status = { ...this.status, ...change, updatedAt: Date.now() };
    this.write();
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
      this.logger.warn(`Could not record the session's Band status for ${AGENTS_COMMAND}`, { error });
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
    if (!status) {
      continue;
    }
    if (!isAlive(status.pid)) {
      rmSync(path, { force: true });
    } else if (isLive(status)) {
      sessions.push(status);
    }
  }
  return sessions;
}

/** The session holding each Band agent, by agent ID. */
export function agentHolders(sessions: readonly SessionStatus[]): Map<string, SessionStatus> {
  const holders = new Map<string, SessionStatus>();
  for (const status of sessions) {
    if (status.agentId !== null && status.state === HOLDING_STATE) {
      holders.set(status.agentId, status);
    }
  }
  return holders;
}

/**
 * The status this session's server keeps: the one with this session's ID, or of the Claude Code process running
 * this command when that isn't one. `/clear` and `/resume` give the session a new ID but keep the server, which
 * recorded the ID it started with; `claude --resume` in a second terminal shares the ID with another process.
 */
export function thisSession(sessions: readonly SessionStatus[], sessionId?: string): SessionStatus | undefined {
  const withId = sessions.filter((session) => session.sessionId === sessionId);
  if (withId.length === 1) {
    return withId[0];
  }
  const candidates = withId.length > 0 ? withId : sessions;
  if (candidates.length === 0) {
    return undefined;
  }
  const ancestors = ancestorPids();
  return candidates.filter((session) => ancestors.has(session.pid)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
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

/** A session as another one names it: by where it runs, when known. */
export function sessionPlace(status: SessionStatus): string {
  const location = sessionLocation(status);
  return location ? `session in ${location}` : "another session";
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

/** An off status stands while Claude Code runs; holding an agent, only while the server does too. */
function isLive(status: SessionStatus): boolean {
  return status.state !== HOLDING_STATE || isAlive(status.serverPid);
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
function ancestorPids(): Set<number> {
  const pids = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !pids.has(pid); pid = parentPid(pid)) {
    pids.add(pid);
  }
  return pids;
}

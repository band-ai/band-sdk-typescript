import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { BandLink } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { AgentIdentity } from "@band-ai/sdk/rest";

import {
  ADD_HINT,
  AGENT_SELECT_ENV,
  agentNames,
  assertAgentName,
  atHandle,
  DEFAULT_AGENT_NAME,
  nameFromHandle,
  projectSettingsPath,
  readSavedAgents,
  unknownAgentMessage,
  USE_HINT,
  useCommand,
  writeSavedAgents,
  type SavedAgent,
} from "./config";
import { writeFileAtomically } from "./files";
import { agentHolders, ancestorPids, liveSessions, sessionLocation, type SessionStatus } from "./sessions";

/** An agent no session holds. */
const FREE = "free";
/** How Band answers credentials it doesn't accept. */
const REJECTED_STATUS_CODES = new Set([401, 403]);
const USAGE = `Usage: agents.js --data-dir <dir> --project-dir <dir> <command>
  status <session_id>
  add <agent_id> <api_key> [name] [--ws-url <url>]
  use <name>
  remove <name>`;

interface Context {
  readonly dataDir: string;
  readonly projectDir: string;
}

/** Runs one `/band:agents` command and resolves with what to show; rejects with a message for the user. */
export async function runAgentsCommand(argv: readonly string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "data-dir": { type: "string" }, "project-dir": { type: "string" }, "ws-url": { type: "string" } },
    allowPositionals: true,
  });
  const dataDir = values["data-dir"];
  const projectDir = values["project-dir"];
  const [command, ...args] = positionals;
  if (!dataDir || !projectDir) {
    throw new Error(USAGE);
  }
  const context = { dataDir, projectDir };
  switch (command) {
    case "status":
      return status(context, required(args[0]));
    case "add":
      return add(context, required(args[0]), required(args[1]), args[2], values["ws-url"]);
    case "use":
      return use(context, required(args[0]));
    case "remove":
      return remove(context, required(args[0]));
    default:
      throw new Error(USAGE);
  }
}

function required(arg: string | undefined): string {
  if (!arg) {
    throw new Error(USAGE);
  }
  return arg;
}

function status({ dataDir }: Context, currentSessionId: string): string {
  const saved = readSavedAgents(dataDir);
  const sessions = liveSessions(dataDir);
  const mine = thisSession(sessions, currentSessionId);
  const holders = agentHolders(sessions);
  // The default's ID and handle are known only from a session that connected as it.
  const sessionAs = (name: string): SessionStatus | undefined => sessions.find((session) => session.agent === name && session.agentId !== null);
  const idOf = (name: string): string | undefined => saved[name]?.agentId ?? sessionAs(name)?.agentId ?? undefined;
  const handleOf = (name: string): string | null => saved[name]?.handle ?? sessionAs(name)?.handle ?? null;
  const usage = (name: string): string => {
    const agentId = idOf(name);
    const holder = agentId ? holders.get(agentId) : undefined;
    if (holder) {
      return holder === mine ? "← this session" : `in use (${where(holder)})`;
    }
    // Band refused it, so a session this machine doesn't know of holds it.
    return mine?.state === "refused" && agentId === mine.agentId ? "in use elsewhere" : FREE;
  };

  const rows = agentNames(saved).map((name) => {
    const handle = handleOf(name);
    return [name, handle ? atHandle(handle) : "", usage(name)];
  });
  const free = rows.filter(([, , use]) => use === FREE).map(([name]) => name);
  return [describeSession(mine, handleOf, free), "", "Agents:", ...table(rows)].join("\n");
}

/**
 * The status this session's server keeps: the one with this session's ID, or of the Claude Code process running
 * this command when that isn't one. `/clear` and `/resume` give the session a new ID but keep the server, which
 * recorded the ID it started with; `claude --resume` in a second terminal shares the ID with another process.
 */
function thisSession(sessions: readonly SessionStatus[], sessionId: string): SessionStatus | undefined {
  const withId = sessions.filter((session) => session.sessionId === sessionId);
  if (withId.length === 1) {
    return withId[0];
  }
  const ancestors = ancestorPids();
  const ours = (withId.length > 0 ? withId : sessions).filter((session) => ancestors.has(session.pid));
  return ours.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function describeSession(mine: SessionStatus | undefined, handleOf: (name: string) => string | null, free: readonly string[]): string {
  switch (mine?.state) {
    case undefined:
      return "This session: no Band server is running in it.";
    case "connecting":
    case "connected":
      return `This session: ${mine.state} as ${labeled(mine.agent, handleOf(mine.agent))}.`;
    case "refused":
      return [`This session: refused. ${mine.error ?? ""}`, nextStep(free)].join("\n");
    case "failed":
      return `This session: not connected. ${mine.error ?? ""}`;
  }
}

/** An agent as the user knows it: its name, and its Band handle when known. */
function labeled(name: string, handle: string | null | undefined): string {
  return `"${name}"${handle ? ` (${atHandle(handle)})` : ""}`;
}

function nextStep(free: readonly string[]): string {
  return free.length > 0
    ? `Free: ${free.join(", ")}. Run ${useCommand(free[0])}, then start a new Claude Code session here.`
    : `No agent is free: add one with ${ADD_HINT}.`;
}

function where(status: SessionStatus): string {
  const location = sessionLocation(status);
  return location ? `session in ${location}` : "another session";
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`.trimEnd());
}

async function add({ dataDir }: Context, agentId: string, apiKey: string, name: string | undefined, wsUrl: string | undefined): Promise<string> {
  const credentials: AgentCredentials = { agentId, apiKey, ...(wsUrl ? { wsUrl } : {}) };
  const identity = await fetchIdentity(credentials);
  if (identity.id !== agentId) {
    throw new Error(`That API key belongs to agent ${identity.id}, not ${agentId}. Nothing was saved.`);
  }
  const chosen = name ?? (identity.handle ? nameFromHandle(identity.handle) : undefined) ?? identity.name;
  assertAgentName(chosen);
  // Read only now: another add or remove may have run while Band answered.
  const saved = readSavedAgents(dataDir);
  // The default's ID is known only from a session connected as it.
  const knownAs =
    Object.keys(saved).find((savedName) => saved[savedName].agentId === agentId) ??
    liveSessions(dataDir).find((session) => session.agent === DEFAULT_AGENT_NAME && session.agentId === agentId)?.agent;
  if (knownAs) {
    throw new Error(`Agent ${agentId} is already set up as "${knownAs}".`);
  }
  if (saved[chosen]) {
    throw new Error(`An agent named "${chosen}" is already saved. Pick another name: ${ADD_HINT} <name>`);
  }
  const agent: SavedAgent = { ...credentials, handle: identity.handle ?? null };
  writeSavedAgents(dataDir, { ...saved, [chosen]: agent });
  return `✓ Saved ${labeled(chosen, agent.handle)}. Use it in a project with ${useCommand(chosen)}`;
}

async function fetchIdentity(credentials: AgentCredentials): Promise<AgentIdentity> {
  try {
    return await new BandLink(credentials).rest.getAgentMe();
  } catch (error) {
    if (REJECTED_STATUS_CODES.has((error as { statusCode?: number }).statusCode ?? 0)) {
      throw new Error("Band rejected that agent ID or API key. Nothing was saved.");
    }
    throw new Error(`Band couldn't check that agent, so nothing was saved: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function use({ dataDir, projectDir }: Context, name: string): string {
  const saved = readSavedAgents(dataDir);
  if (!agentNames(saved).includes(name)) {
    throw new Error(unknownAgentMessage(name, saved));
  }
  const settings = readProjectSettings(projectDir);
  // Set even for the default, so a name committed in the project's shared settings doesn't win.
  writeProjectSettings(projectDir, { ...settings, env: { ...settings.env, [AGENT_SELECT_ENV]: name } });
  return `✓ This project now connects as ${labeled(name, saved[name]?.handle)}. Start a new Claude Code session here to switch.`;
}

function remove({ dataDir, projectDir }: Context, name: string): string {
  if (name === DEFAULT_AGENT_NAME) {
    throw new Error(`The "${DEFAULT_AGENT_NAME}" agent comes from the plugin's settings: change it in /plugin.`);
  }
  const { [name]: removed, ...rest } = readSavedAgents(dataDir);
  if (!removed) {
    throw new Error(unknownAgentMessage(name, rest));
  }
  writeSavedAgents(dataDir, rest);
  const stillSelected = readProjectSettings(projectDir).env?.[AGENT_SELECT_ENV] === name
    ? ` This project still selects it: pick another with ${USE_HINT}.`
    : "";
  return `✓ Removed "${name}".${stillSelected} Other projects that select it won't connect until they pick another.`;
}

interface ProjectSettings {
  readonly env?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

function readProjectSettings(projectDir: string): ProjectSettings {
  const path = projectSettingsPath(projectDir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ProjectSettings) : {};
}

function writeProjectSettings(projectDir: string, settings: ProjectSettings): void {
  // Claude Code watches the file and reads it whole.
  writeFileAtomically(projectSettingsPath(projectDir), `${JSON.stringify(settings, null, 2)}\n`);
}

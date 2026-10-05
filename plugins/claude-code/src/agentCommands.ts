import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { BandLink } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { AgentIdentity } from "@band-ai/sdk/rest";

import {
  ADD_HINT,
  AGENT_SELECT_ENV,
  agentNames,
  AGENTS_COMMAND,
  assertAgentName,
  atHandle,
  DEFAULT_AGENT_NAME,
  nameFromHandle,
  projectSettingsPath,
  readSavedAgents,
  unknownAgentMessage,
  USE_HINT,
  writeSavedAgents,
  type SavedAgent,
} from "./config";
import { agentHolders, ancestorPids, liveSessions, sessionLocation, type SessionStatus } from "./sessions";
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
  const sessionId = thisSessionId(sessions, currentSessionId);
  const holders = agentHolders(sessions);
  // The default's ID and handle are known only from a session that connected as it.
  const sessionAs = (name: string): SessionStatus | undefined =>
    [...sessions.values()].find((session) => session.agent === name && session.agentId !== null);
  const holderOf = (name: string) => {
    const agentId = saved[name]?.agentId ?? sessionAs(name)?.agentId;
    return agentId ? holders.get(agentId) : undefined;
  };
  const handleOf = (name: string): string | null => saved[name]?.handle ?? sessionAs(name)?.handle ?? null;

  const names = agentNames(saved);
  const rows = names.map((name) => {
    const holder = holderOf(name);
    const handle = handleOf(name);
    const use = !holder ? "free" : holder.sessionId === sessionId ? "← this session" : `in use (${where(holder.status)})`;
    return [name, handle ? atHandle(handle) : "", use];
  });
  const free = names.filter((name) => !holderOf(name));
  return [thisSession(sessionId ? sessions.get(sessionId) : undefined, handleOf, free), "", "Agents:", ...table(rows)].join("\n");
}

/**
 * The status this session's server keeps. `/clear` and `/resume` give the session a new ID but keep its server,
 * which recorded the ID it started with, so the latest status of the Claude Code process running this command stands in.
 */
function thisSessionId(sessions: ReadonlyMap<string, SessionStatus>, sessionId: string): string | undefined {
  if (sessions.has(sessionId)) {
    return sessionId;
  }
  const ancestors = ancestorPids();
  const ours = [...sessions].filter(([, session]) => ancestors.has(session.pid));
  return ours.sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0]?.[0];
}

function thisSession(mine: SessionStatus | undefined, handleOf: (name: string) => string | null, free: readonly string[]): string {
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
    ? `Free: ${free.join(", ")}. Run ${AGENTS_COMMAND} use ${free[0]}, then start a new Claude Code session here.`
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
  const saved = readSavedAgents(dataDir);
  // The default's ID is known only from a session connected as it.
  const knownAs =
    Object.keys(saved).find((savedName) => saved[savedName].agentId === agentId) ??
    [...liveSessions(dataDir).values()].find((session) => session.agentId === agentId)?.agent;
  if (knownAs) {
    throw new Error(`Agent ${agentId} is already set up as "${knownAs}".`);
  }
  const credentials: AgentCredentials = { agentId, apiKey, ...(wsUrl ? { wsUrl } : {}) };
  const identity = await fetchIdentity(credentials);
  if (identity.id !== agentId) {
    throw new Error(`That API key belongs to agent ${identity.id}, not ${agentId}. Nothing was saved.`);
  }
  const chosen = name ?? (identity.handle ? nameFromHandle(identity.handle) : undefined) ?? identity.name;
  assertAgentName(chosen);
  if (saved[chosen]) {
    throw new Error(`An agent named "${chosen}" is already saved. Pick another name: ${ADD_HINT} <name>`);
  }
  const agent: SavedAgent = { ...credentials, handle: identity.handle ?? null };
  writeSavedAgents(dataDir, { ...saved, [chosen]: agent });
  return `✓ Saved ${labeled(chosen, agent.handle)}. Use it in a project with ${AGENTS_COMMAND} use ${chosen}`;
}

async function fetchIdentity(credentials: AgentCredentials): Promise<AgentIdentity> {
  try {
    return await new BandLink(credentials).rest.getAgentMe();
  } catch (error) {
    if (REJECTED_STATUS_CODES.has((error as { statusCode?: number }).statusCode ?? 0)) {
      throw new Error("Band rejected that agent ID or API key. Nothing was saved.");
    }
    throw error;
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
  const path = projectSettingsPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

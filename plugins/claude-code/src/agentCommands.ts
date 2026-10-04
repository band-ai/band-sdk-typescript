import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { BandLink } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { AgentIdentity } from "@band-ai/sdk/rest";

import {
  AGENT_SELECT_ENV,
  AGENTS_COMMAND,
  assertAgentName,
  DEFAULT_AGENT_NAME,
  PROJECT_SETTINGS_FILE,
  readSavedAgents,
  unknownAgentMessage,
  writeSavedAgents,
  type SavedAgent,
} from "./config";
import { liveSessions, type SessionStatus } from "./sessions";

/** A session in these states holds its agent. */
const HOLDING_STATES: ReadonlySet<SessionStatus["state"]> = new Set(["connecting", "connected"]);
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

function status({ dataDir }: Context, sessionId: string): string {
  const saved = readSavedAgents(dataDir);
  const sessions = liveSessions(dataDir);
  const names = [DEFAULT_AGENT_NAME, ...Object.keys(saved)];
  const holders = new Map<string, { sessionId: string; status: SessionStatus }>();
  for (const [id, session] of sessions) {
    if (HOLDING_STATES.has(session.state)) {
      holders.set(session.agent, { sessionId: id, status: session });
    }
  }
  // The default's handle is known only once a session has connected as it.
  const handleOf = (name: string): string | null => saved[name]?.handle ?? holders.get(name)?.status.handle ?? null;
  const shown = (name: string): string => (handleOf(name) ? `@${handleOf(name)}` : "");

  const rows = names.map((name) => {
    const holder = holders.get(name);
    const use = !holder ? "free" : holder.sessionId === sessionId ? "← this session" : `in use (${where(holder.status)})`;
    return [name, shown(name), use];
  });
  const free = names.filter((name) => !holders.has(name));
  return [thisSession(sessions.get(sessionId), shown, free), "", "Agents:", ...table(rows)].join("\n");
}

function thisSession(mine: SessionStatus | undefined, shown: (name: string) => string, free: readonly string[]): string {
  const as = (name: string): string => `"${name}"${shown(name) ? ` (${shown(name)})` : ""}`;
  switch (mine?.state) {
    case undefined:
      return "This session: no Band server is running in it.";
    case "connecting":
      return `This session: connecting as ${as(mine.agent)}.`;
    case "connected":
      return `This session: connected as ${as(mine.agent)}.`;
    case "refused":
      return [`This session: refused. ${mine.error ?? ""}`, nextStep(free)].join("\n");
    case "failed":
      return `This session: not connected. ${mine.error ?? ""}`;
  }
}

function nextStep(free: readonly string[]): string {
  return free.length > 0
    ? `Free: ${free.join(", ")}. Run ${AGENTS_COMMAND} use ${free[0]}, then start a new Claude Code session here.`
    : `No agent is free: add one with ${AGENTS_COMMAND} add <agent_id> <api_key>.`;
}

function where({ projectDir }: SessionStatus): string {
  if (!projectDir) {
    return "another session";
  }
  const home = homedir();
  return `session in ${projectDir.startsWith(home) ? `~${projectDir.slice(home.length)}` : projectDir}`;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`.trimEnd());
}

async function add({ dataDir }: Context, agentId: string, apiKey: string, name: string | undefined, wsUrl: string | undefined): Promise<string> {
  const saved = readSavedAgents(dataDir);
  const savedAs = Object.keys(saved).find((savedName) => saved[savedName].agentId === agentId);
  if (savedAs) {
    throw new Error(`Agent ${agentId} is already saved as "${savedAs}".`);
  }
  const identity = await fetchIdentity({ agentId, apiKey, ...(wsUrl ? { wsUrl } : {}) });
  if (identity.id !== agentId) {
    throw new Error(`That API key belongs to agent ${identity.id}, not ${agentId}. Nothing was saved.`);
  }
  const chosen = name ?? identity.handle?.split("/").pop() ?? identity.name;
  assertAgentName(chosen);
  if (saved[chosen]) {
    throw new Error(`An agent named "${chosen}" is already saved. Pick another name: ${AGENTS_COMMAND} add <agent_id> <api_key> <name>`);
  }
  const agent: SavedAgent = { agentId, apiKey, ...(wsUrl ? { wsUrl } : {}), handle: identity.handle ?? null };
  writeSavedAgents(dataDir, { ...saved, [chosen]: agent });
  return `✓ Saved "${chosen}"${agent.handle ? ` (@${agent.handle})` : ""}. Use it in a project with ${AGENTS_COMMAND} use ${chosen}`;
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
  if (name !== DEFAULT_AGENT_NAME && !saved[name]) {
    throw new Error(unknownAgentMessage(name, Object.keys(saved)));
  }
  const settings = readProjectSettings(projectDir);
  // Set even for the default, so a name committed in the project's shared settings doesn't win.
  writeProjectSettings(projectDir, { ...settings, env: { ...settings.env, [AGENT_SELECT_ENV]: name } });
  const handle = saved[name]?.handle;
  return `✓ This project now connects as "${name}"${handle ? ` (@${handle})` : ""}. Start a new Claude Code session here to switch.`;
}

function remove({ dataDir, projectDir }: Context, name: string): string {
  if (name === DEFAULT_AGENT_NAME) {
    throw new Error(`The "${DEFAULT_AGENT_NAME}" agent comes from the plugin's settings: change it in /plugin.`);
  }
  const { [name]: removed, ...rest } = readSavedAgents(dataDir);
  if (!removed) {
    throw new Error(unknownAgentMessage(name, Object.keys(rest)));
  }
  writeSavedAgents(dataDir, rest);
  const stillSelected = readProjectSettings(projectDir).env?.[AGENT_SELECT_ENV] === name
    ? ` This project still selects it: pick another with ${AGENTS_COMMAND} use <name>.`
    : "";
  return `✓ Removed "${name}".${stillSelected} Other projects that select it won't connect until they pick another.`;
}

interface ProjectSettings {
  readonly env?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

function readProjectSettings(projectDir: string): ProjectSettings {
  const path = join(projectDir, PROJECT_SETTINGS_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ProjectSettings) : {};
}

function writeProjectSettings(projectDir: string, settings: ProjectSettings): void {
  const path = join(projectDir, PROJECT_SETTINGS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

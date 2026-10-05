import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { BandLink } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { AgentIdentity } from "@band-ai/sdk/rest";
import { ensureHandlePrefix } from "@band-ai/sdk/runtime";

import {
  ADD_HINT,
  AGENT_SELECT_ENV,
  assertAgentName,
  configuredWsUrl,
  nameFromHandle,
  projectSettingsPath,
  readSavedAgents,
  unknownAgentMessage,
  USE_HINT,
  useCommand,
  writeSavedAgents,
  type SavedAgent,
  type SavedAgents,
} from "./config";
import { writeFileAtomically } from "./files";
import { agentHolders, liveSessions, sessionLocation, thisSession, type SessionStatus } from "./sessions";

/** Claude Code starts the server again, with the project's settings as they are now, when it reconnects. */
const RECONNECT = "reconnect the band server in /mcp";
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
      return add(context, required(args[0]), required(args[1]), args[2], configuredWsUrl(values["ws-url"]));
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
  const inUse = ({ agentId }: SavedAgent): string | undefined => {
    const holder = holders.get(agentId);
    if (holder) {
      return holder === mine ? "← this session" : `in use (${where(holder)})`;
    }
    // Band refused it, so a session this machine doesn't know of holds it.
    return mine?.state === "refused" && agentId === mine.agentId ? "in use elsewhere" : undefined;
  };

  const rows = Object.entries(saved).map(([name, agent]) => [name, ensureHandlePrefix(agent.handle) ?? "", inUse(agent) ?? "free"]);
  const free = Object.keys(saved).filter((name) => !inUse(saved[name]));
  const agents = rows.length > 0 ? ["Agents:", ...table(rows)] : [`No agent saved yet: add one with ${ADD_HINT}.`];
  return [describeSession(mine, saved, free), "", ...agents].join("\n");
}

function describeSession(mine: SessionStatus | undefined, saved: SavedAgents, free: readonly string[]): string {
  switch (mine?.state) {
    case undefined:
      return "This session: no Band server is running in it.";
    case "connecting":
    case "connected":
      // A server holds an agent only once it has picked one.
      return `This session: ${mine.state} as ${labeled(mine.agent!, mine.handle ?? saved[mine.agent!]?.handle)}.`;
    case "refused":
      return [`This session: refused. ${mine.error ?? ""}`, nextStep(free)].join("\n");
    case "failed":
      return `This session: not connected. ${mine.error ?? ""}`;
  }
}

/** An agent as the user knows it: its name, and its Band handle when known. */
function labeled(name: string, handle: string | null | undefined): string {
  const at = ensureHandlePrefix(handle);
  return `"${name}"${at ? ` (${at})` : ""}`;
}

function nextStep(free: readonly string[]): string {
  return free.length > 0
    ? `Free: ${free.join(", ")}. Run ${useCommand(free[0])}, then ${RECONNECT}.`
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
  const identity = await fetchIdentity({ agentId, apiKey, ...(wsUrl ? { wsUrl } : {}) });
  if (identity.id !== agentId) {
    throw new Error(`That API key belongs to agent ${identity.id}, not ${agentId}. Nothing was saved.`);
  }
  const chosen = name ?? (identity.handle ? nameFromHandle(identity.handle) : undefined) ?? identity.name;
  assertAgentName(chosen);
  // Read only now: another add or remove may have run while Band answered.
  const saved = readSavedAgents(dataDir);
  const knownAs = Object.keys(saved).find((savedName) => saved[savedName].agentId === agentId);
  if (knownAs) {
    throw new Error(`Agent ${agentId} is already set up as "${knownAs}".`);
  }
  if (saved[chosen]) {
    throw new Error(`An agent named "${chosen}" is already saved. Pick another name: ${ADD_HINT} <name>`);
  }
  const agent: SavedAgent = { agentId, apiKey, handle: identity.handle ?? null };
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
  if (!saved[name]) {
    throw new Error(unknownAgentMessage(name, saved));
  }
  const settings = readProjectSettings(projectDir);
  writeProjectSettings(projectDir, { ...settings, env: { ...settings.env, [AGENT_SELECT_ENV]: name } });
  return `✓ This project now connects as ${labeled(name, saved[name].handle)}. To switch this session, ${RECONNECT}; new sessions here connect as it.`;
}

function remove({ dataDir, projectDir }: Context, name: string): string {
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

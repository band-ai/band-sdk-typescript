import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAgentConfigs, type AgentCredentials } from "@band-ai/sdk/config";
import { dump as dumpYaml } from "js-yaml";

import { writeFileAtomically } from "./files";

/**
 * The plugin's Band WebSocket URL setting, for every agent, as `.mcp.json` passes it to the server. A name of the
 * plugin's own, so the SDK's BAND_* and THENVOI_* credential variables never reach it.
 */
export const WS_URL_ENV = "BAND_CHANNEL_WS_URL";
/**
 * Names the saved agent a session connects as without asking. Read from the server's own environment, never
 * declared in `.mcp.json`: Claude Code passes an unset `${VAR}` there through as literal text.
 */
export const AGENT_SELECT_ENV = "BAND_AGENT";
/** The skill that manages the agents. */
export const AGENTS_COMMAND = "/band:agents";
/** How messages tell the user to save an agent. */
export const ADD_HINT = `${AGENTS_COMMAND} add <agent_id> <api_key>`;

/** What Claude Code sets for a plugin's MCP server. */
export const CLAUDE_ENV = {
  /** Survives plugin updates; deleted on uninstall unless `--keep-data`. */
  pluginData: "CLAUDE_PLUGIN_DATA",
  projectDir: "CLAUDE_PROJECT_DIR",
  /** Undocumented for MCP servers; set by Claude Code 2.1.289. */
  sessionId: "CLAUDE_CODE_SESSION_ID",
} as const;

/** The saved agents, keyed by name, in the plugin's data directory. */
const AGENTS_FILE = "agents.yaml";

/** How Claude Code passes a plugin setting left unset: as the literal `${user_config.<key>}`. */
const UNSET_SETTING = /^\$\{user_config\.\w+\}$/;
// Only owner-readable: the file holds API keys.
const AGENTS_FILE_MODE = 0o600;
const AGENT_NAME = /^[A-Za-z0-9_.-]+$/;

export type Env = Readonly<Record<string, string | undefined>>;

export interface SavedAgent {
  readonly agentId: string;
  readonly apiKey: string;
  /** The agent's Band handle, as Band reported it when the agent was added. */
  readonly handle: string | null;
}

export type SavedAgents = Readonly<Record<string, SavedAgent>>;

/** What a session connects to Band with as `agent`, on the Band the plugin is set to. */
export function agentCredentials(agent: SavedAgent, env: Env): AgentCredentials {
  const wsUrl = configuredWsUrl(env[WS_URL_ENV]);
  return { agentId: agent.agentId, apiKey: agent.apiKey, ...(wsUrl ? { wsUrl } : {}) };
}

/** The Band WebSocket URL the plugin is set to; none for app.band.ai, when the setting is empty or unset. */
export function configuredWsUrl(setting: string | undefined): string | undefined {
  return setting && !UNSET_SETTING.test(setting) ? setting : undefined;
}

export function unknownAgentMessage(name: string, saved: SavedAgents): string {
  return `No Band agent named "${name}". Saved: ${Object.keys(saved).join(", ") || "none"}.`;
}

/** The agent part of an `owner/agent` handle: what a saved agent is named unless the user names it. */
export function nameFromHandle(handle: string): string | undefined {
  return handle.split("/").pop();
}

/** Fails naming the rule when `name` can't be a saved agent's name. */
export function assertAgentName(name: string): void {
  if (!AGENT_NAME.test(name)) {
    throw new Error(`"${name}" can't name an agent: use letters, digits, ".", "_" or "-".`);
  }
}

export function pluginDataDir(env: Env): string {
  const dir = env[CLAUDE_ENV.pluginData];
  if (!dir) {
    throw new Error(`${CLAUDE_ENV.pluginData} is not set: Claude Code sets it for the plugin.`);
  }
  return dir;
}

export function agentsFilePath(dataDir: string): string {
  return join(dataDir, AGENTS_FILE);
}

/** The saved agents by name; none until the first is added. Nothing inherited, so "constructor" is just a name. */
export function readSavedAgents(dataDir: string): Record<string, SavedAgent> {
  const saved = Object.create(null) as Record<string, SavedAgent>;
  const path = agentsFilePath(dataDir);
  if (!existsSync(path)) {
    return saved;
  }
  for (const [name, { agentId, apiKey, handle }] of Object.entries(loadAgentConfigs(path))) {
    saved[name] = { agentId, apiKey, handle: typeof handle === "string" ? handle : null };
  }
  return saved;
}

export function writeSavedAgents(dataDir: string, agents: SavedAgents): void {
  const sections = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [name, { agent_id: agent.agentId, api_key: agent.apiKey, handle: agent.handle }]),
  );
  // A session starting meanwhile reads the agents whole.
  writeFileAtomically(agentsFilePath(dataDir), dumpYaml(sections), AGENTS_FILE_MODE);
}

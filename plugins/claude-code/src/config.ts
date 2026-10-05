import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAgentConfigFromEnv, loadAgentConfigs, type AgentCredentials } from "@band-ai/sdk/config";
import { dump as dumpYaml } from "js-yaml";

import { writeFileAtomically } from "./files";

/** An exact prefix: the user's own BAND_* and THENVOI_* variables never reach the plugin. */
export const ENV_PREFIX = "BAND_CHANNEL_";
/**
 * Names the saved agent a session connects as. Read from the server's own environment, never declared
 * in `.mcp.json`: Claude Code passes an unset `${VAR}` there through as literal text.
 */
export const AGENT_SELECT_ENV = "BAND_AGENT";
/** The agent configured when the plugin was enabled, from its `userConfig`. */
export const DEFAULT_AGENT_NAME = "default";
/** The skill that manages the agents. */
export const AGENTS_COMMAND = "/band:agents";
/** How messages tell the user to save an agent, and to pick one. */
export const ADD_HINT = `${AGENTS_COMMAND} add <agent_id> <api_key>`;
export const USE_HINT = useCommand("<name>");

/** The command that selects agent `name` for a project. */
export function useCommand(name: string): string {
  return `${AGENTS_COMMAND} use ${name}`;
}

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
/** Where `/band:agents use` selects an agent for a project: the user's personal Claude Code settings for it. */
const PROJECT_SETTINGS_FILE = join(".claude", "settings.local.json");

// Only owner-readable: the file holds API keys.
const AGENTS_FILE_MODE = 0o600;
const AGENT_NAME = /^[A-Za-z0-9_.-]+$/;

export type Env = Readonly<Record<string, string | undefined>>;

export interface SavedAgent extends AgentCredentials {
  /** The agent's Band handle, as Band reported it when the agent was added. */
  readonly handle: string | null;
}

/** The agent this session connects as: the one `BAND_AGENT` names, or the default. */
export function selectedAgentName(env: Env): string {
  return env[AGENT_SELECT_ENV] || DEFAULT_AGENT_NAME;
}

/** The credentials of the agent named `name`; fails naming the saved agents when there is none. */
export function agentCredentials(name: string, env: Env): AgentCredentials {
  if (name === DEFAULT_AGENT_NAME) {
    return loadAgentConfigFromEnv({ env, prefix: ENV_PREFIX });
  }
  const saved = readSavedAgents(pluginDataDir(env));
  const agent = saved[name];
  if (!agent) {
    throw new Error(`${unknownAgentMessage(name, saved)} Add it with ${ADD_HINT} ${name}`);
  }
  return { agentId: agent.agentId, apiKey: agent.apiKey, ...(agent.wsUrl ? { wsUrl: agent.wsUrl } : {}) };
}

/** Every agent a session can select: the default, then the saved ones. */
export function agentNames(saved: Readonly<Record<string, SavedAgent>>): string[] {
  return [DEFAULT_AGENT_NAME, ...Object.keys(saved)];
}

export function unknownAgentMessage(name: string, saved: Readonly<Record<string, SavedAgent>>): string {
  return `No Band agent named "${name}". Agents: ${agentNames(saved).join(", ")}.`;
}

/** A Band handle as people address it. */
export function atHandle(handle: string): string {
  return `@${handle}`;
}

/** The agent part of an `owner/agent` handle: what a saved agent is named unless the user names it. */
export function nameFromHandle(handle: string): string | undefined {
  return handle.split("/").pop();
}

/** Fails naming the rule when `name` can't be a saved agent's name. */
export function assertAgentName(name: string): void {
  if (name === DEFAULT_AGENT_NAME || !AGENT_NAME.test(name)) {
    throw new Error(`"${name}" can't name an agent: use letters, digits, ".", "_" or "-", and not "${DEFAULT_AGENT_NAME}".`);
  }
}

function pluginDataDir(env: Env): string {
  const dir = env[CLAUDE_ENV.pluginData];
  if (!dir) {
    throw new Error(`${CLAUDE_ENV.pluginData} is not set: Claude Code sets it for the plugin.`);
  }
  return dir;
}

export function agentsFilePath(dataDir: string): string {
  return join(dataDir, AGENTS_FILE);
}

export function projectSettingsPath(projectDir: string): string {
  return join(projectDir, PROJECT_SETTINGS_FILE);
}

/** The saved agents by name; none until the first is added. Nothing inherited, so "constructor" is just a name. */
export function readSavedAgents(dataDir: string): Record<string, SavedAgent> {
  const saved = Object.create(null) as Record<string, SavedAgent>;
  const path = agentsFilePath(dataDir);
  if (!existsSync(path)) {
    return saved;
  }
  for (const [name, { agentId, apiKey, wsUrl, handle }] of Object.entries(loadAgentConfigs(path))) {
    saved[name] = { agentId, apiKey, wsUrl, handle: typeof handle === "string" ? handle : null };
  }
  return saved;
}

export function writeSavedAgents(dataDir: string, agents: Readonly<Record<string, SavedAgent>>): void {
  const sections = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      { agent_id: agent.agentId, api_key: agent.apiKey, ...(agent.wsUrl ? { ws_url: agent.wsUrl } : {}), handle: agent.handle },
    ]),
  );
  // A session starting meanwhile reads the agents whole.
  writeFileAtomically(agentsFilePath(dataDir), dumpYaml(sections), AGENTS_FILE_MODE);
}

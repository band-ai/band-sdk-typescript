import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAgentConfigFromEnv, loadAgentConfigs, type AgentCredentials } from "@band-ai/sdk/config";
import { dump as dumpYaml } from "js-yaml";

/** An exact prefix: the user's own BAND_* and THENVOI_* variables never reach the plugin. */
export const ENV_PREFIX = "BAND_CHANNEL_";
/**
 * Names the saved agent a session connects as. Read from the server's own environment, never declared
 * in `.mcp.json`: Claude Code passes an unset `${VAR}` there through as literal text.
 */
export const AGENT_SELECT_ENV = "BAND_AGENT";
/** The agent configured when the plugin was enabled, from its `userConfig`. */
export const DEFAULT_AGENT_NAME = "default";
/** The saved agents, keyed by name, in the plugin's data directory. */
export const AGENTS_FILE = "agents.yaml";
/** The skill that manages the agents. */
export const AGENTS_COMMAND = "/band:agents";
/** Where `/band:agents use` selects an agent for a project: the user's personal Claude Code settings for it. */
export const PROJECT_SETTINGS_FILE = join(".claude", "settings.local.json");

/** What Claude Code sets for a plugin's MCP server. */
export const CLAUDE_ENV = {
  /** Survives plugin updates; deleted on uninstall unless `--keep-data`. */
  pluginData: "CLAUDE_PLUGIN_DATA",
  projectDir: "CLAUDE_PROJECT_DIR",
  sessionId: "CLAUDE_CODE_SESSION_ID",
} as const;

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
    throw new Error(`${unknownAgentMessage(name, Object.keys(saved))} Add it with ${AGENTS_COMMAND} add <agent_id> <api_key> ${name}`);
  }
  return { agentId: agent.agentId, apiKey: agent.apiKey, ...(agent.wsUrl ? { wsUrl: agent.wsUrl } : {}) };
}

export function unknownAgentMessage(name: string, savedNames: readonly string[]): string {
  return `No Band agent named "${name}". Agents: ${[DEFAULT_AGENT_NAME, ...savedNames].join(", ")}.`;
}

/** Fails naming the rule when `name` can't be a saved agent's name. */
export function assertAgentName(name: string): void {
  if (name === DEFAULT_AGENT_NAME || !AGENT_NAME.test(name)) {
    throw new Error(`"${name}" can't name an agent: use letters, digits, ".", "_" or "-", and not "${DEFAULT_AGENT_NAME}".`);
  }
}

export function pluginDataDir(env: Env): string {
  const dir = env[CLAUDE_ENV.pluginData];
  if (!dir) {
    throw new Error(`${CLAUDE_ENV.pluginData} is not set: Claude Code sets it for the plugin.`);
  }
  return dir;
}

/** The saved agents by name; none until the first is added. */
export function readSavedAgents(dataDir: string): Record<string, SavedAgent> {
  const path = join(dataDir, AGENTS_FILE);
  if (!existsSync(path)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(loadAgentConfigs(path)).map(([name, { agentId, apiKey, wsUrl, handle }]) => [
      name,
      { agentId, apiKey, wsUrl, handle: typeof handle === "string" ? handle : null },
    ]),
  );
}

export function writeSavedAgents(dataDir: string, agents: Readonly<Record<string, SavedAgent>>): void {
  const path = join(dataDir, AGENTS_FILE);
  const sections = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      { agent_id: agent.agentId, api_key: agent.apiKey, ...(agent.wsUrl ? { ws_url: agent.wsUrl } : {}), handle: agent.handle },
    ]),
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, dumpYaml(sections), { mode: AGENTS_FILE_MODE });
  // The mode applies only when the file is created.
  chmodSync(path, AGENTS_FILE_MODE);
}

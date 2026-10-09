import { parseArgs } from "node:util";

import { BandLink } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { AgentIdentity } from "@band-ai/sdk/rest";

import {
  ADD_HINT,
  assertAgentName,
  configuredWsUrl,
  nameFromHandle,
  readSavedAgents,
  unknownAgentMessage,
  writeSavedAgents,
  type SavedAgent,
} from "./config";
import { agentLabel } from "./names";
import { JOIN_PHRASE, liveSessions, SESSION_TEXT, thisSession } from "./sessions";

/** How Band answers credentials it doesn't accept. */
const REJECTED_STATUS_CODES = new Set([401, 403]);
const USAGE = `Usage: agents.js --data-dir <dir> <command>
  status [session_id]
  add <agent_id> <api_key> [name] [--ws-url <url>]
  remove <name>`;

/** Runs one `/band:agents` command and resolves with what to show; rejects with a message for the user. */
export async function runAgentsCommand(argv: readonly string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "data-dir": { type: "string" }, "ws-url": { type: "string" } },
    allowPositionals: true,
  });
  const dataDir = values["data-dir"];
  const [command, ...args] = positionals;
  if (!dataDir) {
    throw new Error(USAGE);
  }
  switch (command) {
    case "status":
      return status(dataDir, args[0]);
    case "add":
      return add(dataDir, required(args[0]), required(args[1]), args[2], configuredWsUrl(values["ws-url"]));
    case "remove":
      return remove(dataDir, required(args[0]));
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

/** This session's state and its one sentence; found by its Claude Code process when the ID doesn't tell. */
function status(dataDir: string, sessionId: string | undefined): string {
  const mine = thisSession(liveSessions(dataDir), sessionId);
  return mine ? `${mine.state}: ${mine.sentence}` : `off: ${SESSION_TEXT.noServer}`;
}

async function add(dataDir: string, agentId: string, apiKey: string, name: string | undefined, wsUrl: string | undefined): Promise<string> {
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
  return `✓ Saved ${agentLabel(chosen, agent.handle)}. Say ${JOIN_PHRASE} to connect a session as it.`;
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

function remove(dataDir: string, name: string): string {
  const { [name]: removed, ...rest } = readSavedAgents(dataDir);
  if (!removed) {
    throw new Error(unknownAgentMessage(name, rest));
  }
  writeSavedAgents(dataDir, rest);
  return `✓ Removed "${name}".`;
}

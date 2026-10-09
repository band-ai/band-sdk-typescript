import type { BandLink } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { errorResult, successResult, type McpToolRegistration } from "@band-ai/sdk/mcp";

import { fetchMessagesTool, replyTool, sendTool, type MessageMemory } from "./messages";
import { findAgentsTool } from "./peers";
import { findRoomsTool, inviteTool, openRoomTool, renameRoomTool } from "./rooms";
import type { WorkingIndicator } from "./working";

/** The Band tools, by name; Claude Code exposes each as `mcp__plugin_band_band__<name>`. */
export const TOOL = {
  reply: "reply",
  send: "send",
  openRoom: "open_room",
  invite: "invite",
  findAgents: "find_agents",
  findRooms: "find_rooms",
  renameRoom: "rename_room",
  fetchMessages: "fetch_messages",
} as const;

/** Loads a tool with the session rather than on demand; only the tools Claude answers with need it. */
export const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

/** Where Claude Code cuts a tool description and the server instructions. */
export const CLAUDE_CODE_TEXT_LIMIT = 2048;

/** What every tool works with: the agent's link, who it is, and the session's state. */
export interface ToolContext {
  readonly link: Pick<BandLink, "agentId" | "listAllChats" | "rest">;
  /** The agent; `handle` is its `@handle`, or its name when Band has none. */
  readonly self: { readonly id: string; readonly handle: string };
  readonly memory: MessageMemory;
  readonly working: WorkingIndicator;
  readonly logger: Logger;
}

/** The whole tool set the server lists. */
export function bandTools(context: ToolContext): McpToolRegistration[] {
  return [
    replyTool(context),
    sendTool(context),
    openRoomTool(context),
    inviteTool(context),
    findAgentsTool(context),
    findRoomsTool(context),
    renameRoomTool(context),
    fetchMessagesTool(context),
  ];
}

/** Band's status and reason as Band gave them; any other error's message. */
export function bandErrorText(error: unknown): string {
  const status = bandStatus(error);
  if (status === undefined) {
    return error instanceof Error ? error.message : String(error);
  }
  const reason = (error as { body?: { error?: { message?: unknown } } }).body?.error?.message;
  return `Band refused it (${status}): ${typeof reason === "string" ? reason : (error as Error).message}`;
}

/** The HTTP status of a Band refusal; none for any other error. */
export function bandStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** Runs a tool's work: its text is the result, and any error is the result Claude reads instead. */
export async function toolResult(name: string, { logger }: Pick<ToolContext, "logger">, work: () => Promise<string>): Promise<ReturnType<typeof successResult>> {
  try {
    return successResult(await work());
  } catch (error) {
    logger.debug(`${name} failed`, { error });
    return errorResult(bandErrorText(error));
  }
}

/** The strings in a tool's array argument; anything else in it is dropped. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A required string argument, or a steering error naming it. */
export function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

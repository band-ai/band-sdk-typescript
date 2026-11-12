import type { AdapterToolMethodName, AdapterToolsProtocol } from "../../contracts/protocols";
import type { MetadataMap } from "../../contracts/dtos";
import { BAND_TOOL_EFFECTS, isBandToolName, TOOL_METHODS, type ToolName } from "../../contracts/toolSchemas";
import type { Logger } from "../../core/logger";
import { overrideTools } from "../../core/overrideTools";
import { bestEffort, type RoomJournal } from "./TurnJournal";

type ToolMethod = (...args: unknown[]) => Promise<unknown>;

/** Whether `toolName` posts a reply, as band-sdk-core judges each Band tool's effect on its turn. */
function postsReply(toolName: string): boolean {
  return isBandToolName(toolName) && BAND_TOOL_EFFECTS[toolName] === "reply";
}

/**
 * `tools` whose replies to `messageId` are recorded before they post: every
 * reply tool, called by name or through its direct method (`sendMessage`, the
 * path an adapter's relayed closing text takes). The record only lets a later
 * run report that a reply may already be in the room; a journal that cannot
 * write it never stops the reply.
 *
 * `journal` is resolved at each reply, not once per turn: a turn that outlives
 * its room's handling (a reset or leave that stopped waiting for it) records
 * into the journal the room's next execution reads.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  journal: () => Promise<RoomJournal>,
  messageId: string,
  logger: Logger,
): T {
  const recordReply = () =>
    bestEffort(
      async () => (await journal()).replyBegun(messageId),
      logger,
      "Failed to record a reply in the turn journal; posting it anyway",
      { messageId },
    );

  const overrides: Record<string, unknown> = {};
  for (const [toolName, methodName] of Object.entries(TOOL_METHODS) as [ToolName, AdapterToolMethodName | null][]) {
    const method = methodName && postsReply(toolName) ? (tools[methodName] as ToolMethod | undefined)?.bind(tools) : undefined;
    if (!method || !methodName) continue;
    overrides[methodName] = async (...args: unknown[]) => {
      await recordReply();
      return method(...args);
    };
  }

  const executeToolCall = tools.executeToolCall.bind(tools);
  overrides.executeToolCall = async (toolName: string, args: MetadataMap) => {
    if (postsReply(toolName)) await recordReply();
    return executeToolCall(toolName, args);
  };

  return overrideTools(tools, overrides as Partial<T>);
}

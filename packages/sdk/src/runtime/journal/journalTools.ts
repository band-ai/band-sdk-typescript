import { createHash } from "node:crypto";

import {
  createToolExecutorError,
  isFailedToolOutput,
  type AdapterToolsProtocol,
} from "../../contracts/protocols";
import type { MentionInput, MetadataMap } from "../../contracts/dtos";
import { NO_REPLY_TOOL_NAME, OPERATION_ID_ARG, SEND_MESSAGE_TOOL_NAME } from "../../contracts/toolSchemas";
import { overrideTools } from "../../core/overrideTools";
import type { ReplyIdentity, ReplyTool, RoomJournal } from "./TurnJournal";

/** Replies under one operation id run one at a time per room, so a racing retry sees the first one's record. */
const operationsInFlight = new WeakMap<RoomJournal, Map<string, Promise<unknown>>>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** The reply's payload digest: what an operation id is bound to. */
export function replyDigest(tool: ReplyTool, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify([tool, canonical(payload)]), "utf8").digest("hex");
}

function withoutOperationId(args: MetadataMap): MetadataMap {
  const { [OPERATION_ID_ARG]: _operationId, ...rest } = args;
  return rest;
}

function operationConflict(tool: ReplyTool, operationId: string) {
  const message = `${OPERATION_ID_ARG} ${operationId} was already used for a different ${tool} call; use a new id for a new reply`;
  return createToolExecutorError({ errorType: "ToolArgumentsValidationError", toolName: tool, message });
}

function invalidOperationId(tool: ReplyTool) {
  const message = `Invalid arguments for ${tool}: ${OPERATION_ID_ARG}: must be a non-empty string`;
  return createToolExecutorError({ errorType: "ToolArgumentsValidationError", toolName: tool, message });
}

/**
 * `tools` whose replies to `messageId` are recorded in `journal`: every
 * `band_send_message` and plain `sendMessage` (the path an adapter's
 * automatic reply takes) records its intent before posting and its outcome
 * after, and every `band_no_reply` records the decline. A reply carrying an
 * `operation_id` the room already recorded returns that reply's result
 * without posting, or is refused when its arguments differ.
 */
export function journalingTools<T extends AdapterToolsProtocol>(tools: T, journal: RoomJournal, messageId: string): T {
  const sendMessage = tools.sendMessage.bind(tools);
  const executeToolCall = tools.executeToolCall.bind(tools);

  const post = async <R>(identity: ReplyIdentity, deliver: () => Promise<R>): Promise<R> => {
    const pending = await journal.beginReply(messageId, identity);
    let result: R;
    try {
      result = await deliver();
    } catch (error) {
      await journal.replyFailed(pending);
      throw error;
    }
    if (isFailedToolOutput(result)) {
      await journal.replyFailed(pending);
    } else {
      await journal.replyPosted(pending, result);
    }
    return result;
  };

  const once = async (tool: ReplyTool, operationId: string, digest: string, land: () => Promise<unknown>): Promise<unknown> => {
    let inFlight = operationsInFlight.get(journal);
    if (!inFlight) {
      inFlight = new Map();
      operationsInFlight.set(journal, inFlight);
    }
    for (let previous = inFlight.get(operationId); previous; previous = inFlight.get(operationId)) {
      await previous.catch(() => undefined);
    }
    const recorded = journal.operation(operationId);
    if (recorded) {
      return recorded.tool === tool && recorded.digest === digest ? recorded.result : operationConflict(tool, operationId);
    }
    const landing = land();
    inFlight.set(operationId, landing);
    try {
      return await landing;
    } finally {
      if (inFlight.get(operationId) === landing) inFlight.delete(operationId);
    }
  };

  const reply = async (tool: ReplyTool, args: MetadataMap): Promise<unknown> => {
    const operationId = args[OPERATION_ID_ARG];
    if (operationId !== undefined && (typeof operationId !== "string" || operationId.trim() === "")) {
      return invalidOperationId(tool);
    }
    const payload = withoutOperationId(args);
    const digest =
      tool === SEND_MESSAGE_TOOL_NAME
        ? replyDigest(tool, { content: payload.content, mentions: payload.mentions })
        : replyDigest(tool, payload);
    const identity: ReplyIdentity = operationId === undefined ? { tool, digest } : { tool, digest, operationId };
    const land = async (): Promise<unknown> => {
      if (tool === SEND_MESSAGE_TOOL_NAME) {
        return post(identity, () => executeToolCall(tool, payload));
      }
      const result = await executeToolCall(tool, payload);
      if (!isFailedToolOutput(result)) await journal.replyDeclined(messageId, identity, result);
      return result;
    };
    return operationId === undefined ? land() : once(tool, operationId, digest, land);
  };

  return overrideTools(tools, {
    sendMessage: (content: string, mentions?: MentionInput) =>
      post(
        { tool: SEND_MESSAGE_TOOL_NAME, digest: replyDigest(SEND_MESSAGE_TOOL_NAME, { content, mentions: mentions ?? [] }) },
        () => sendMessage(content, mentions),
      ),
    executeToolCall: (toolName: string, args: MetadataMap) =>
      toolName === SEND_MESSAGE_TOOL_NAME || toolName === NO_REPLY_TOOL_NAME
        ? reply(toolName, args ?? {})
        : executeToolCall(toolName, args),
  } as Partial<T>);
}

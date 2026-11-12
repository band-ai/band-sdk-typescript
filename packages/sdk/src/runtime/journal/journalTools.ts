import { createHash } from "node:crypto";

import {
  createToolExecutorError,
  isFailedToolOutput,
  type AdapterToolsProtocol,
} from "../../contracts/protocols";
import type { MentionInput, MetadataMap, ToolSchemaRecord } from "../../contracts/dtos";
import {
  NO_REPLY_TOOL_NAME,
  OPERATION_ID_ARG,
  OPERATION_ID_PROPERTY,
  SEND_MESSAGE_TOOL_NAME,
} from "../../contracts/toolSchemas";
import { asNonEmptyString } from "../../core/coercion";
import { overrideTools } from "../../core/overrideTools";
import type { ReplyIdentity, ReplyTool, RoomJournal } from "./TurnJournal";

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

function isReplyTool(name: unknown): name is ReplyTool {
  return name === SEND_MESSAGE_TOOL_NAME || name === NO_REPLY_TOOL_NAME;
}

function withOperationIdProperty(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const { properties } = schema as { properties?: Record<string, unknown> };
  return { ...schema, properties: { ...properties, [OPERATION_ID_ARG]: OPERATION_ID_PROPERTY } };
}

/** `records` with `operation_id` added to the reply tools, in either schema format. */
function advertiseOperationId(records: ToolSchemaRecord[]): ToolSchemaRecord[] {
  return records.map((record) => {
    if (isReplyTool(record.name)) {
      return { ...record, input_schema: withOperationIdProperty(record.input_schema) };
    }
    const fn = record.function as { name?: unknown; parameters?: unknown } | undefined;
    if (fn && isReplyTool(fn.name)) {
      return { ...record, function: { ...fn, parameters: withOperationIdProperty(fn.parameters) } };
    }
    return record;
  });
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
 * without posting, or is refused when its arguments differ. The tools'
 * schemas advertise `operation_id` on the reply tools, since only here does
 * it dedupe anything.
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

  const land = async (tool: ReplyTool, payload: MetadataMap, identity: ReplyIdentity): Promise<unknown> => {
    if (tool === SEND_MESSAGE_TOOL_NAME) {
      return post(identity, () => executeToolCall(tool, payload));
    }
    const result = await executeToolCall(tool, payload);
    if (!isFailedToolOutput(result)) await journal.replyDeclined(messageId, identity, result);
    return result;
  };

  const reply = async (tool: ReplyTool, args: MetadataMap): Promise<unknown> => {
    const operationId = args[OPERATION_ID_ARG];
    const payload = withoutOperationId(args);
    if (operationId === undefined) return land(tool, payload, { tool });
    if (typeof operationId !== "string" || asNonEmptyString(operationId) === null) return invalidOperationId(tool);
    const digest = replyDigest(tool, tool === SEND_MESSAGE_TOOL_NAME ? { content: payload.content, mentions: payload.mentions } : payload);
    // Under the id's turn, so a racing retry finds the first one's record.
    return journal.once(operationId, async () => {
      const recorded = journal.operation(operationId);
      if (!recorded) return land(tool, payload, { tool, operationId, digest });
      return recorded.tool === tool && recorded.digest === digest ? recorded.result : operationConflict(tool, operationId);
    });
  };

  return overrideTools(tools, {
    getToolSchemas: (format: "openai" | "anthropic", options?: { includeMemory?: boolean }) =>
      advertiseOperationId(tools.getToolSchemas(format, options)),
    getAnthropicToolSchemas: (options?: { includeMemory?: boolean }) =>
      advertiseOperationId(tools.getAnthropicToolSchemas(options)),
    getOpenAIToolSchemas: (options?: { includeMemory?: boolean }) =>
      advertiseOperationId(tools.getOpenAIToolSchemas(options)),
    sendMessage: (content: string, mentions?: MentionInput) =>
      post({ tool: SEND_MESSAGE_TOOL_NAME }, () => sendMessage(content, mentions)),
    executeToolCall: (toolName: string, args: MetadataMap) =>
      isReplyTool(toolName)
        ? reply(toolName, args ?? {})
        : executeToolCall(toolName, args),
  } as Partial<T>);
}

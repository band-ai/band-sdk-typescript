import { createHash } from "node:crypto";

import {
  createToolExecutorError,
  isFailedToolOutput,
  isToolExecutorError,
  type AdapterToolsProtocol,
} from "../../contracts/protocols";
import type { MentionInput, MetadataMap, ToolSchemaRecord } from "../../contracts/dtos";
import {
  OPERATION_ID_ARG,
  OPERATION_ID_PROPERTY,
  SEND_MESSAGE_TOOL_NAME,
  isReplyToolName,
  type ReplyToolName,
} from "../../contracts/toolSchemas";
import { asNonEmptyString } from "../../core/coercion";
import { RoomExecutionStoppedError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { overrideTools } from "../../core/overrideTools";
import type { PendingReply, ReplyIdentity, RoomJournal } from "./TurnJournal";

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

/** The digest of a reply's arguments, `operation_id` aside: what an operation id is bound to. */
export function replyDigest(tool: ReplyToolName, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify([tool, canonical(payload)]), "utf8").digest("hex");
}

function withOperationIdProperty(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const { properties } = schema as { properties?: Record<string, unknown> };
  return { ...schema, properties: { ...properties, [OPERATION_ID_ARG]: OPERATION_ID_PROPERTY } };
}

/** `records` with `operation_id` added to the reply tools, in either schema format. */
function advertiseOperationId(records: ToolSchemaRecord[]): ToolSchemaRecord[] {
  return records.map((record) => {
    if (isReplyToolName(record.name)) {
      return { ...record, input_schema: withOperationIdProperty(record.input_schema) };
    }
    const fn = record.function as { name?: unknown; parameters?: unknown } | undefined;
    if (fn && isReplyToolName(fn.name)) {
      return { ...record, function: { ...fn, parameters: withOperationIdProperty(fn.parameters) } };
    }
    return record;
  });
}

function withoutOperationId(args: MetadataMap): MetadataMap {
  const { [OPERATION_ID_ARG]: _operationId, ...rest } = args;
  return rest;
}

function operationIdError(tool: ReplyToolName, message: string) {
  return createToolExecutorError({ errorType: "ToolArgumentsValidationError", toolName: tool, message });
}

/** Band's refusal of a post in a room it stopped: an answer, so the post did not land. */
const STOPPED_ERROR_NAME = new RoomExecutionStoppedError("").name;

/** An HTTP status with which Band answered that it did not take the request; 408 is a timeout, not an answer. */
function isRefusalStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/**
 * Whether a failed post is known not to have reached Band: it never left
 * (bad arguments, unknown tool) or Band answered with a refusal. Anything else
 * (a timeout, a dropped connection, a 5xx) may have posted.
 */
function isKnownNotPosted(failure: unknown): boolean {
  if (isToolExecutorError(failure)) {
    if (failure.errorType !== "ToolExecutionError") return true;
    return failure.details?.errorName === STOPPED_ERROR_NAME || isRefusalStatus(failure.details?.statusCode);
  }
  if (failure instanceof RoomExecutionStoppedError) return true;
  return typeof failure === "object" && failure !== null && "statusCode" in failure && isRefusalStatus(failure.statusCode);
}

/**
 * `tools` whose replies to `messageId` are recorded in `journal`: every
 * `band_send_message` and plain `sendMessage` (the path an adapter's
 * automatic reply takes) records its intent before posting and its outcome
 * after, and every `band_no_reply` records the decline. A post that fails
 * without Band refusing it stays pending: it may have posted. A reply carrying
 * an `operation_id` the room already recorded returns that reply's result
 * without posting, is refused when its arguments differ, and is refused while
 * the first one's delivery is uncertain. The tools' schemas advertise
 * `operation_id` on the reply tools, since only here does it dedupe anything.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  journal: RoomJournal,
  messageId: string,
  logger: Logger,
): T {
  const sendMessage = tools.sendMessage.bind(tools);
  const executeToolCall = tools.executeToolCall.bind(tools);

  /** Records a failed post's outcome when it is known; a journal failure here must not replace the post's own. */
  const recordFailure = async (pending: PendingReply, failure: unknown): Promise<void> => {
    if (!isKnownNotPosted(failure)) {
      logger.warn("A reply's post failed and may still have reached Band; its delivery is uncertain", {
        messageId,
        operationId: pending.operationId,
      });
      return;
    }
    await journal.replyFailed(pending).catch((error: unknown) => {
      logger.warn("Failed to record a refused reply in the turn journal", { messageId, error });
    });
  };

  const post = async <R>(identity: ReplyIdentity, deliver: () => Promise<R>): Promise<R> => {
    const pending = await journal.beginReply(messageId, identity);
    let result: R;
    try {
      result = await deliver();
    } catch (error) {
      await recordFailure(pending, error);
      throw error;
    }
    if (isFailedToolOutput(result)) {
      await recordFailure(pending, result);
    } else {
      await journal.replyPosted(pending, result);
    }
    return result;
  };

  const land = async (tool: ReplyToolName, payload: MetadataMap, identity: ReplyIdentity): Promise<unknown> => {
    if (tool === SEND_MESSAGE_TOOL_NAME) {
      return post(identity, () => executeToolCall(tool, payload));
    }
    const result = await executeToolCall(tool, payload);
    if (!isFailedToolOutput(result)) await journal.replyDeclined(messageId, identity, result);
    return result;
  };

  const reply = async (tool: ReplyToolName, args: MetadataMap): Promise<unknown> => {
    const operationId = args[OPERATION_ID_ARG];
    const payload = withoutOperationId(args);
    if (operationId === undefined) return land(tool, payload, { tool });
    if (typeof operationId !== "string" || asNonEmptyString(operationId) === null) {
      return operationIdError(tool, `Invalid arguments for ${tool}: ${OPERATION_ID_ARG}: must be a non-empty string`);
    }
    const digest = replyDigest(tool, payload);
    // Under the id's turn, so a racing retry finds the first one's record.
    return journal.once(operationId, async () => {
      const recorded = journal.operation(operationId);
      if (!recorded) return land(tool, payload, { tool, operationId, digest });
      if (recorded.tool !== tool || recorded.digest !== digest) {
        return operationIdError(
          tool,
          `${OPERATION_ID_ARG} ${operationId} was already used for a different ${tool} call; use a new id for a new reply`,
        );
      }
      if (recorded.status === "uncertain") {
        return operationIdError(
          tool,
          `The first ${tool} under ${OPERATION_ID_ARG} ${operationId} may or may not have posted; ` +
            "check the room before sending again, under a new id",
        );
      }
      return recorded.result;
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
      isReplyToolName(toolName)
        ? reply(toolName, args ?? {})
        : executeToolCall(toolName, args),
  } as Partial<T>);
}

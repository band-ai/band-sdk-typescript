import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageDelivery } from "../client/rest/messageDelivery";
import type { MentionInput } from "../contracts/dtos";
import {
  createToolExecutorError,
  isFailedToolOutput,
  isToolExecutorError,
  toolExecutionError,
  type AdapterToolsProtocol,
  type SendMessageOptions,
  type ToolExecutorError,
} from "../contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../contracts/toolSchemas";
import {
  DeliveryFailedError,
  DeliveryUnknownError,
  deliveryUnknownPublicationId,
  deliveryUnknownToolError,
  isDeliveryUnknownOutput,
} from "../core/deliveryFailedError";
import { asErrorMessage } from "../core/coercion";
import { ValidationError } from "../core/errors";
import type { Logger } from "../core/logger";
import { overrideTools } from "../core/overrideTools";
import { bandToolOverrides } from "../core/turn";
import { normalizeMentionHandle } from "./formatters";
import { JournalPublicationError } from "./journal/errors";

/** The delivery of the turn whose tool call is running, in that call's async scope. */
const deliveryScope = new AsyncLocalStorage<MessageDelivery>();

/** The running turn's delivery, so its message posts can be read back; none outside a runtime turn. */
export function currentDelivery(): MessageDelivery | undefined {
  return deliveryScope.getStore();
}

/**
 * `tools` whose message posts settle under `delivery`: every Band tool call,
 * by name (an MCP call arriving from another async context included) or by
 * direct method, and every notice runs in its scope. Repeated sends coalesce
 * as {@link coalesceSendMessage} says.
 */
export function deliveringMessages<T extends AdapterToolsProtocol>(tools: T, delivery: MessageDelivery): T {
  const inScope = <R>(call: () => Promise<R>): Promise<R> => deliveryScope.run(delivery, call);
  const overrides = bandToolOverrides(tools, (_toolName, call) => inScope(call));
  const coalesced = coalesceSendMessage(
    overrides.executeToolCall as T["executeToolCall"],
    overrides.sendMessage as T["sendMessage"],
  );
  overrides.executeToolCall = coalesced.executeToolCall;
  overrides.sendMessage = coalesced.sendMessage;
  overrides.sendNotice = (content: string, mentions?: MentionInput) => inScope(() => tools.sendNotice(content, mentions));
  return overrideTools(tools, overrides as Partial<T>);
}

/**
 * A tool call's thrown failure as the ToolExecutorError result model and MCP
 * callers read. Routine refusals keep their classification; anything
 * unclassified is reported to `logger` as unexpected.
 */
export function toolErrorResult(toolName: string, error: unknown, logger?: Logger): ToolExecutorError {
  if (isToolExecutorError(error)) return error;
  if (error instanceof DeliveryUnknownError) return deliveryUnknownToolError(toolName, error);
  if (error instanceof ValidationError) {
    return createToolExecutorError({
      errorType: "ToolArgumentsValidationError",
      toolName,
      message: error.message,
      legacyMessage: `Invalid arguments for ${toolName}: ${error.message}`,
    });
  }
  // A journal that will not admit the reply is a refusal, not an unexpected
  // break; a poisoned or closed one mutes the room's replies, so it is visible.
  if (error instanceof JournalPublicationError) {
    const context = { toolName, kind: error.kind };
    if (error.kind === "fenced") logger?.debug("the room's journal refused a tool call", context);
    else logger?.warn("the room's journal refused a tool call", context);
    return toolExecutionError(toolName, error.message, { kind: error.kind });
  }
  logger?.error("unexpected tool execution error", { toolName, error });
  return toolExecutionError(toolName, asErrorMessage(error));
}

/**
 * One coalesce map for the tool door (`executeToolCall(band_send_message)`)
 * and the send door (`sendMessage`): a same-content send joins one in flight
 * or delivery_unknown, so an uncertain post is never resent blindly; a
 * refusal clears. The tool door also keeps its successes (model/MCP dedupe);
 * the send door's clear, so repeated direct replies each post. Each door
 * adapts a joined result to its own contract: send rejects, tool resolves.
 */
function coalesceSendMessage(
  execute: AdapterToolsProtocol["executeToolCall"],
  sendMessage: AdapterToolsProtocol["sendMessage"],
): {
  executeToolCall: AdapterToolsProtocol["executeToolCall"];
  sendMessage: AdapterToolsProtocol["sendMessage"];
} {
  type Standing = {
    promise: Promise<unknown>;
    /** inflight until settle; unknown keeps the key; done is a retained tool success. */
    outcome: "inflight" | "unknown" | "done";
  };
  const sends = new Map<string, Standing>();
  const admit = <R>(
    content: unknown,
    mentions: unknown,
    call: () => Promise<R>,
    /** The tool door retains its successes and joins every standing send; the send door joins only one in flight or unknown. */
    door: "tool" | "send",
  ): Promise<R> => {
    const key = coalesceKey(content, mentions);
    const standing = sends.get(key);
    if (standing && (door === "tool" || standing.outcome !== "done")) {
      return standing.promise as Promise<R>;
    }
    const sent = call();
    const entry: Standing = { promise: sent, outcome: "inflight" };
    sends.set(key, entry);
    sent.then(
      (result) => {
        if (isDeliveryUnknownOutput(result)) {
          entry.outcome = "unknown";
          return;
        }
        if (isFailedToolOutput(result) || door === "send") {
          sends.delete(key);
          return;
        }
        entry.outcome = "done";
      },
      (error) => {
        if (error instanceof DeliveryUnknownError) {
          entry.outcome = "unknown";
          return;
        }
        sends.delete(key);
      },
    );
    return sent;
  };
  return {
    executeToolCall: (toolName, args) => {
      if (toolName !== SEND_MESSAGE_TOOL_NAME || isKeyedToolCall(args)) return execute(toolName, args);
      // A joined send-door call rejects; model/MCP callers read a result.
      return admit(args.content, args.mentions, () => execute(toolName, args), "tool").catch(
        (error: unknown) => toolErrorResult(toolName, error),
      );
    },
    sendMessage: (content, mentions, options) =>
      isKeyedSend(options) ? sendMessage(content, mentions, options) : admit(content, mentions, () => sendMessage(content, mentions), "send").then((result) => {
        // A joined tool-door call resolves its failure; a reply must never take it for a post.
        if (isDeliveryUnknownOutput(result)) {
          throw new DeliveryUnknownError(result, deliveryUnknownPublicationId(result));
        }
        if (isFailedToolOutput(result)) throw new DeliveryFailedError(result);
        return result;
      }),
  };
}

/**
 * A keyed send stands under its own operation id, not under content: it never
 * joins a send it does not own, and no unkeyed send joins it. Presence, not
 * value, decides, as the journal admits it.
 */
function isKeyedToolCall(args: Record<string, unknown>): boolean {
  return Object.hasOwn(args, "operation_id");
}

function isKeyedSend(options: SendMessageOptions | undefined): boolean {
  return options !== undefined && Object.hasOwn(options, "operationId");
}

/**
 * Same logical send → same key, whatever the mentions' order, duplicates or
 * shape. An object mention keys by its handle, else its id; a display name is
 * not unique, so it keys only a mention with neither.
 */
function coalesceKey(content: unknown, mentions: unknown): string {
  return JSON.stringify([content, coalesceMentionTokens(mentions)]);
}

function coalesceMentionTokens(mentions: unknown): string[] {
  if (!Array.isArray(mentions) || mentions.length === 0) return [];
  // Band refuses duplicate_mentions (422): duplicates are not a distinct send.
  return [...new Set(mentions.map(coalesceMentionToken))].sort();
}

function coalesceMentionToken(mention: unknown): string {
  if (typeof mention === "string") return normalizeMentionHandle(mention);
  if (mention && typeof mention === "object" && !Array.isArray(mention)) {
    const ref = mention as Record<string, unknown>;
    if (typeof ref.handle === "string" && ref.handle.length > 0) return normalizeMentionHandle(ref.handle);
    if (typeof ref.id === "string") return `id:${ref.id.toLowerCase()}`;
    for (const field of ["username", "name"] as const) {
      const value = ref[field];
      if (typeof value === "string" && value.length > 0) return normalizeMentionHandle(value);
    }
  }
  return JSON.stringify(mention);
}

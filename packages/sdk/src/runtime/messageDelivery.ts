import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageDelivery } from "../client/rest/messageDelivery";
import type { MentionInput } from "../contracts/dtos";
import {
  createToolExecutorError,
  isFailedToolOutput,
  isToolExecutorError,
  toolExecutionError,
  type AdapterToolsProtocol,
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
 * direct method, and every notice runs in its scope. A model/MCP
 * `band_send_message` that repeats while the first is in flight, or after it
 * posted (or settled delivery_unknown), returns the first one's result
 * instead of posting again. A direct `sendMessage` (GenericAdapter /
 * deliverReply) still posts each successful call; it only joins a standing
 * same-content promise while that call is in flight or already
 * delivery_unknown, so an uncertain post cannot be resent blindly.
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
  // A journal that will not admit the reply is a routine refusal, not an unexpected break.
  if (error instanceof JournalPublicationError) {
    logger?.debug("the room's journal refused a tool call", { toolName, kind: error.kind });
    return toolExecutionError(toolName, error.message, { kind: error.kind });
  }
  logger?.error("unexpected tool execution error", { toolName, error });
  return toolExecutionError(toolName, asErrorMessage(error));
}

/**
 * One coalesce map for `executeToolCall(band_send_message)` and direct
 * `sendMessage`. In-flight and delivery_unknown (resolved tool error or
 * thrown DeliveryUnknownError) keep the key so a same-content retry cannot
 * POST again; a definite refusal clears. Tool-door successes also keep the
 * key (model/MCP dedupe). Send-door successes clear it so intentional
 * repeated direct replies each post. The send door joins only in-flight or
 * delivery_unknown standings — never a retained tool-door success.
 *
 * The map stores the raw first-call promise. Each door adapts at exit so the
 * other door's contract still holds: send never resolves a failed tool result
 * as a post (it rejects, DeliveryUnknownError for an unknown delivery); tool
 * never throws (it resolves the ToolExecutorError the call would have).
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
    retainOnSuccess: boolean,
    /** Send door skips retained tool successes; tool door joins every standing. */
    joinRetainedSuccess: boolean,
  ): Promise<R> => {
    const key = coalesceKey(content, mentions);
    const standing = sends.get(key);
    if (standing && (joinRetainedSuccess || standing.outcome !== "done")) {
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
        if (isFailedToolOutput(result) || !retainOnSuccess) {
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
      if (toolName !== SEND_MESSAGE_TOOL_NAME) return execute(toolName, args);
      // A joined send-door call rejects; model/MCP callers read a result.
      return admit(args.content, args.mentions, () => execute(toolName, args), true, true).catch(
        (error: unknown) => toolErrorResult(toolName, error),
      );
    },
    sendMessage: (content, mentions) =>
      admit(content, mentions, () => sendMessage(content, mentions), false, false).then((result) => {
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
 * Same logical send → same key: empty mentions (omitted / null / []) collapse;
 * mention tokens are shape-normalized, deduped, and stable-sorted so order,
 * duplicates (`['@a','@a']` vs `['@a']`), or string vs `{handle}` cannot miss a
 * standing delivery_unknown.
 *
 * An object mention keys by what names one peer: its handle, else its id. A
 * display name (`name`, `username`) is not unique, so it keys only a mention
 * with neither — two peers sharing one must not coalesce. This layer has no
 * room roster, so `{id}` and a bare `@handle` naming the same peer stay distinct.
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

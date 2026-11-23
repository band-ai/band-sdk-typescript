import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageDelivery } from "../client/rest/messageDelivery";
import type { MentionInput } from "../contracts/dtos";
import { isFailedToolOutput, isToolExecutorError, type AdapterToolsProtocol } from "../contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../contracts/toolSchemas";
import { DeliveryUnknownError } from "../core/deliveryFailedError";
import { overrideTools } from "../core/overrideTools";
import { bandToolOverrides } from "../core/turn";

/** The delivery of the turn whose tool call is running, in that call's async scope. */
const deliveryScope = new AsyncLocalStorage<MessageDelivery>();

/** The running turn's delivery, so its message posts can be read back; none outside a runtime turn. */
export function currentDelivery(): MessageDelivery | undefined {
  return deliveryScope.getStore();
}

/**
 * `tools` whose message posts settle under `delivery`: every Band tool call,
 * by name (an MCP call arriving from another async context included) or by
 * direct method, and every notice runs in its scope. A `band_send_message`
 * call the model or an MCP client repeats while the first is in flight, or
 * after it posted, returns the first one's result instead of posting again —
 * including a direct `sendMessage` (GenericAdapter / deliverReply).
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

/** A tool result that says delivery is unknown: Band may already hold the post. */
function isDeliveryUnknownOutput(result: unknown): boolean {
  return isToolExecutorError(result) && result.details?.kind === DeliveryUnknownError.KIND;
}

/**
 * One coalesce map for `executeToolCall(band_send_message)` and direct
 * `sendMessage`: in-flight, success, and delivery_unknown (resolved tool
 * error or thrown DeliveryUnknownError) keep the key so a same-content
 * retry cannot POST again; a definite refusal still clears.
 */
function coalesceSendMessage(
  execute: AdapterToolsProtocol["executeToolCall"],
  sendMessage: AdapterToolsProtocol["sendMessage"],
): {
  executeToolCall: AdapterToolsProtocol["executeToolCall"];
  sendMessage: AdapterToolsProtocol["sendMessage"];
} {
  const sends = new Map<string, Promise<unknown>>();
  const admit = <R>(content: unknown, mentions: unknown, call: () => Promise<R>): Promise<R> => {
    const key = JSON.stringify([content, mentions ?? null]);
    const standing = sends.get(key);
    if (standing) return standing as Promise<R>;
    const sent = call();
    sends.set(key, sent);
    sent.then(
      (result) => {
        if (isFailedToolOutput(result) && !isDeliveryUnknownOutput(result)) sends.delete(key);
      },
      (error) => {
        if (!(error instanceof DeliveryUnknownError)) sends.delete(key);
      },
    );
    return sent;
  };
  return {
    executeToolCall: (toolName, args) => {
      if (toolName !== SEND_MESSAGE_TOOL_NAME) return execute(toolName, args);
      return admit(args.content, args.mentions ?? null, () => execute(toolName, args));
    },
    sendMessage: (content, mentions) => admit(content, mentions ?? null, () => sendMessage(content, mentions)),
  };
}

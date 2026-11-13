import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageDelivery } from "../client/rest/messageDelivery";
import type { MentionInput } from "../contracts/dtos";
import { isFailedToolOutput, type AdapterToolsProtocol } from "../contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../contracts/toolSchemas";
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
 * after it posted, returns the first one's result instead of posting again.
 */
export function deliveringMessages<T extends AdapterToolsProtocol>(tools: T, delivery: MessageDelivery): T {
  const inScope = <R>(call: () => Promise<R>): Promise<R> => deliveryScope.run(delivery, call);
  const overrides = bandToolOverrides(tools, (_toolName, call) => inScope(call));
  overrides.executeToolCall = sendingRepeatsOnce(overrides.executeToolCall as T["executeToolCall"]);
  overrides.sendNotice = (content: string, mentions?: MentionInput) => inScope(() => tools.sendNotice(content, mentions));
  return overrideTools(tools, overrides as Partial<T>);
}

function sendingRepeatsOnce(execute: AdapterToolsProtocol["executeToolCall"]): AdapterToolsProtocol["executeToolCall"] {
  const sends = new Map<string, Promise<unknown>>();
  return (toolName, args) => {
    if (toolName !== SEND_MESSAGE_TOOL_NAME) return execute(toolName, args);
    const key = JSON.stringify([args.content, args.mentions ?? null]);
    const standing = sends.get(key);
    if (standing) return standing;
    const sent = execute(toolName, args);
    sends.set(key, sent);
    // Only a send in flight or posted answers a repeat: after a failure, the retry posts.
    sent.then((result) => {
      if (isFailedToolOutput(result)) sends.delete(key);
    }, () => sends.delete(key));
    return sent;
  };
}

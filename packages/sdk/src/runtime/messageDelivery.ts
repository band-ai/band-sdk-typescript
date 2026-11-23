import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageDelivery } from "../client/rest/messageDelivery";
import type { MentionInput } from "../contracts/dtos";
import {
  createToolExecutorError,
  isFailedToolOutput,
  type AdapterToolsProtocol,
} from "../contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../contracts/toolSchemas";
import {
  DeliveryUnknownError,
  deliveryUnknownPublicationId,
  isDeliveryUnknownOutput,
} from "../core/deliveryFailedError";
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
 * One coalesce map for `executeToolCall(band_send_message)` and direct
 * `sendMessage`. In-flight and delivery_unknown (resolved tool error or
 * thrown DeliveryUnknownError) keep the key so a same-content retry cannot
 * POST again; a definite refusal clears. Tool-door successes also keep the
 * key (model/MCP dedupe). Send-door successes clear it so intentional
 * repeated direct replies each post.
 *
 * The map stores the raw first-call promise. Each door adapts at exit so the
 * other door's contract still holds: send never resolves a delivery_unknown
 * ToolExecutorError as success (rejects DeliveryUnknownError); tool never
 * throws a standing DeliveryUnknownError (resolves ToolExecutorError).
 */
function coalesceSendMessage(
  execute: AdapterToolsProtocol["executeToolCall"],
  sendMessage: AdapterToolsProtocol["sendMessage"],
): {
  executeToolCall: AdapterToolsProtocol["executeToolCall"];
  sendMessage: AdapterToolsProtocol["sendMessage"];
} {
  const sends = new Map<string, Promise<unknown>>();
  const admit = <R>(
    content: unknown,
    mentions: unknown,
    call: () => Promise<R>,
    retainOnSuccess: boolean,
  ): Promise<R> => {
    const key = JSON.stringify([content, mentions ?? null]);
    const standing = sends.get(key);
    if (standing) return standing as Promise<R>;
    const sent = call();
    sends.set(key, sent);
    sent.then(
      (result) => {
        if (isDeliveryUnknownOutput(result)) return;
        if (isFailedToolOutput(result) || !retainOnSuccess) sends.delete(key);
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
      return admit(args.content, args.mentions ?? null, () => execute(toolName, args), true).catch(
        (error: unknown) => {
          // Send-door delivery_unknown rejects; the tool door must resolve a
          // ToolExecutorError so model/MCP callers see structured failure data.
          if (error instanceof DeliveryUnknownError) {
            return createToolExecutorError({
              errorType: "ToolExecutionError",
              toolName: SEND_MESSAGE_TOOL_NAME,
              message: error.message,
              legacyMessage: `Error executing ${SEND_MESSAGE_TOOL_NAME}: ${error.message}`,
              details: { kind: DeliveryUnknownError.KIND, publicationId: error.publicationId },
            });
          }
          throw error;
        },
      );
    },
    sendMessage: (content, mentions) =>
      admit(content, mentions ?? null, () => sendMessage(content, mentions), false).then((result) => {
        // Tool-door delivery_unknown resolves a ToolExecutorError; the send
        // door must reject so deliverReply never treats it as a successful post.
        if (isDeliveryUnknownOutput(result)) {
          throw new DeliveryUnknownError(result, deliveryUnknownPublicationId(result));
        }
        return result;
      }),
  };
}

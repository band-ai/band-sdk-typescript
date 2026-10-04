import { missingReplyMessage, TurnLedger, type AgentFailure, type TurnEffect, type TurnVerdict } from "@band-ai/band-sdk-core";

import type { MentionInput } from "../contracts/dtos";
import { isFailedToolOutput, type AdapterToolsProtocol, type MessagingTools } from "../contracts/protocols";
import {
  BAND_TOOL_EFFECTS,
  isBandToolName,
  postedSendContent,
  SEND_MESSAGE_TOOL_NAME,
  TOOL_METHODS,
} from "../contracts/toolSchemas";
import { deliverReply } from "./deliveryFailedError";
import type { Logger } from "./logger";
import { overrideTools } from "./overrideTools";
import { agentFailure, safeSendFailure } from "./providerFailure";

/** `AgentFailure.provider` of a missing-reply report: the runtime's verdict, not any provider's. */
export const TURN_FAILURE_PROVIDER = "band-runtime";

/**
 * One turn's progress toward a reply, judged by band-sdk-core's rule: it is
 * complete once it replied, declined, acted, was settled, or reported a failure.
 */
export class Turn {
  private readonly ledger = new TurnLedger();
  private isDetached = false;

  public record(effect: TurnEffect): void {
    this.ledger.record(effect);
  }

  /** Marks the turn handled by the adapter itself, such as a busy or control reply. */
  public settle(): void {
    this.ledger.settle();
  }

  public noteReported(): void {
    this.ledger.noteReported();
  }

  /** True once the turn replied or declined, so its closing text must not be relayed. */
  public get replied(): boolean {
    return this.ledger.replySettled();
  }

  /**
   * The turn outlives `onMessage` (it was released to wait on a decision), so
   * the adapter judges it at its real end with {@link reportUnsettledTurn}.
   */
  public detach(): void {
    this.isDetached = true;
  }

  public get detached(): boolean {
    return this.isDetached;
  }

  public verdict(): TurnVerdict {
    return this.ledger.verdict();
  }
}

export type TurnTools<T = AdapterToolsProtocol> = T & { readonly turn: Turn };

type ToolMethod = (...args: unknown[]) => Promise<unknown>;

/** A call that landed: not a failed result, and for a send, not a blank one. */
function landed(toolName: string, content: unknown, result: unknown): boolean {
  const failed = isFailedToolOutput(result);
  return toolName === SEND_MESSAGE_TOOL_NAME ? postedSendContent(toolName, content, failed) !== undefined : !failed;
}

/**
 * `tools` with a fresh {@link Turn} that records every Band tool call that
 * lands, whichever way it is made: the model's `executeToolCall`, or a direct
 * method such as `sendMessage`. `executeToolCall` dispatches to the real
 * methods, not these, so each call records once.
 */
export function trackTurn<T extends AdapterToolsProtocol>(tools: T): TurnTools<T> {
  const turn = new Turn();
  const overrides: Record<string, unknown> = { turn };

  for (const [toolName, methodName] of Object.entries(TOOL_METHODS)) {
    const method = methodName && (tools[methodName] as ToolMethod | undefined)?.bind(tools);
    if (!method || !isBandToolName(toolName)) {
      continue;
    }
    overrides[methodName] = async (...args: unknown[]) => {
      const result = await method(...args);
      if (landed(toolName, args[0], result)) {
        turn.record(BAND_TOOL_EFFECTS[toolName]);
      }
      return result;
    };
  }

  overrides.executeToolCall = async (toolName: string, args: Record<string, unknown>) => {
    const result = await tools.executeToolCall(toolName, args);
    if (isBandToolName(toolName) && landed(toolName, args.content, result)) {
      turn.record(BAND_TOOL_EFFECTS[toolName]);
    }
    return result;
  };

  overrides.sendFailure = async (failure: AgentFailure) => {
    const result = await tools.sendFailure(failure);
    if (!isFailedToolOutput(result)) {
      turn.noteReported();
    }
    return result;
  };

  return overrideTools(tools as TurnTools<T>, overrides as Partial<TurnTools<T>>);
}

/** Relays the model's closing `text` as the reply, unless the turn already replied or declined. */
export async function relayReply(
  tools: TurnTools<MessagingTools>,
  text: string | null | undefined,
  mentions: MentionInput,
): Promise<boolean> {
  if (tools.turn.replied || !text?.trim()) {
    return false;
  }
  await deliverReply(tools, text, mentions);
  return true;
}

export function missingReplyFailure(): AgentFailure {
  return agentFailure(TURN_FAILURE_PROVIDER, missingReplyMessage());
}

/**
 * Judges a detached turn at its real end, reporting a missing reply. Its
 * delivery was already acked, so this only tells the room.
 */
export async function reportUnsettledTurn(tools: TurnTools<MessagingTools>, logger: Logger): Promise<boolean> {
  if (tools.turn.verdict() !== "missing_reply") {
    return false;
  }
  await safeSendFailure(tools, missingReplyFailure(), logger);
  return true;
}

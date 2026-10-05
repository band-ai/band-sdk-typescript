import {
  missingReplyMessage,
  TurnLedger,
  type AgentFailure,
  type BandToolName,
  type TurnEffect,
  type TurnVerdict,
} from "@band-ai/band-sdk-core";

import type { MentionInput } from "../contracts/dtos";
import { isBlankEventContent } from "../contracts/chatEvents";
import { isFailedToolOutput, type AdapterToolsProtocol, type MessagingTools } from "../contracts/protocols";
import { BAND_TOOL_EFFECTS, isBandToolName, SEND_MESSAGE_TOOL_NAME, TOOL_METHODS } from "../contracts/toolSchemas";
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
  private readonly sent: string[] = [];
  private isDetached = false;

  /** `judged`: whether a missing reply is reported, false for an exempt adapter or a synthetic turn. */
  public constructor(public readonly judged = true) {}

  public record(effect: TurnEffect): void {
    this.ledger.record(effect);
  }

  /** Records a Band tool call that landed, by the tool's effect. */
  public recordTool(name: BandToolName): void {
    this.record(BAND_TOOL_EFFECTS[name]);
  }

  /** Records a `band_send_message` that posted `content`. */
  public recordSend(content: string): void {
    this.sent.push(content);
    this.recordTool(SEND_MESSAGE_TOOL_NAME);
  }

  /** What this turn's sends posted to the room, in order. */
  public get posted(): readonly string[] {
    return this.sent;
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

/** Records a Band tool call on `turn` if it landed: not a failed result, and for a send, not a blank one. */
function recordLanded(turn: Turn, toolName: BandToolName, content: unknown, result: unknown): void {
  if (isFailedToolOutput(result)) {
    return;
  }
  if (toolName !== SEND_MESSAGE_TOOL_NAME) {
    turn.recordTool(toolName);
    return;
  }
  const text = String(content ?? "");
  if (!isBlankEventContent(text)) {
    turn.recordSend(text.trim());
  }
}

/**
 * Wrappers for `tools`' Band tool methods that record each call that lands on
 * `turn`, whichever way it is made: the model's `executeToolCall`, or a direct
 * method such as `sendMessage`. They call the methods `tools` has now, and
 * `executeToolCall` dispatches to the real methods, not these, so each call
 * records once.
 */
export function recordingOverrides<T extends AdapterToolsProtocol>(tools: T, turn: Turn): Partial<T> {
  const overrides: Record<string, unknown> = {};

  for (const [toolName, methodName] of Object.entries(TOOL_METHODS)) {
    const method = methodName && (tools[methodName] as ToolMethod | undefined)?.bind(tools);
    if (!method || !isBandToolName(toolName)) {
      continue;
    }
    overrides[methodName] = async (...args: unknown[]) => {
      const result = await method(...args);
      recordLanded(turn, toolName, args[0], result);
      return result;
    };
  }

  const executeToolCall = tools.executeToolCall.bind(tools);
  overrides.executeToolCall = async (toolName: string, args: Record<string, unknown>) => {
    const result = await executeToolCall(toolName, args);
    if (isBandToolName(toolName)) {
      recordLanded(turn, toolName, args.content, result);
    }
    return result;
  };

  const sendFailure = tools.sendFailure.bind(tools);
  overrides.sendFailure = async (failure: AgentFailure) => {
    const result = await sendFailure(failure);
    if (!isFailedToolOutput(result)) {
      turn.noteReported();
    }
    return result;
  };

  return overrides as Partial<T>;
}

/** `tools` with a fresh {@link Turn} that records every Band tool call that lands, via {@link recordingOverrides}. */
export function trackTurn<T extends AdapterToolsProtocol>(tools: T, judged = true): TurnTools<T> {
  const turn = new Turn(judged);
  return overrideTools(tools as TurnTools<T>, { ...recordingOverrides(tools, turn), turn } as Partial<TurnTools<T>>);
}

/** Relays the model's closing `text` as the reply, unless the turn already replied or declined. */
export async function relayReply(
  tools: TurnTools<MessagingTools>,
  text: string | null | undefined,
  mentions: MentionInput,
): Promise<boolean> {
  if (tools.turn.replied || !text || isBlankEventContent(text)) {
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
 * delivery was already acked, so this only tells the room. A turn that isn't
 * detached is left alone: `SimpleAdapter.onEvent` judges it, and a report here
 * would mark it reported first. An unjudged turn is never reported.
 */
export async function reportUnsettledTurn(
  tools: TurnTools<MessagingTools>,
  logger: Logger,
  logContext: Record<string, unknown>,
): Promise<void> {
  if (tools.turn.judged && tools.turn.detached && tools.turn.verdict() === "missing_reply") {
    await safeSendFailure(tools, missingReplyFailure(), logger, logContext);
  }
}

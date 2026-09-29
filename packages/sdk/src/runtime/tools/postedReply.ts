import type { MentionInput } from "../../contracts/dtos";
import { isFailedToolOutput, type MessagingTools, type ToolExecutor } from "../../contracts/protocols";
import { deliverReply } from "../../core/deliveryFailedError";
import { overrideTools } from "../../core/overrideTools";
import { postedSendContent } from "./schemas";

/**
 * A turn's tools, noticing when the model answers through band_send_message.
 * That post is the turn's reply; its final text only narrates it, so that
 * text is a fallback for a turn that posted nothing (`deliverFallbackReply`).
 */
/** What tracking needs of a turn's tools: running tool calls, and posting the fallback. */
export type TrackableTools = MessagingTools & ToolExecutor;

export interface PostedReplyTracker<T extends TrackableTools = TrackableTools> {
  /** The tools to run the turn's Band tool calls through. */
  readonly tools: T;
  posted(): boolean;
}

export function trackPostedReply<T extends TrackableTools>(tools: T): PostedReplyTracker<T> {
  let posted = false;
  return {
    tools: overrideTools(tools, {
      executeToolCall: async (name: string, args: Record<string, unknown>) => {
        const result = await tools.executeToolCall(name, args);
        posted ||= postedSendContent(name, args.content, isFailedToolOutput(result)) !== undefined;
        return result;
      },
    } as Partial<T>),
    posted: () => posted,
  };
}

/** Delivers the turn's final `text` unless the turn already posted its reply; returns whether it delivered. */
export async function deliverFallbackReply(
  tracker: PostedReplyTracker,
  text: string | null | undefined,
  mentions: MentionInput,
): Promise<boolean> {
  if (tracker.posted() || !text) {
    return false;
  }
  await deliverReply(tracker.tools, text, mentions);
  return true;
}

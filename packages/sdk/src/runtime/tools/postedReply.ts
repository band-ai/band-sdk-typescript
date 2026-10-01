import type { MentionInput } from "../../contracts/dtos";
import { isFailedToolOutput, type MessagingTools, type ToolExecutor } from "../../contracts/protocols";
import { deliverReply } from "../../core/deliveryFailedError";
import { overrideTools } from "../../core/overrideTools";
import { postedSendContent } from "./schemas";

/** What tracking needs of a turn's tools: running tool calls, and posting the fallback. */
export type TrackableTools = MessagingTools & ToolExecutor;

export interface PostedReplyTracker<T extends TrackableTools = TrackableTools> {
  /** The tools to run the turn's Band tool calls through. */
  readonly tools: T;
  posted(): boolean;
}

/**
 * A turn's tools, noticing when the model answers through band_send_message.
 * That post is the turn's reply; its final text only narrates it, so that
 * text is a fallback for a turn that posted nothing (`deliverFallbackReply`).
 * `onPost` sees the content of each send that landed, for an adapter that
 * keeps its own record of the turn.
 */
export function trackPostedReply<T extends TrackableTools>(tools: T, onPost?: (content: string) => void): PostedReplyTracker<T> {
  let posted = false;
  return {
    tools: overrideTools(tools, {
      executeToolCall: async (name: string, args: Record<string, unknown>) => {
        const result = await tools.executeToolCall(name, args);
        const content = postedSendContent(name, args.content, isFailedToolOutput(result));
        if (content !== undefined) {
          posted = true;
          onPost?.(content);
        }
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

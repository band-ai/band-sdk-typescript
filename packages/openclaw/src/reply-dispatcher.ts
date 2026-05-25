import type { ThenvoiLink } from "@thenvoi/sdk";

type Mention = { id: string; name?: string };

export interface ReplyDispatcher extends Record<string, unknown> {
  sendToolResult: (payload: unknown) => boolean;
  sendBlockReply: (payload: unknown) => boolean;
  sendFinalReply: (payload: unknown) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => { tool: number; block: number; final: number };
}

export function createNoopReplyDispatcher(): ReplyDispatcher {
  function sendReply(): boolean {
    return true;
  }

  return {
    sendToolResult: sendReply,
    sendBlockReply: sendReply,
    sendFinalReply: sendReply,
    waitForIdle: async (): Promise<void> => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
  };
}

function replyPayloadText(payload: unknown): string | undefined {
  return typeof payload === "string" ? payload : (payload as { text?: string })?.text;
}

function extractUserFacingFinalText(text: string): string {
  const messageToUserMatch = text.match(/<message to user>([\s\S]*?)<\/message>/i);
  return (messageToUserMatch?.[1] ?? text).trim();
}

function hasExplicitUserFacingFinalText(text: string): boolean {
  return /<message to user>[\s\S]*?<\/message>/i.test(text);
}

function selectFinalReplyText(texts: string[]): string | undefined {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index]?.trim();
    if (text && hasExplicitUserFacingFinalText(text)) return text;
  }

  return undefined;
}

async function sendFinalReplyToBand(
  rest: ThenvoiLink["rest"],
  roomId: string,
  text: string,
  mentions: Mention[],
): Promise<void> {
  await rest.createChatMessage(roomId, { content: text, mentions });
  console.log(`[thenvoi] Final reply sent (room=${roomId}, textLength=${text.length})`);
}

export function createBandReplyDispatcher(
  link: ThenvoiLink,
  accountId: string,
  roomId: string,
  resolveFinalMentions: () => Promise<Mention[]>,
): ReplyDispatcher {
  const pendingReplies: Promise<void>[] = [];
  const deliveryErrors: Error[] = [];
  const queuedCounts = { tool: 0, block: 0, final: 0 };
  const finalReplyTexts: string[] = [];
  let finalReplySent = false;

  function enqueueDelivery(kind: "final" | "tool", delivery: Promise<void>): void {
    pendingReplies.push(
      delivery.catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        deliveryErrors.push(error);
        console.error(`[thenvoi:${accountId}] ${kind} delivery failed (room=${roomId}, error=${error.name || "Error"})`);
      }),
    );
  }

  function enqueueToolResult(payload: unknown): void {
    queuedCounts.tool += 1;
    const text = replyPayloadText(payload);
    if (!text) return;
    enqueueDelivery("tool", link.rest.createChatEvent(roomId, {
      content: text,
      messageType: "tool_result",
      metadata: { source: "openclaw" },
    }).then(() => undefined));
  }

  function queueFinalReply(payload: unknown): void {
    queuedCounts.final += 1;
    if (finalReplySent) return;
    const text = replyPayloadText(payload);
    if (text) finalReplyTexts.push(text);
  }

  return {
    sendToolResult: (payload: unknown): boolean => {
      enqueueToolResult(payload);
      return true;
    },
    sendBlockReply: (): boolean => {
      queuedCounts.block += 1;
      return true;
    },
    sendFinalReply: (payload: unknown): boolean => {
      queueFinalReply(payload);
      return true;
    },
    waitForIdle: async (): Promise<void> => {
      await Promise.resolve();
      const finalReplyText = finalReplySent ? undefined : selectFinalReplyText(finalReplyTexts);
      if (finalReplyText) {
        finalReplySent = true;
        const mentions = await resolveFinalMentions();
        enqueueDelivery("final", sendFinalReplyToBand(
          link.rest,
          roomId,
          extractUserFacingFinalText(finalReplyText),
          mentions,
        ));
      } else if (!finalReplySent && finalReplyTexts.length > 0) {
        finalReplySent = true;
        console.log(`[thenvoi] Dropped non-explicit final reply (room=${roomId})`);
      }
      await Promise.allSettled(pendingReplies);
      if (deliveryErrors.length > 0) {
        console.error(`[thenvoi:${accountId}] ${deliveryErrors.length}/${pendingReplies.length} replies failed to deliver (room=${roomId})`);
      }
    },
    getQueuedCounts: () => ({ ...queuedCounts }),
  };
}

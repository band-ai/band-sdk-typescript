import { AsyncLocalStorage } from "node:async_hooks";

/** What a reply awaits just before it leaves for Band, in the async scope of the tool call posting it. */
const replyGate = new AsyncLocalStorage<() => Promise<void>>();

/**
 * Runs `call` so that a reply it posts first awaits `beforePost`, after the
 * call's arguments and mentions were accepted. A call that fails before that
 * posts nothing and runs nothing.
 */
export function gatingReplies<T>(beforePost: () => Promise<void>, call: () => Promise<T>): Promise<T> {
  return replyGate.run(beforePost, call);
}

/** Awaited by a reply just before its post; a rejection stops the post. */
export async function replyPosting(): Promise<void> {
  await replyGate.getStore()?.();
}

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The turn a tool call runs in: the inbound message its replies settle under,
 * carried in the call's async scope rather than in the tools it runs on.
 *
 * The runtime runs every turn's adapter inside {@link runTurnInboundScope}, so
 * whatever tool composition the turn was given — the host's, wrapped or not —
 * settles its replies under that turn's inbound: the tools keep the host's
 * composition exactly as the preprocessor gave them, and work the turn hands
 * off that outlives it keeps the scope it was handed in, so a late reply
 * settles under the message it answers, never under whatever the room is
 * turning to next. Outside a runtime turn no scope stands: a direct
 * construction of the room's tools settles under whatever it was told to.
 */
const turnInboundScope = new AsyncLocalStorage<string | undefined>();

/** Runs `work` as the turn answering `inboundMessageId` (or answering nothing). */
export function runTurnInboundScope<T>(inboundMessageId: string | undefined, work: () => T): T {
  return turnInboundScope.run(inboundMessageId, work);
}

/** The turn's inbound the running tool call settles under; `undefined` outside a runtime turn. */
export function currentTurnInbound(): string | undefined {
  return turnInboundScope.getStore();
}
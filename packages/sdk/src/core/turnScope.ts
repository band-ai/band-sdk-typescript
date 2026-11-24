import { AsyncLocalStorage } from "node:async_hooks";

import { NON_ACTING_TOOL_KEYS } from "../contracts/protocols";
import { wrappedCalls } from "./overrideTools";

/**
 * The turn a tool call runs in: the inbound message its replies settle under,
 * carried in the call's async scope rather than in the tools it runs on.
 *
 * {@link scopeTurnTools} binds that inbound onto the tools' methods themselves:
 * each invocation enters {@link runTurnInboundScope}, so whatever composition
 * the turn was given — the host's, wrapped or not — settles its replies under
 * that turn's inbound. Work the turn hands off that outlives it keeps the
 * scope by calling those methods, so a late reply settles under the message it
 * answers, never under whatever the room is turning to next. The adapter run
 * itself is not wrapped in the scope. Outside a runtime turn no scope stands:
 * a direct construction of the room's tools settles under whatever it was told.
 */
const turnInboundScope = new AsyncLocalStorage<string | undefined>();

/** Runs `work` as the turn answering `inboundMessageId` (or answering nothing). */
function runTurnInboundScope<T>(inboundMessageId: string | undefined, work: () => T): T {
  return turnInboundScope.run(inboundMessageId, work);
}

/** The turn's inbound the running tool call settles under; `undefined` outside a runtime turn. */
export function currentTurnInbound(): string | undefined {
  return turnInboundScope.getStore();
}

/**
 * `tools`, with every acting method run in the scope of the turn answering
 * `inboundMessageId`, however and whenever the call reaches it: a call's own
 * async context says nothing about which turn the tools stand for. The
 * non-acting members ({@link NON_ACTING_TOOL_KEYS}) are consulted, not
 * called, so they run unscoped.
 */
export function scopeTurnTools<T extends object>(tools: T, inboundMessageId: string | undefined): T {
  return wrappedCalls(tools, (key, call) =>
    NON_ACTING_TOOL_KEYS.has(key) ? call() : runTurnInboundScope(inboundMessageId, call),
  );
}

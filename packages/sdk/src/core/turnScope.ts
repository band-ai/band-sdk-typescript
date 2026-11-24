import { AsyncLocalStorage } from "node:async_hooks";

import { NON_ACTING_TOOL_KEYS } from "../contracts/protocols";

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
 * The turn's tools, with the turn's origin bound to the methods themselves:
 * whichever method a call reaches — from the adapter's context, through a
 * long-lived transport (an MCP bridge a turn opened, a server that outlives
 * its turns), from a direct or late call (a channel callback, work the turn
 * handed off), or from work that outlives the turn — it runs in the scope of
 * the turn that composed the tools it reached. A call's async context is
 * exactly where it was created, and that context is nothing to do with which
 * turn the tools stand for; the scope the methods enter on invocation is.
 *
 * The non-acting members ({@link NON_ACTING_TOOL_KEYS}) are consulted, not
 * called, so they run unscoped; the scope enters before the method is awaited, so the
 * method's whole run — post, settlement, the result it returns — settles
 * under the turn's inbound.
 */
export function scopeTurnTools<T extends object>(tools: T, inboundMessageId: string | undefined): T {
  return new Proxy(tools, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key === "symbol" || key === "then" || NON_ACTING_TOOL_KEYS.has(key)) {
        return value;
      }
      return function (
        this: unknown,
        ...args: unknown[]
      ): Promise<unknown> {
        return runTurnInboundScope(inboundMessageId, () =>
          Reflect.apply(value as (...a: unknown[]) => Promise<unknown>, this === undefined ? target : this, args),
        );
      };
    },
  });
}

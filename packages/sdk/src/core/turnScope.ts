import { AsyncLocalStorage } from "node:async_hooks";

import { NON_ACTING_TOOL_KEYS } from "../contracts/protocols";
import { wrappedCalls } from "./overrideTools";

/** The turn a tool call runs in: the inbound its replies settle under, and that turn's own stop. */
export interface TurnScope {
  readonly inbound: string | undefined;
  readonly stopped: AbortSignal;
}

/**
 * Carried in the call's async scope rather than in the tools it runs on, so
 * work the turn hands off keeps it and a late reply sees its own turn's
 * inbound and stop, never whatever the room is turning to next.
 */
const turnScope = new AsyncLocalStorage<TurnScope>();

/** The turn the running tool call belongs to; `undefined` outside a runtime turn. */
export function currentTurn(): TurnScope | undefined {
  return turnScope.getStore();
}

/**
 * `tools`, with every acting method entering `scope` at call entry, however
 * and whenever the call reaches it. The non-acting members
 * ({@link NON_ACTING_TOOL_KEYS}) are consulted, not called, so they run unscoped.
 */
export function scopeTurnTools<T extends object>(tools: T, scope: TurnScope): T {
  return wrappedCalls(tools, (key, call) =>
    NON_ACTING_TOOL_KEYS.has(key) ? call() : turnScope.run(scope, call),
  );
}

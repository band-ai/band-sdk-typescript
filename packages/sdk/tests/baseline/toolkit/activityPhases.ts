import { onTestFinished } from "vitest";
import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import { createDeferred } from "../../../src/core/deferred";

/** Hold real adapter entry/return so each semantic state can reach the observer. */
export function activityPhases() {
  const entered = createDeferred();
  const enter = createDeferred();
  const returned = createDeferred();
  const finish = createDeferred();
  const stopped = new AbortController();
  const release = () => { stopped.abort(); enter.resolve(); finish.resolve(); };
  onTestFinished(release);
  return {
    entered: entered.promise, returned: returned.promise,
    enter: () => enter.resolve(), finish: () => finish.resolve(),
    release,
    wrap(adapter: FrameworkAdapter, prepare?: () => Promise<void>): FrameworkAdapter {
      return {
        onStarted: async (name, description) => { await prepare?.(); await adapter.onStarted(name, description); },
        onEvent: async (input) => {
          entered.resolve();
          await enter.promise;
          if (stopped.signal.aborted) return;
          try { await adapter.onEvent(input); }
          finally { returned.resolve(); await finish.promise; }
        },
        onCleanup: async (roomId) => { release(); await adapter.onCleanup(roomId); },
        onRuntimeStop: async () => { release(); await adapter.onRuntimeStop?.(); },
      };
    },
  };
}

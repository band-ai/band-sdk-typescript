import { createDeferred } from "../../core/deferred";
import type { Logger } from "../../core/logger";
import { finishTurn, type TurnTools } from "../../core/turn";
import { retainWorkingCycleUntil } from "../../runtime/workingState";

const DETACHED: unique symbol = Symbol("detached");

/** Hands back a decision wait; the provider calls `complete` only at its normal completion seam. */
export async function runUntilReleased(
  tools: TurnTools,
  operation: (complete: () => Promise<void>) => Promise<void>,
  released: Promise<unknown>,
  logger: Logger,
  logContext: Record<string, unknown>,
  onDetachedError: (error: unknown) => void,
): Promise<void> {
  const completed = createDeferred<void>();
  const handedOff = createDeferred<void>();
  const complete = async (): Promise<void> => {
    completed.resolve();
    await handedOff.promise;
    await finishTurn(tools, "detached", logger, logContext);
  };
  const run = retainWorkingCycleUntil(tools, Promise.resolve().then(() => operation(complete)));
  try {
    // Decide ownership before judgment, without leaving the provider's reporting/cleanup scope.
    if ((await Promise.race([run, completed.promise, released.then(() => DETACHED)])) === DETACHED) {
      tools.turn.detach(run);
      void run.catch(onDetachedError);
    } else {
      handedOff.resolve();
      await run;
    }
  } finally {
    handedOff.resolve();
  }
}

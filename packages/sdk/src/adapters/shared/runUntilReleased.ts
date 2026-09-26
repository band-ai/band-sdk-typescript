const DETACHED: unique symbol = Symbol("detached");

/**
 * Awaits `run` until `released` resolves, then leaves it running detached.
 * A room hands an adapter one message at a time, so a turn that waits on the
 * room's next message must return first; a later failure goes to `onDetachedError`.
 */
export async function runUntilReleased(
  run: Promise<void>,
  released: Promise<unknown>,
  onDetachedError: (error: unknown) => void,
): Promise<void> {
  // A run that fails before release throws to the caller, so only one that outlives this call is handed off.
  if ((await Promise.race([run, released.then(() => DETACHED)])) === DETACHED) {
    void run.catch(onDetachedError);
  }
}

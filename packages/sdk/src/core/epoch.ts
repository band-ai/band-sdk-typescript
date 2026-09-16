/**
 * A monotonically increasing generation counter for guarding async work that
 * can outlive the operation that started it: capture `current` (or `bump()`'s
 * return value) before starting, then check `isStale(captured)` after any
 * `await` to detect whether the owner ended/restarted the session while the
 * work was in flight.
 */
export class Epoch {
  private value = 0;

  public get current(): number {
    return this.value;
  }

  /** Advances to the next generation and returns it. */
  public bump(): number {
    this.value += 1;
    return this.value;
  }

  public isStale(captured: number): boolean {
    return captured !== this.value;
  }
}

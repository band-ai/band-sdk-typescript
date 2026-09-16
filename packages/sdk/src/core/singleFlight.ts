/**
 * Memoizes one in-flight async operation: a concurrent call while one is
 * already running gets the same promise instead of starting a second one,
 * and the slot self-clears once it settles so the next call starts fresh.
 */
export class SingleFlight<T = void> {
  private pending: Promise<T> | null = null;

  /** The currently in-flight operation's promise, if any is running. */
  public get current(): Promise<T> | null {
    return this.pending;
  }

  public run(start: () => Promise<T>): Promise<T> {
    if (!this.pending) {
      const promise = start();
      this.pending = promise;
      const clear = (): void => {
        if (this.pending === promise) {
          this.pending = null;
        }
      };
      void promise.then(clear, clear);
    }
    return this.pending;
  }
}

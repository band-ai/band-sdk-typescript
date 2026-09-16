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

/** The same single-slot memoization as {@link SingleFlight}, keyed so unrelated keys run independently. */
export class KeyedSingleFlight<T = void> {
  private readonly flights = new Map<string, SingleFlight<T>>();

  /** The currently in-flight operation's promise for `key`, if any is running. */
  public current(key: string): Promise<T> | null {
    return this.flights.get(key)?.current ?? null;
  }

  public run(key: string, start: () => Promise<T>): Promise<T> {
    let flight = this.flights.get(key);
    if (!flight) {
      flight = new SingleFlight<T>();
      this.flights.set(key, flight);
    }

    const promise = flight.run(start);
    const forget = (): void => {
      if (this.flights.get(key) === flight && !flight.current) {
        this.flights.delete(key);
      }
    };
    void promise.then(forget, forget);
    return promise;
  }

  /** Drops every key without waiting for its in-flight operation to settle. */
  public clear(): void {
    this.flights.clear();
  }
}

/**
 * Runs each enqueued body only after the previous one has settled, whether it
 * resolved or rejected, so callers get a strict one-at-a-time queue instead
 * of unbounded concurrency. Each call gets its own body's real outcome; a
 * failure never blocks the next enqueued body from running.
 */
export class Serializer {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

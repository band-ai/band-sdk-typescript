import { Deadline } from "../../core/deadline";

/**
 * One turn's time budget, enforced from inside the turn. Racing the whole turn
 * from outside would free the room's turn lock while its tool loop kept
 * running, overlapping the next turn on the same conversation.
 */
export class TurnBudget implements Disposable {
  private readonly deadline: Deadline;
  private readonly controller = new AbortController();

  public constructor(timeoutMs: number) {
    this.deadline = new Deadline(timeoutMs);
    // Registered first, so the signal reads as aborted by the time any later
    // handler on `expired` runs, even for a model that rejects on abort.
    void this.deadline.expired.then(() => this.controller.abort(new Error("Tool-calling turn timed out")));
  }

  public get hasExpired(): boolean {
    return this.controller.signal.aborted;
  }

  public throwIfExpired(): void {
    this.controller.signal.throwIfAborted();
  }

  /** Runs `call` with the turn's abort signal, and stops waiting on it at the deadline even if it ignores the signal. */
  public async run<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.throwIfExpired();
    return Promise.race([
      call(this.controller.signal),
      this.deadline.expired.then((): never => {
        throw this.controller.signal.reason;
      }),
    ]);
  }

  public [Symbol.dispose](): void {
    this.deadline[Symbol.dispose]();
  }
}

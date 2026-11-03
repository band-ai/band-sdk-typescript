/** The longest delay `setTimeout` honours; it fires anything past this, `Infinity` included, after ~1ms. */
export const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

/** Core's policies speak seconds; timers speak milliseconds. */
export const MS_PER_SECOND = 1000;

/**
 * A one-shot timer owned by a `using` scope: leaving the scope cancels it, so
 * a deadline never outlives what it guards. A non-finite duration never
 * expires, since `setTimeout` would coerce it to 1ms.
 */
export class Deadline implements Disposable {
  public readonly expired: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(ms: number) {
    this.expired = new Promise((resolve) => {
      if (Number.isFinite(ms)) {
        this.timer = setTimeout(resolve, ms);
      }
    });
  }

  public [Symbol.dispose](): void {
    clearTimeout(this.timer);
  }
}

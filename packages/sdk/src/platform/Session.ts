import { Epoch } from "../core/epoch";

/**
 * A `BandLink` connection's lifetime: whether one is active, the epoch that
 * guards host-side async work and transport effects from outliving it, and
 * the teardown for whatever reconnect observer this session registered on
 * the transport. `isActive` and the epoch always change together — every
 * path that clears the reconnect observer also deactivates the session.
 */
export class Session {
  private readonly epoch = new Epoch();
  private active = false;
  private unregisterReconnectObserver: (() => void) | null = null;

  public get isActive(): boolean {
    return this.active;
  }

  public isStale(epoch: number): boolean {
    return this.epoch.isStale(epoch);
  }

  /** Starts a new session and returns its epoch. */
  public begin(): number {
    const epoch = this.epoch.bump();
    this.active = true;
    return epoch;
  }

  /** Marks the session inactive and advances the epoch, so any work still in flight for it is now stale. */
  public deactivate(): void {
    this.active = false;
    this.epoch.bump();
  }

  public setReconnectObserverTeardown(unregister: (() => void) | null): void {
    this.unregisterReconnectObserver = unregister;
  }

  public clearReconnectObserver(): void {
    this.unregisterReconnectObserver?.();
    this.unregisterReconnectObserver = null;
  }
}

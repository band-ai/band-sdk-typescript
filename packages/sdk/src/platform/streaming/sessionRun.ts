import { Session, SessionPolicy, type SessionOutcome } from "@band-ai/band-sdk-core";
import { createDeferred, type Deferred } from "../../core/deferred";
import { MAX_SETTIMEOUT_DELAY_MS, MS_PER_SECOND } from "../../core/deadline";
import {
  WebSocketDisconnectError,
  genericCloseReason,
  rapidDisconnectReason,
  type AgentControlSupersedeDisconnectReason,
  type CloseEventLike,
  type WebSocketDisconnectReason,
  type WebSocketUpgradeDisconnectReason,
} from "./disconnectReason";

/** What core `Session` decided about one observed event. */
export type SessionVerdict =
  | { kind: "up" }
  | { kind: "retry"; delayMs: number; reason: WebSocketDisconnectReason }
  | { kind: "terminal"; reason: WebSocketDisconnectReason }
  /** An event for an epoch Session already retired; nothing to act on. */
  | { kind: "stale" }
  /** The run already ended; nothing to act on. */
  | { kind: "ended" };

export interface SessionRunOptions {
  policy: SessionPolicy;
  /** Monotonic seconds. */
  now?: () => number;
  /** A fraction in [0, 1]. */
  jitter?: () => number;
}

/**
 * One connect run, from the owner's open to its local stop or core `Session`'s
 * terminal verdict. What the run learns lives and dies with it, and `signal`
 * aborts with the error it ended with, so no wait on the run outlives it.
 * Core's death is final, so each run gets a new `Session`.
 */
export class SessionRun {
  private readonly session: Session;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly ending = new AbortController();
  private epoch: bigint | null = null;
  private delayMs: number | null = null;
  private connected = false;
  private up: Deferred<void> = createDeferred();
  /** Why the owner closed the live socket itself, reported with that close. */
  private ownCloseReason: WebSocketDisconnectReason | null = null;
  /** The failure being retried, or the reason the run ended. */
  private reason: WebSocketDisconnectReason | null = null;

  public constructor(options: SessionRunOptions) {
    this.session = new Session(options.policy);
    this.now = options.now ?? (() => performance.now() / MS_PER_SECOND);
    this.jitter = options.jitter ?? Math.random;
  }

  /** Aborts once, with `WebSocketDisconnectError` for a terminal verdict or the owner's stop error. */
  public get signal(): AbortSignal {
    return this.ending.signal;
  }

  public get isLive(): boolean {
    return !this.ending.signal.aborted;
  }

  public get isConnected(): boolean {
    return this.isLive && this.connected;
  }

  public get lastReason(): WebSocketDisconnectReason | null {
    return this.reason;
  }

  /** The delay Session chose after the current attempt failed; null until a failure is reported. */
  public get pendingDelayMs(): number | null {
    return this.delayMs;
  }

  /** Resolves when the run next reports a ready connection. */
  public whenConnected(): Promise<void> {
    return this.up.promise;
  }

  /** Asks Session whether the next connect attempt may start. */
  public beginAttempt(): boolean {
    // A close phoenix dropped never consumed its reason; it belongs to no later connection.
    this.ownCloseReason = null;
    if (!this.isLive) {
      return false;
    }
    // Undefined once dead; Session always reports a death before refusing an attempt.
    const epoch = this.session.beginAttempt(this.now());
    if (epoch === undefined) {
      return false;
    }
    this.epoch = epoch;
    this.delayMs = null;
    return true;
  }

  public onConnected(): SessionVerdict {
    return this.judge((session, epoch) => session.onConnected(epoch, this.now()), genericCloseReason());
  }

  /** The connection is ready for the owner's use. */
  public markConnected(): void {
    if (!this.isLive) {
      return;
    }
    this.connected = true;
    this.up.resolve();
  }

  public onSocketClose(event?: CloseEventLike): SessionVerdict {
    const reason = this.ownCloseReason ?? genericCloseReason(event);
    this.ownCloseReason = null;
    this.markDisconnected();
    return this.judge(
      (session, epoch) => session.onSocketClose(epoch, this.now(), event?.code, this.jitter()),
      reason,
      event,
    );
  }

  public onUpgradeRejected(reason: WebSocketUpgradeDisconnectReason): SessionVerdict {
    return this.judge(
      (session, epoch) =>
        session.onUpgradeRejected(epoch, this.now(), reason.status, reason.retryAfter ?? undefined, this.jitter()),
      reason,
    );
  }

  public onSupersede(reason: AgentControlSupersedeDisconnectReason): SessionVerdict {
    return this.judge(
      (session) => session.onSupersede(this.now(), reason.retryable, reason.retryAfter ?? undefined, this.jitter()),
      reason,
    );
  }

  /** The owner is closing the live connection for `reason`: unusable now, and its close reports `reason`. */
  public closeOwnConnection(reason: WebSocketDisconnectReason): void {
    this.ownCloseReason = reason;
    this.markDisconnected();
  }

  /** Ends the run locally with `error`; nothing later in it is reported. */
  public stop(error: Error): void {
    if (!this.isLive) {
      return;
    }
    this.session.end();
    this.finish(error);
  }

  private judge(
    call: (session: Session, epoch: bigint) => SessionOutcome,
    reason: WebSocketDisconnectReason,
    event?: CloseEventLike,
  ): SessionVerdict {
    if (!this.isLive || this.epoch === null) {
      return { kind: "ended" };
    }
    const outcome = call(this.session, this.epoch);
    if (outcome.staleReason !== undefined) {
      return { kind: "stale" };
    }
    if (outcome.state === "dead") {
      // A tripped breaker reports the trip, not the event that tripped it.
      const final = outcome.deadReason === "rapid_disconnect" ? rapidDisconnectReason(event) : { ...reason, retryable: false };
      this.reason = final;
      this.finish(new WebSocketDisconnectError(final));
      return { kind: "terminal", reason: final };
    }
    if (outcome.state === "up") {
      return { kind: "up" };
    }
    this.reason = reason;
    this.delayMs = Math.min((outcome.retryAfterS ?? 0) * MS_PER_SECOND, MAX_SETTIMEOUT_DELAY_MS);
    return { kind: "retry", delayMs: this.delayMs, reason };
  }

  private markDisconnected(): void {
    if (this.connected) {
      this.connected = false;
      this.up = createDeferred();
    }
  }

  private finish(error: Error): void {
    this.markDisconnected();
    this.ending.abort(error);
  }
}

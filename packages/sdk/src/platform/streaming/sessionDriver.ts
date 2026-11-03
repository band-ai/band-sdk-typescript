import { Session, SessionPolicy, type SessionOutcome } from "@band-ai/band-sdk-core";

/** The longest delay a Node timer holds; a larger one fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** What core `Session` decided about one observed event. */
export type SessionVerdict =
  | { kind: "up" }
  | { kind: "retry"; delayMs: number }
  | { kind: "terminal"; rapidDisconnect: boolean }
  /** An event for an epoch Session already retired; nothing to act on. */
  | { kind: "stale" }
  /** The owner ended this run locally; nothing to report. */
  | { kind: "ended" };

export type AttemptDecision = "proceed" | "ended" | "dead";

export interface SessionDriverOptions {
  policy: SessionPolicy;
  /** Monotonic seconds. */
  now?: () => number;
  /** A fraction in [0, 1]. */
  jitter?: () => number;
}

/**
 * Feeds one transport's socket lifecycle to band-sdk-core's `Session`, the only
 * reconnect policy. A run lasts from the owner's open to its local end or a
 * terminal verdict; core's `end()` and death are final, so each run gets a new
 * `Session`.
 */
export class SessionDriver {
  private readonly policy: SessionPolicy;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private session: Session | null = null;
  private epoch: bigint | null = null;
  private endedLocally = false;
  /** The delay Session chose after the current epoch's failure, if one was observed. */
  private pendingDelayMs: number | null = null;

  public constructor(options: SessionDriverOptions) {
    this.policy = options.policy;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.jitter = options.jitter ?? Math.random;
  }

  /** Whether a run is in progress: not ended locally and not dead. */
  public get isLive(): boolean {
    return this.session !== null && !this.endedLocally && this.session.state !== "dead";
  }

  /** Starts a new run unless one is live; returns whether it did. */
  public begin(): boolean {
    if (this.isLive) {
      return false;
    }
    this.session = new Session(this.policy);
    this.epoch = null;
    this.endedLocally = false;
    this.pendingDelayMs = null;
    return true;
  }

  public end(): void {
    this.endedLocally = true;
    this.session?.end();
  }

  /** Asks Session whether the next connect attempt may start. */
  public beginAttempt(): AttemptDecision {
    if (!this.session || this.endedLocally) {
      return "ended";
    }
    const epoch = this.session.beginAttempt(this.now());
    if (epoch === undefined) {
      return "dead";
    }
    this.epoch = epoch;
    this.pendingDelayMs = null;
    return "proceed";
  }

  public onConnected(): SessionVerdict {
    return this.judge((session, epoch) => session.onConnected(epoch, this.now()));
  }

  public onSocketClose(closeCode: number | undefined): SessionVerdict {
    return this.judge((session, epoch) => session.onSocketClose(epoch, this.now(), closeCode, this.jitter()));
  }

  public onUpgradeRejected(status: number, retryAfterS: number | null): SessionVerdict {
    return this.judge((session, epoch) =>
      session.onUpgradeRejected(epoch, this.now(), status, retryAfterS ?? undefined, this.jitter()),
    );
  }

  public onSupersede(retryable: boolean, retryAfterS: number | null): SessionVerdict {
    return this.judge((session) => session.onSupersede(this.now(), retryable, retryAfterS ?? undefined, this.jitter()));
  }

  /**
   * The delay before phoenix's next attempt. A forced close (phoenix's own
   * heartbeat timeout) can ask before its close event arrives; that close is
   * reported now, with no code.
   */
  public nextDelay(): SessionVerdict {
    if (this.pendingDelayMs !== null) {
      return { kind: "retry", delayMs: this.pendingDelayMs };
    }
    return this.onSocketClose(undefined);
  }

  private judge(call: (session: Session, epoch: bigint) => SessionOutcome): SessionVerdict {
    if (!this.session || this.endedLocally || this.epoch === null) {
      return { kind: "ended" };
    }
    const outcome = call(this.session, this.epoch);
    if (outcome.staleReason !== undefined) {
      return { kind: "stale" };
    }
    if (outcome.state === "dead") {
      return { kind: "terminal", rapidDisconnect: outcome.deadReason === "rapid_disconnect" };
    }
    if (outcome.state === "up") {
      return { kind: "up" };
    }
    this.pendingDelayMs = Math.min((outcome.retryAfterS ?? 0) * 1000, MAX_TIMER_DELAY_MS);
    return { kind: "retry", delayMs: this.pendingDelayMs };
  }
}

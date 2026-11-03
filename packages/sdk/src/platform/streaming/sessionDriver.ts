import { Session, SessionPolicy, type SessionOutcome } from "@band-ai/band-sdk-core";
import { MAX_SETTIMEOUT_DELAY_MS, MS_PER_SECOND } from "../../core/deadline";

/** What core `Session` decided about one observed event. */
export type SessionVerdict =
  | { kind: "up" }
  | { kind: "retry"; delayMs: number }
  | { kind: "terminal"; rapidDisconnect: boolean }
  /** An event for an epoch Session already retired; nothing to act on. */
  | { kind: "stale" }
  /** The owner ended this run locally; nothing to report. */
  | { kind: "ended" };

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
  /** How this run ended for the owner: not yet, reported (a terminal end it acted on), or locally. */
  private runEnd: "none" | "reported" | "local" = "none";
  private delayMs: number | null = null;

  public constructor(options: SessionDriverOptions) {
    this.policy = options.policy;
    this.now = options.now ?? (() => performance.now() / MS_PER_SECOND);
    this.jitter = options.jitter ?? Math.random;
  }

  /** Whether a run is in progress: not ended locally and not dead. */
  public get isLive(): boolean {
    return this.session !== null && this.runEnd !== "local" && this.session.state !== "dead";
  }

  /** Whether the owner already acted on this run's end, terminal or local. */
  public get isSettled(): boolean {
    return this.runEnd !== "none";
  }

  /** Claims the run's end for the owner to act on; false when it was already claimed. */
  public settle(): boolean {
    if (this.isSettled) {
      return false;
    }
    this.runEnd = "reported";
    return true;
  }

  /** Starts a new run unless one is live; returns whether it did. */
  public begin(): boolean {
    if (this.isLive) {
      return false;
    }
    this.session = new Session(this.policy);
    this.epoch = null;
    this.runEnd = "none";
    this.delayMs = null;
    return true;
  }

  /** Ends the run locally; nothing later in it is reported. */
  public end(): void {
    this.runEnd = "local";
    this.session?.end();
  }

  /** Asks Session whether the next connect attempt may start. */
  public beginAttempt(): boolean {
    if (!this.session || this.runEnd === "local") {
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

  /** The delay Session chose after the current attempt failed; null until a failure is reported. */
  public get pendingDelayMs(): number | null {
    return this.delayMs;
  }

  private judge(call: (session: Session, epoch: bigint) => SessionOutcome): SessionVerdict {
    if (!this.session || this.runEnd === "local" || this.epoch === null) {
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
    this.delayMs = Math.min((outcome.retryAfterS ?? 0) * MS_PER_SECOND, MAX_SETTIMEOUT_DELAY_MS);
    return { kind: "retry", delayMs: this.delayMs };
  }
}

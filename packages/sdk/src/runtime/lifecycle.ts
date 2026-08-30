import { RuntimeStateError } from "../core/errors";
import type { Logger } from "../core/logger";

/**
 * Lifecycle of a startable/stoppable runtime owner.
 *
 * Shared by {@link Agent}, {@link PlatformRuntime} and {@link AgentRuntime}: the
 * three components that expose an explicit `start()`/`stop()` pair.
 *
 * This describes whether the component is *alive*, not what it is currently
 * doing for a single turn — see `ExecutionState` in `ExecutionContext.ts` for
 * that other axis.
 *
 * Legal transitions:
 *
 * ```text
 * not_started ─▶ starting ─▶ running ─▶ stopping ─▶ stopped ─┐
 *                    │           │          │                │
 *                    └───────────┴──────────┴──▶ failed ─────┤
 *                                                            │
 *                    starting ◀──────────────────────────────┘
 * ```
 *
 * `stopped` and `failed` are re-startable: a subsequent `start()` moves back to
 * `starting`, which is what makes a previously failed teardown recoverable.
 */
export type RuntimeLifecycleState =
  | { readonly status: "not_started" }
  | { readonly status: "starting" }
  | { readonly status: "running" }
  | { readonly status: "stopping" }
  | { readonly status: "stopped" }
  | { readonly status: "failed"; readonly error: Error };

/** Discriminant values of {@link RuntimeLifecycleState}. */
export type RuntimeLifecycleStatus = RuntimeLifecycleState["status"];

/**
 * Lifecycle of a single room's {@link Execution}.
 *
 * Narrower than {@link RuntimeLifecycleState} on purpose: an `Execution` starts
 * processing in its constructor, so it can never occupy a `not_started` or
 * `starting` state, and it is never restarted. Its state names deliberately do
 * not overlap with `ExecutionState` (`"starting" | "idle" | "processing"`) so a
 * bare status string is always attributable to one axis or the other.
 */
export type ExecutionLifecycleState =
  | { readonly status: "running" }
  | { readonly status: "stopping" }
  /** `graceful` is `false` when `stop(timeoutMs)` timed out and detached the process loop. */
  | { readonly status: "stopped"; readonly graceful: boolean }
  | { readonly status: "failed"; readonly error: Error };

/** Discriminant values of {@link ExecutionLifecycleState}. */
export type ExecutionLifecycleStatus = ExecutionLifecycleState["status"];

/**
 * Legal successors for {@link RuntimeLifecycleState}, keyed by the current status.
 *
 * A `Record` over the full `RuntimeLifecycleStatus` union, not a switch: adding
 * a status without adding a row here is a missing-property error under
 * `tsc --noEmit`, the same exhaustiveness guarantee a `never`-typed switch
 * default would give, without a runtime branch to fall through to.
 */
const RUNTIME_LIFECYCLE_TRANSITIONS: Readonly<Record<RuntimeLifecycleStatus, readonly RuntimeLifecycleStatus[]>> = {
  not_started: ["starting"],
  starting: ["running", "stopping", "stopped", "failed"],
  running: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: ["starting"],
  failed: ["starting", "stopping", "failed"],
};

export function isLegalRuntimeTransition(
  from: RuntimeLifecycleStatus,
  to: RuntimeLifecycleStatus,
): boolean {
  return RUNTIME_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * Legal successors for {@link ExecutionLifecycleState}, keyed by the current status.
 *
 * Same exhaustiveness guarantee as {@link RUNTIME_LIFECYCLE_TRANSITIONS}.
 */
const EXECUTION_LIFECYCLE_TRANSITIONS: Readonly<Record<ExecutionLifecycleStatus, readonly ExecutionLifecycleStatus[]>> = {
  running: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: [],
  failed: [],
};

export function isLegalExecutionTransition(
  from: ExecutionLifecycleStatus,
  to: ExecutionLifecycleStatus,
): boolean {
  return EXECUTION_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Normalises an unknown thrown value into an `Error` for storage on a state. */
export function toLifecycleError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Fan-out for callers waiting on a terminal (`stopped` / `failed`) state.
 *
 * Lets `waitUntilStopped()` resolve for an explicit reason instead of piggy-backing
 * on whichever `AbortSignal` or task promise happens to be lying around.
 */
export class TerminalSignal {
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private outcome: { readonly error: Error | null } | null = null;

  /**
   * Resolves once {@link settle} has been called with `null`, rejects once it has
   * been called with an error — including for callers that arrive afterwards.
   */
  public async wait(): Promise<void> {
    if (this.outcome) {
      if (this.outcome.error) {
        throw this.outcome.error;
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }

  /**
   * Forget the recorded outcome so a restarted owner can settle again.
   *
   * Callers already parked in {@link wait} stay parked — a wait started before a
   * restart still resolves only when the owner actually stops or fails.
   */
  public rearm(): void {
    this.outcome = null;
  }

  /** First settle wins; later ones are ignored, so a terminal state stays terminal. */
  public settle(error: Error | null): void {
    if (this.outcome) {
      return;
    }

    this.outcome = { error };
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const waiter of pending) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }
}

/**
 * Coalesces concurrent calls into one in-flight operation.
 *
 * Shared by the `start()`/`stop()` pair on {@link Agent}, {@link PlatformRuntime},
 * {@link AgentRuntime} and {@link Execution} — the one piece of their lifecycle
 * plumbing that is identical across all four.
 */
export class SingleFlight<T> {
  private operation: Promise<T> | null = null;

  /** The in-flight (or last latched) operation, if any. */
  public get pending(): Promise<T> | null {
    return this.operation;
  }

  /** Forget the latched operation so the next {@link run}/{@link runOrRetry} starts fresh. */
  public reset(): void {
    this.operation = null;
  }

  /**
   * Runs `factory()` once; concurrent and later callers get the same promise.
   * The result — success or failure — stays latched until {@link reset}.
   */
  public run(factory: () => Promise<T>): Promise<T> {
    if (this.operation) {
      return this.operation;
    }

    const operation = factory();
    this.operation = operation;
    return operation;
  }

  /**
   * Like {@link run}, but unlatches on rejection so the next call retries
   * instead of replaying the same failure. Only unlatches its own operation —
   * one already replaced by a {@link reset} or a subsequent call is left alone.
   */
  public async runOrRetry(factory: () => Promise<T>): Promise<T> {
    if (this.operation) {
      return this.operation;
    }

    const operation = factory();
    this.operation = operation;
    try {
      return await operation;
    } catch (error) {
      if (this.operation === operation) {
        this.operation = null;
      }
      throw error;
    }
  }
}

export interface LifecycleTrackerOptions<S extends { readonly status: string }> {
  /** Class name used in error messages and debug log lines, e.g. `"AgentRuntime"`. */
  readonly owner: string;
  /**
   * Identifying fields merged into every debug log line (e.g. `{ roomId }` or
   * `{ agentId }`), so concurrent rooms/agents stay attributable.
   */
  readonly logContext?: Record<string, string>;
  readonly logger?: Logger;
  readonly isLegalTransition: (from: S["status"], to: S["status"]) => boolean;
  /** Invoked after every accepted transition, with the new (frozen) state. */
  readonly onTransition?: (state: S) => void;
}

/**
 * Holds one discriminated-union lifecycle state and is the only place it changes.
 *
 * Every transition is validated against the owner's transition table, so an
 * illegal combination (the class of bug that parallel booleans made reachable)
 * throws instead of silently stranding the instance.
 */
export class LifecycleTracker<S extends { readonly status: string }> {
  private readonly options: LifecycleTrackerOptions<S>;
  private current: S;

  public constructor(initial: S, options: LifecycleTrackerOptions<S>) {
    this.options = options;
    Object.freeze(initial);
    this.current = initial;
  }

  /** The current state. Frozen, so callers cannot mutate the instance's lifecycle. */
  public get state(): S {
    return this.current;
  }

  public transition(next: S, trigger: string): void {
    const from = this.current.status;
    if (!this.options.isLegalTransition(from, next.status)) {
      throw new RuntimeStateError(
        `${this.options.owner} cannot transition from "${from}" to "${next.status}" (trigger: ${trigger})`,
      );
    }

    Object.freeze(next);
    this.current = next;
    this.options.logger?.debug(`${this.options.owner} lifecycle transition`, {
      ...this.options.logContext,
      from,
      to: next.status,
      trigger,
    });
    this.options.onTransition?.(next);
  }
}

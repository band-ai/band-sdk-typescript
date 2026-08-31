import type { FrameworkAdapter } from "../contracts/protocols";
import type { AgentCredentials } from "../config";
import { RuntimeStateError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import { PlatformRuntime, type PlatformRuntimeOptions } from "../runtime/PlatformRuntime";
import type { RuntimeLifecycleState } from "../runtime/lifecycle";
import { LifecycleTracker, SingleFlight, isLegalRuntimeTransition, toLifecycleError } from "../runtime/lifecycle";
import { runWithGracefulShutdown } from "../runtime/shutdown";
import type { PlatformMessage } from "../runtime/types";

export interface AgentCreateOptions extends Omit<PlatformRuntimeOptions, "agentId" | "apiKey" | "wsUrl" | "restUrl"> {
  adapter: FrameworkAdapter;
  config?: AgentCredentials;
  agentId?: string;
  apiKey?: string;
  wsUrl?: string;
  restUrl?: string;
  shutdownTimeoutMs?: number | null;
}

/**
 * Top-level handle for a Band agent.
 *
 * Use {@link Agent.create} to build an instance from config + adapter,
 * then call {@link Agent.run} to connect to the platform and handle messages.
 */
export class Agent {
  private readonly platformRuntime: PlatformRuntime;
  private readonly adapter: FrameworkAdapter;
  private readonly lifecycle: LifecycleTracker<RuntimeLifecycleState>;
  private readonly logger: Logger;
  private readonly startGate = new SingleFlight<void>();
  private readonly stopGate = new SingleFlight<boolean>();
  private shutdownTimeoutMs: number | null = 30_000;

  public constructor(runtime: PlatformRuntime, adapter: FrameworkAdapter, logger?: Logger) {
    this.platformRuntime = runtime;
    this.adapter = adapter;
    this.logger = logger ?? new NoopLogger();
    this.lifecycle = new LifecycleTracker<RuntimeLifecycleState>({ status: "not_started" }, {
      owner: "Agent",
      logContext: { agentId: runtime.agentId },
      logger: this.logger,
      isLegalTransition: isLegalRuntimeTransition,
    });
  }

  /** Build an Agent from credentials and a framework adapter. */
  public static create(options: AgentCreateOptions): Agent {
    const {
      adapter,
      config,
      agentId,
      apiKey,
      wsUrl,
      restUrl,
      shutdownTimeoutMs,
      ...runtimeOptions
    } = options;
    const runtime = new PlatformRuntime({
      ...runtimeOptions,
      agentId: agentId ?? config?.agentId ?? "",
      apiKey: apiKey ?? config?.apiKey ?? "",
      ...(wsUrl !== undefined || config?.wsUrl !== undefined
        ? { wsUrl: wsUrl ?? config?.wsUrl }
        : {}),
      ...(restUrl !== undefined || config?.restUrl !== undefined
        ? { restUrl: restUrl ?? config?.restUrl }
        : {}),
    });
    const agent = new Agent(runtime, adapter, runtimeOptions.logger);
    agent.shutdownTimeoutMs = shutdownTimeoutMs === undefined ? 30_000 : shutdownTimeoutMs;
    return agent;
  }

  /**
   * Whether the agent is currently started.
   *
   * `false` while a `start()` call is still in flight — it only turns `true`
   * once that call has resolved — and `false` again once the agent is stopped.
   *
   * @deprecated Read {@link Agent.state} instead, which also distinguishes
   * `"starting"`, `"stopping"` and `"failed"` from a plain `"not_started"`.
   */
  public get isRunning(): boolean {
    return this.lifecycle.state.status === "running";
  }

  /** Current lifecycle state of this agent. */
  public get state(): RuntimeLifecycleState {
    return this.lifecycle.state;
  }

  /**
   * The underlying `PlatformRuntime`, for reading its `link`/`getContext()`/etc.
   *
   * Do not call `runtime.start()`/`runtime.stop()` directly: `Agent` keeps its
   * own lifecycle tracker, so driving `PlatformRuntime`'s independently leaves
   * `agent.state` reporting stale information. Use {@link Agent.start}/
   * {@link Agent.stop} instead.
   */
  public get runtime(): PlatformRuntime {
    return this.platformRuntime;
  }

  /**
   * Start the agent.
   *
   * Repeated or concurrent calls join the in-flight start. Calling `start()`
   * while a `stop()` is still in flight rejects with a {@link RuntimeStateError}.
   */
  public async start(): Promise<void> {
    if (this.lifecycle.state.status === "stopping") {
      throw new RuntimeStateError("Agent cannot start while a stop is in progress");
    }

    if (this.startGate.pending) {
      return await this.startGate.pending;
    }

    this.stopGate.reset();
    this.lifecycle.transition({ status: "starting" }, "start");
    await this.startGate.runOrRetry(() => this.runStart());
  }

  private async runStart(): Promise<void> {
    try {
      await this.platformRuntime.start(this.adapter);
    } catch (error) {
      // PlatformRuntime.start() already ran its own cleanup before rejecting.
      if (this.lifecycle.state.status === "starting") {
        this.lifecycle.transition({ status: "failed", error: toLifecycleError(error) }, "start-failed");
      }
      throw error;
    }

    if (this.lifecycle.state.status === "starting") {
      this.lifecycle.transition({ status: "running" }, "started");
    }
  }

  /**
   * Stop the agent.
   *
   * A concurrent second call joins the in-flight teardown and mirrors its
   * outcome — including rejecting with the *same* `Error` instance. A rejected
   * `stop()` is not treated as a completed one: the next `stop()` reports the
   * same failure, and a `start()` re-arms teardown.
   */
  public async stop(timeoutMs?: number | null): Promise<boolean> {
    return await this.stopGate.run(() => this.runStop(timeoutMs));
  }

  private async runStop(timeoutMs?: number | null): Promise<boolean> {
    // Only a start that is still in flight has to be awaited; waiting on an
    // already-settled one would leave a window where start() is still allowed.
    const pendingStart = this.lifecycle.state.status === "starting" ? this.startGate.pending : null;
    if (pendingStart) {
      try {
        await pendingStart;
      } catch (error) {
        // A failed start has already been cleaned up by PlatformRuntime. The
        // start's own caller sees the rejection, but a fire-and-forget start()
        // has no such caller, so leave a trace here.
        this.logger.debug("Agent stop found the in-flight start had already failed", { error });
      }
    }

    const initial = this.lifecycle.state;
    // A start that failed already tore down whatever PlatformRuntime had built,
    // so there is nothing left to stop — but the caller must not be told the
    // agent shut down gracefully while `state` still reads "failed".
    if (initial.status === "failed") {
      this.logger.debug("Agent stop is resurfacing the recorded start failure", { error: initial.error });

      throw initial.error;
    }

    if (initial.status !== "starting" && initial.status !== "running") {
      return true;
    }

    this.startGate.reset();
    this.lifecycle.transition({ status: "stopping" }, "stop");

    try {
      const graceful = await this.platformRuntime.stop(timeoutMs ?? undefined);
      this.lifecycle.transition({ status: "stopped" }, "stopped");
      return graceful;
    } catch (error) {
      this.lifecycle.transition({ status: "failed", error: toLifecycleError(error) }, "stop-failed");
      throw error;
    }
  }

  public async runForever(): Promise<void> {
    await this.platformRuntime.runForever();
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    await this.platformRuntime.bootstrapRoomMessage(roomId, message);
  }

  public async resetRoomSession(roomId: string, timeoutMs?: number): Promise<boolean> {
    return await this.platformRuntime.resetRoomSession(roomId, timeoutMs);
  }

  /** Start the agent, listen for messages, and block until shutdown. Registers SIGINT/SIGTERM handlers by default. */
  public async run(options?: {
    shutdownTimeoutMs?: number | null;
    signals?: boolean;
  }): Promise<void> {
    if (options?.shutdownTimeoutMs !== undefined) {
      this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    }

    const useSignals = options?.signals ?? true;

    if (useSignals) {
      await runWithGracefulShutdown(this, {
        timeoutMs: this.shutdownTimeoutMs,
      });
    } else {
      await this.start();
      try {
        await this.platformRuntime.runForever();
      } finally {
        await this.stop(this.shutdownTimeoutMs);
      }
    }
  }

  public async withLifecycle<T>(handler: (agent: Agent) => Promise<T>): Promise<T> {
    await this.start();
    try {
      return await handler(this);
    } finally {
      await this.stop(this.shutdownTimeoutMs);
    }
  }
}

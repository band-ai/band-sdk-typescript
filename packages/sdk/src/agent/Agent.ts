import type { FrameworkAdapter } from "../contracts/protocols";
import type { AgentCredentials } from "../config";
import { PlatformRuntime, type PlatformRuntimeOptions } from "../runtime/PlatformRuntime";
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
  private started = false;
  private startPromise: Promise<void> | null = null;
  private shutdownTimeoutMs: number | null = 30_000;

  public constructor(runtime: PlatformRuntime, adapter: FrameworkAdapter) {
    this.platformRuntime = runtime;
    this.adapter = adapter;
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
    const agent = new Agent(runtime, adapter);
    agent.shutdownTimeoutMs = shutdownTimeoutMs === undefined ? 30_000 : shutdownTimeoutMs;
    return agent;
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public get runtime(): PlatformRuntime {
    return this.platformRuntime;
  }

  public async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.platformRuntime.start(this.adapter).then(() => {
      this.started = true;
    }).catch((error: unknown) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  public async stop(timeoutMs?: number | null): Promise<boolean> {
    if (!this.started && !this.startPromise) {
      return true;
    }

    if (!this.started && this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return true;
      }
    }

    try {
      return await this.platformRuntime.stop(timeoutMs ?? undefined);
    } finally {
      this.started = false;
      this.startPromise = null;
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

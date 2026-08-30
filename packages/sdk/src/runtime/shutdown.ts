import { NoopLogger, type Logger } from "../core/logger";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

interface StoppableAgent {
  stop(timeoutMs?: number | null): Promise<boolean>;
  run(options?: { shutdownTimeoutMs?: number | null; signals?: boolean }): Promise<void>;
}

interface GracefulShutdownOptions {
  timeoutMs?: number | null;
  onSignal?: (signal: NodeJS.Signals) => void;
  /** Destination for shutdown diagnostics. Defaults to a no-op logger. */
  logger?: Logger;
}

export class GracefulShutdown {
  private readonly agent: StoppableAgent;
  private readonly timeoutMs: number | null;
  private readonly onSignal?: (signal: NodeJS.Signals) => void;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();
  private readonly logger: Logger;
  private shuttingDown = false;

  public constructor(agent: StoppableAgent, options?: GracefulShutdownOptions) {
    this.agent = agent;
    this.timeoutMs = options?.timeoutMs === undefined
      ? DEFAULT_SHUTDOWN_TIMEOUT_MS
      : options.timeoutMs;
    this.onSignal = options?.onSignal;
    this.logger = options?.logger ?? new NoopLogger();
  }

  public registerSignals(): void {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = () => {
        this.onSignal?.(signal);
        void this.shutdown(signal);
      };
      process.on(signal, handler);
      this.handlers.set(signal, handler);
    }
  }

  public unregisterSignals(): void {
    for (const [signal, handler] of this.handlers.entries()) {
      process.off(signal, handler);
    }
    this.handlers.clear();
  }

  public async withSignals<T>(fn: () => Promise<T>): Promise<T> {
    this.registerSignals();
    try {
      return await fn();
    } finally {
      this.unregisterSignals();
    }
  }

  private async shutdown(_signal: NodeJS.Signals): Promise<void> {
    if (this.shuttingDown) {
      // Second signal received during shutdown — force exit.
      process.exit(1);
    }

    this.shuttingDown = true;
    try {
      await this.agent.stop(this.timeoutMs);
    } catch (error) {
      // Best-effort graceful shutdown — force exit if stop() itself fails. Report the
      // reason first: without it the process dies on signal with no explanation at all.
      this.logger.error("Graceful shutdown failed; forcing exit", { error });
      process.exit(1);
    }
  }
}

export async function runWithGracefulShutdown(
  agent: StoppableAgent,
  options?: GracefulShutdownOptions,
): Promise<void> {
  const shutdown = new GracefulShutdown(agent, options);
  await shutdown.withSignals(async () => {
    await agent.run({
      shutdownTimeoutMs: options?.timeoutMs === undefined ? DEFAULT_SHUTDOWN_TIMEOUT_MS : options.timeoutMs,
      signals: false,
    });
  });
}

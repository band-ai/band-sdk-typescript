import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { RestRequestOptions } from "../client/rest/requestOptions";
import { overrideTools } from "../core/overrideTools";
import { resolveLogger, type Logger } from "../core/logger";
import type { ResolvedSessionConfig } from "./types";

export type ReportFn = (working: boolean, options: RestRequestOptions) => Promise<unknown>;
const WORKING_CYCLE = Symbol("workingCycle");
interface CycleTools extends AdapterToolsProtocol {
  [WORKING_CYCLE]?: WorkingLease;
}

export interface WorkingLease {
  ready: Promise<void>;
  end(): Promise<void>;
  retain(): () => Promise<void>;
}

export function bindWorkingCycle(tools: AdapterToolsProtocol, lease: WorkingLease): AdapterToolsProtocol {
  return overrideTools<CycleTools>(tools, { [WORKING_CYCLE]: lease });
}

/** Preserve the provider outcome while retaining its originating handler's lease. */
export async function retainWorkingCycleUntil<T>(tools: AdapterToolsProtocol, work: Promise<T>): Promise<T> {
  const release = (tools as CycleTools)[WORKING_CYCLE]?.retain();
  try {
    return await work;
  } finally {
    await release?.();
  }
}

export class WorkingStateReporter {
  private tail = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly leases = new Set<object>();
  private period?: object;
  private startedAt = 0;
  private closePromise?: Promise<void>;
  private failureStreak = false;
  private readonly logger: Logger;

  public constructor(
    private readonly report: ReportFn,
    private readonly config: ResolvedSessionConfig,
    private readonly roomId: string,
    logger?: Logger,
  ) {
    this.logger = resolveLogger(logger);
  }

  public open(): WorkingLease {
    const token = {};
    let references = 1;
    let ended: Promise<void> | undefined;
    let ready = Promise.resolve();
    if (!this.closePromise) {
      this.leases.add(token);
      if (!this.period) {
        const period = this.period = {};
        this.startedAt = performance.now();
        ready = this.enqueue(() => this.refresh(period));
      } else {
        ready = this.tail;
      }
    }
    const release = async (): Promise<void> => {
      if (--references > 0 || !this.leases.delete(token)) return;
      if (this.leases.size > 0) return;
      this.retire();
      await this.enqueue(() => this.send(false));
    };
    return {
      ready,
      end: () => ended ??= release(),
      retain: () => {
        if (!this.leases.has(token)) return async () => undefined;
        references++;
        let released: Promise<void> | undefined;
        return () => released ??= release();
      },
    };
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const hadWork = this.period !== undefined;
    this.retire();
    this.leases.clear();
    return this.closePromise = hadWork ? this.enqueue(() => this.send(false)) : this.tail;
  }

  private retire(): void {
    this.period = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private canRefresh(period: object): boolean {
    return this.period === period && (this.config.maxWorkingStateSeconds === undefined ||
      performance.now() - this.startedAt < this.config.maxWorkingStateSeconds * 1000);
  }

  private async refresh(period: object): Promise<void> {
    if (!this.canRefresh(period)) return;
    await this.send(true);
    this.schedule(period);
  }

  private schedule(period: object): void {
    if (!this.canRefresh(period)) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.refresh(period));
    }, this.config.workingKeepAliveSeconds * 1000);
    this.timer.unref?.();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(operation, operation);
    return this.tail;
  }

  private async send(working: boolean): Promise<void> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.config.workingRequestTimeoutSeconds * 1000);
    deadline.unref?.();
    try {
      await this.report(working, {
        maxRetries: 0,
        timeoutInSeconds: this.config.workingRequestTimeoutSeconds,
        abortSignal: controller.signal,
      });
      if (this.failureStreak) this.logger.info("Working-state reporting recovered", { roomId: this.roomId });
      this.failureStreak = false;
    } catch (error) {
      if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404) {
        this.logger.debug("Working-state execution state unavailable", { roomId: this.roomId });
      } else {
        this.logger[this.failureStreak ? "debug" : "warn"]("Working-state reporting failed", { roomId: this.roomId, error });
        this.failureStreak = true;
      }
    } finally {
      clearTimeout(deadline);
    }
  }
}

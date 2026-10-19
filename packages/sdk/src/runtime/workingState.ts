import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { ReportActivityOptions } from "../client/rest/requestOptions";
import { AsyncLocalStorage } from "node:async_hooks";
import { activitySchema, MEMORY, PERMISSION, REASONING, sameActivity, toolCall, type Activity } from "../contracts/activity";
import type { MetadataMap } from "../contracts/dtos";
import { overrideTools } from "../core/overrideTools";
import { hasStatusCode } from "../core/errors";
import { resolveLogger, type Logger } from "../core/logger";
import type { ResolvedSessionConfig } from "./types";

export type ReportFn = (working: boolean, options: ReportActivityOptions) => Promise<unknown>;
const HTTP_NOT_FOUND = 404;
const WORKING_CYCLE = Symbol("workingCycle");
export const SCOPED_TOOL_EXECUTOR = Symbol("scopedToolExecutor");
const suppressed = new AsyncLocalStorage<boolean>();
interface CycleTools extends AdapterToolsProtocol {
  [WORKING_CYCLE]?: WorkingLease;
  [SCOPED_TOOL_EXECUTOR]?: (tools: AdapterToolsProtocol, name: string, args: MetadataMap) => Promise<unknown>;
}

/**
 * `observe` and `permission` apply a scope's activity in the reporter's queue order and never wait for
 * delivery, so the provider or tool they describe is not held behind the activity endpoint.
 * `flush`, `end` and the reporter's `close` are where delivery is awaited.
 */
export interface WorkingLease {
  ready: Promise<void>;
  end(): Promise<void>;
  retain(): () => Promise<void>;
  observe(activity: unknown): void;
  permission(waiting: boolean): void;
  flush(): Promise<void>;
}

export function bindWorkingCycle(tools: AdapterToolsProtocol, lease: WorkingLease): AdapterToolsProtocol {
  const execute = (tools as CycleTools)[SCOPED_TOOL_EXECUTOR];
  const bound: CycleTools = overrideTools<CycleTools>(tools, {
    [WORKING_CYCLE]: lease,
    ...(execute ? { executeToolCall: (name: string, args: MetadataMap) => execute(bound, name, args) } : {}),
  });
  return bound;
}

export function suppressToolActivity<T>(work: () => Promise<T>): Promise<T> {
  return suppressed.run(true, work);
}

/** Adapters hold different tool interfaces, so any object may carry a scope; only bound tools do. */
function scopeLease(tools: object): WorkingLease | undefined {
  return suppressed.getStore() ? undefined : (tools as CycleTools)[WORKING_CYCLE];
}

export function reportToolActivity(tools: object, name: string): void {
  scopeLease(tools)?.observe(toolCall(name));
}

export function endToolActivity(tools: object): void {
  scopeLease(tools)?.observe(REASONING);
}

export function reportMemoryActivity(tools: object, active: boolean): void {
  scopeLease(tools)?.observe(active ? MEMORY : REASONING);
}

export function setPermissionActivity(tools: object, waiting: boolean): void {
  scopeLease(tools)?.permission(waiting);
}

/** Brackets `work` with the tool's activity; without a scope there is nothing to report. */
export async function withToolActivity<T>(tools: object | undefined, name: string, work: () => Promise<T>): Promise<T> {
  if (!tools) return await work();
  reportToolActivity(tools, name);
  try {
    return await work();
  } finally {
    endToolActivity(tools);
  }
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
  private readonly leases = new Map<object, { activity: Activity; order: number; permission: boolean }>();
  private sequence = 0;
  private current: Activity = REASONING;
  private invalidObservationLogged = false;
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
      this.leases.set(token, { activity: REASONING, order: 0, permission: false });
      if (!this.period) {
        this.current = REASONING;
        const period = this.period = {};
        this.startedAt = performance.now();
        ready = this.enqueue(() => this.refresh(period));
      } else {
        ready = this.tail;
      }
    }
    const release = async (): Promise<void> => {
      if (--references > 0 || !this.leases.delete(token)) return;
      if (this.leases.size > 0) {
        await this.enqueue(() => this.publishSelection());
        return;
      }
      this.retire();
      await this.enqueue(() => this.send(false));
    };
    return {
      ready,
      observe: (value) => {
        if (!this.active(token)) return;
        const parsed = activitySchema.safeParse(value);
        if (!parsed.success) {
          if (!this.invalidObservationLogged) this.logger.debug("Invalid activity observation ignored", { roomId: this.roomId });
          this.invalidObservationLogged = true;
          return;
        }
        const activity = Object.freeze(parsed.data);
        void this.enqueue(async () => {
          if (!this.active(token)) return;
          const contribution = this.leases.get(token)!;
          if (sameActivity(contribution.activity, activity)) return;
          contribution.activity = activity;
          contribution.order = ++this.sequence;
          await this.publishSelection();
        });
      },
      permission: (waiting) => {
        void this.enqueue(async () => {
          if (!this.active(token)) return;
          const contribution = this.leases.get(token)!;
          if (contribution.permission === waiting) return;
          contribution.permission = waiting;
          await this.publishSelection();
        });
      },
      flush: () => this.tail,
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

  private active(token: object): boolean {
    return this.leases.has(token) && this.period !== undefined && this.canRefresh(this.period);
  }

  private async publishSelection(refresh = false): Promise<void> {
    if (!this.period || !this.canRefresh(this.period)) return;
    let selected = REASONING;
    let order = -1;
    for (const contribution of this.leases.values()) {
      if (contribution.permission) { selected = PERMISSION; break; }
      if (contribution.activity.kind !== "reasoning" && contribution.order > order) {
        selected = contribution.activity;
        order = contribution.order;
      }
    }
    if (!refresh && sameActivity(this.current, selected)) return;
    this.current = Object.freeze(selected);
    await this.send(true);
  }

  private canRefresh(period: object): boolean {
    return this.period === period && (this.config.maxWorkingStateSeconds === undefined ||
      performance.now() - this.startedAt < this.config.maxWorkingStateSeconds * 1000);
  }

  private async refresh(period: object): Promise<void> {
    if (!this.canRefresh(period)) return;
    await this.publishSelection(true);
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
        ...(working ? { activity: this.current } : {}),
      });
      if (this.failureStreak) this.logger.info("Working-state reporting recovered", { roomId: this.roomId });
      this.failureStreak = false;
    } catch (error) {
      if (hasStatusCode(error, HTTP_NOT_FOUND)) {
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

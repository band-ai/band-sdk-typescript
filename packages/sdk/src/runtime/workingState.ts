import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { ReportActivityOptions } from "../client/rest/requestOptions";
import { AsyncLocalStorage } from "node:async_hooks";
import { activitySchema, REASONING, sameActivity, type Activity } from "../contracts/activity";
import type { MetadataMap } from "../contracts/dtos";
import { overrideTools } from "../core/overrideTools";
import { resolveLogger, type Logger } from "../core/logger";
import type { ResolvedSessionConfig } from "./types";

export type ReportFn = (working: boolean, options: ReportActivityOptions) => Promise<unknown>;
const WORKING_CYCLE = Symbol("workingCycle");
export const SCOPED_TOOL_EXECUTOR = Symbol("scopedToolExecutor");
const suppressed = new AsyncLocalStorage<boolean>();
interface CycleTools extends AdapterToolsProtocol {
  [WORKING_CYCLE]?: WorkingLease;
  [SCOPED_TOOL_EXECUTOR]?: (tools: AdapterToolsProtocol, name: string, args: MetadataMap) => Promise<unknown>;
}

export interface WorkingLease {
  ready: Promise<void>;
  end(): Promise<void>;
  retain(): () => Promise<void>;
  observe(activity: unknown): Promise<void>;
  permission(waiting: boolean): Promise<void>;
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

export async function reportToolActivity(tools: object, name: string): Promise<void> {
  if (!suppressed.getStore()) await (tools as CycleTools)[WORKING_CYCLE]?.observe({ kind: "tool_call", name });
}

export async function endToolActivity(tools: object): Promise<void> {
  if (!suppressed.getStore()) await (tools as CycleTools)[WORKING_CYCLE]?.observe(REASONING);
}

export async function reportMemoryActivity(tools: object, active: boolean): Promise<void> {
  if (!suppressed.getStore()) await (tools as CycleTools)[WORKING_CYCLE]?.observe(active ? { kind: "memory" } : REASONING);
}

export async function setPermissionActivity(tools: object, waiting: boolean): Promise<void> {
  if (!suppressed.getStore()) await (tools as CycleTools)[WORKING_CYCLE]?.permission(waiting);
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
      observe: async (value) => {
        if (!this.active(token)) return;
        const parsed = activitySchema.safeParse(value);
        if (!parsed.success) {
          if (!this.invalidObservationLogged) this.logger.debug("Invalid activity observation ignored", { roomId: this.roomId });
          this.invalidObservationLogged = true;
          return;
        }
        const activity = Object.freeze(parsed.data);
        await this.enqueue(async () => {
          if (!this.active(token)) return;
          const contribution = this.leases.get(token)!;
          if (sameActivity(contribution.activity, activity)) return;
          contribution.activity = activity;
          contribution.order = ++this.sequence;
          await this.publishSelection();
        });
      },
      permission: async (waiting) => {
        await this.enqueue(async () => {
          if (!this.active(token)) return;
          const contribution = this.leases.get(token)!;
          if (contribution.permission === waiting) return;
          contribution.permission = waiting;
          await this.publishSelection();
        });
      },
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
      if (contribution.permission) { selected = { kind: "permission" }; break; }
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

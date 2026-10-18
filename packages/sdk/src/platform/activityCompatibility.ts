import type { Logger } from "../core/logger";

const MIN_AGENT_VERSION = [1, 25, 0] as const;

function supportsDetail(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("agent_version" in value) ||
    typeof value.agent_version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.agent_version)) return false;
  const version = value.agent_version.split(".").map(Number);
  if (!version.every(Number.isSafeInteger)) return false;
  for (const [index, minimum] of MIN_AGENT_VERSION.entries()) {
    if (version[index] !== minimum) return version[index] > minimum;
  }
  return true;
}

/** The first reporting origin defines discovery for this process. */
export class ActivityCompatibility {
  private discovery?: Promise<boolean>;
  private downgraded = false;

  public get enabled(): boolean { return !this.downgraded; }

  public downgrade(logger: Logger): void {
    if (this.downgraded) return;
    this.downgraded = true;
    logger.debug("Activity detail unavailable; retaining boolean reporting");
  }

  public async available(origin: string, remainingMs: number, signal: AbortSignal, logger: Logger): Promise<boolean> {
    if (this.downgraded || signal.aborted || remainingMs <= 0) return false;
    const budget = remainingMs / 2;
    this.discovery ??= this.discover(origin, budget, logger);
    return await new Promise<boolean>((resolve) => {
      const finish = (supported: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(supported && !this.downgraded);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(abort, budget);
      timer.unref?.();
      signal.addEventListener("abort", abort, { once: true });
      void this.discovery!.then(finish);
    });
  }

  private async discover(origin: string, budget: number, logger: Logger): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    try {
      const response = await fetch(new URL("/api/version", origin), { signal: controller.signal });
      const supported = response.ok && supportsDetail(await response.json());
      if (!supported) logger.debug("Activity version discovery unavailable; retaining boolean reporting");
      return supported;
    } catch {
      logger.debug("Activity version discovery unavailable; retaining boolean reporting");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const activityCompatibility = new ActivityCompatibility();

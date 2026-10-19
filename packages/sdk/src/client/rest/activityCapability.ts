import { DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS } from "../../contracts/activity";
import { resolveLogger, type Logger } from "../../core/logger";

/** First agent API release whose working report accepts `activity` (platform changelog 1.25.0). */
const MIN_API_VERSION = [1, 25, 0] as const;
/** Served under the REST base URL by every host that serves REST; `/api/version` is not (app.band.ai answers it with HTML). */
const HEALTH_PATH = "api/v1/health";
const ORDINARY_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ActivityDetailSupport = "unknown" | "supported" | "unsupported";

function isSupportedRelease(apiVersion: unknown): boolean {
  if (typeof apiVersion !== "string" || !ORDINARY_RELEASE.test(apiVersion)) return false;
  const release = apiVersion.split(".").map(Number);
  if (!release.every(Number.isSafeInteger)) return false;
  for (const [index, minimum] of MIN_API_VERSION.entries()) {
    if (release[index] !== minimum) return release[index] > minimum;
  }
  return true;
}

/**
 * Whether one REST endpoint accepts `activity` on the working report. A definitive answer is final; a
 * transient failure leaves the answer unknown so a later report asks again. Asking never delays a report.
 */
export class ActivityCapability {
  private support: ActivityDetailSupport = "unknown";
  private pending?: Promise<ActivityDetailSupport>;
  private failing = false;
  private readonly healthUrl: URL;
  private readonly logger: Logger;

  public constructor(options: { origin: string; logger?: Logger }) {
    this.healthUrl = new URL(HEALTH_PATH, options.origin.endsWith("/") ? options.origin : `${options.origin}/`);
    this.logger = resolveLogger(options.logger);
  }

  /** Whether detail may be sent now; an unknown answer starts one lookup and reports false. */
  public allowsDetail(timeoutSeconds = DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS): boolean {
    if (this.support === "unknown") void this.lookup(timeoutSeconds);
    return this.support === "supported";
  }

  /** The platform rejected a detail-bearing report: stop sending detail on this endpoint. */
  public markUnsupported(): void {
    if (this.support !== "unsupported") this.resolve("unsupported", "rejected by the platform");
  }

  /** The current answer, or the one shared in-flight lookup that will settle it. */
  public lookup(timeoutSeconds = DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS): Promise<ActivityDetailSupport> {
    if (this.support !== "unknown") return Promise.resolve(this.support);
    this.pending ??= this.fetchSupport(timeoutSeconds).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetchSupport(timeoutSeconds: number): Promise<ActivityDetailSupport> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    timer.unref?.();
    try {
      const response = await fetch(this.healthUrl, { signal: controller.signal });
      const text = await response.text();
      if (response.status >= 500 || response.status === 429) return this.retryLater(`HTTP ${response.status}`);
      const supported = response.ok && isSupportedRelease(parseApiVersion(text));
      return this.settle(supported ? "supported" : "unsupported", `HTTP ${response.status}`);
    } catch (error) {
      return this.retryLater(error instanceof Error ? error.name : "failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** A lookup answers only an unknown endpoint; it never overrides what the platform itself rejected. */
  private settle(next: Exclude<ActivityDetailSupport, "unknown">, reason: string): ActivityDetailSupport {
    if (this.support === "unknown") this.resolve(next, reason);
    return this.support;
  }

  private resolve(next: Exclude<ActivityDetailSupport, "unknown">, reason: string): void {
    this.support = next;
    this.failing = false;
    this.logger.debug("Activity detail support resolved", { origin: this.healthUrl.origin, support: next, reason });
  }

  /** One log per failure streak: lookups repeat on every report while the endpoint is down. */
  private retryLater(reason: string): ActivityDetailSupport {
    if (!this.failing) {
      this.failing = true;
      this.logger.debug("Activity detail support lookup failed; the next report asks again", { origin: this.healthUrl.origin, reason });
    }
    return this.support;
  }
}

function parseApiVersion(text: string): unknown {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && "api_version" in body ? body.api_version : undefined;
  } catch {
    return undefined;
  }
}

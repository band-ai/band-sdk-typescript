import type { Logger } from "@band-ai/sdk/core";
import type { RestApi } from "@band-ai/sdk/rest";

/** One quick try per report: Band clears the indicator itself 10 s after the last one. */
export const ACTIVITY_REQUEST = { maxRetries: 0, timeoutInSeconds: 5 } as const;

/**
 * Band's working indicator per room: on when a message is pushed, off once Claude posts there or
 * the server stops. Reports for a room run in order on its own chain, and nobody awaits them.
 */
export class WorkingIndicator {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly working = new Set<string>();
  private closed = false;

  public constructor(
    private readonly rest: Pick<RestApi, "reportActivity">,
    private readonly logger: Logger,
  ) {}

  public start(roomId: string): void {
    if (this.closed) {
      return;
    }
    this.working.add(roomId);
    this.report(roomId, true);
  }

  public stop(roomId: string): void {
    if (this.working.delete(roomId)) {
      this.report(roomId, false);
    }
  }

  /** Ends this connection's activity, including late pushes; resolves once all reports settle. */
  public async stopAll(): Promise<void> {
    this.closed = true;
    for (const roomId of [...this.working]) {
      this.stop(roomId);
    }
    await Promise.all(this.chains.values());
  }

  private report(roomId: string, working: boolean): void {
    const previous = this.chains.get(roomId) ?? Promise.resolve();
    this.chains.set(roomId, previous.then(async () => {
      try {
        if (!this.rest.reportActivity) {
          throw new Error("Band's REST client can't report activity");
        }
        await this.rest.reportActivity(roomId, working, ACTIVITY_REQUEST);
      } catch (error) {
        // A 404 means the room has no active execution: a state, not a fault.
        this.logger.debug("Band working report failed", { roomId, working, error });
      }
    }));
  }
}

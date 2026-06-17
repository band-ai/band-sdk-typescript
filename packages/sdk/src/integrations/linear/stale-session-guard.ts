import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { postThought, type LinearActivityClient } from "./activities";
import type { SessionRoomRecord, SessionRoomStore } from "./types";
import { STALE_SESSION_CHECK_INTERVAL_MS, STALE_SESSION_THRESHOLD_MS } from "./types";

export interface StaleSessionGuardOptions {
  store: SessionRoomStore;
  linearClient: LinearActivityClient;
  logger?: Logger;
  /** Interval (ms) between keepalive checks. Defaults to 20 minutes. */
  checkIntervalMs?: number;
  /** Max age (ms) of last activity before sending a keepalive. Defaults to 25 minutes. */
  staleThresholdMs?: number;
  /** Message sent as a keepalive thought. */
  keepAliveMessage?: string;
}

const DEFAULT_KEEPALIVE_MESSAGE =
  "Still working — waiting for specialist output in the collaboration room.";

/**
 * Periodically checks active Linear sessions and sends a keepalive activity
 * to prevent Linear from marking them as stale (30-minute inactivity timeout).
 */
export class StaleSessionGuard {
  private readonly store: SessionRoomStore;
  private readonly linearClient: LinearActivityClient;
  private readonly logger: Logger;
  private readonly checkIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly keepAliveMessage: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(options: StaleSessionGuardOptions) {
    this.store = options.store;
    this.linearClient = options.linearClient;
    this.logger = options.logger ?? new NoopLogger();
    this.checkIntervalMs = options.checkIntervalMs ?? STALE_SESSION_CHECK_INTERVAL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? STALE_SESSION_THRESHOLD_MS;
    this.keepAliveMessage = options.keepAliveMessage ?? DEFAULT_KEEPALIVE_MESSAGE;
  }

  /** Start the periodic keepalive check. Safe to call multiple times. */
  public start(): void {
    if (this.timer) {
      return;
    }

    this.logger.info("stale_session_guard.started", {
      checkIntervalMs: this.checkIntervalMs,
      staleThresholdMs: this.staleThresholdMs,
    });

    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);

    // Allow the process to exit even if the timer is running.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop the periodic keepalive check. */
  public stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    this.logger.info("stale_session_guard.stopped", {});
  }

  /** Run a single keepalive check. Exposed for testing and manual invocation. */
  public async tick(): Promise<number> {
    if (!this.store.listActiveSessions) {
      this.logger.warn("stale_session_guard.store_missing_listActiveSessions", {});
      return 0;
    }

    let sessions: SessionRoomRecord[];
    try {
      sessions = await this.store.listActiveSessions();
    } catch (error) {
      this.logger.error("stale_session_guard.list_sessions_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    const now = Date.now();
    let kept = 0;

    for (const session of sessions) {
      if (isSessionStale(session, now, this.staleThresholdMs)) {
        try {
          await postThought(this.linearClient, session.linearSessionId, this.keepAliveMessage);
          const activityTimestamp = new Date().toISOString();
          await this.store.upsert({
            ...session,
            lastLinearActivityAt: activityTimestamp,
            updatedAt: activityTimestamp,
          });
          kept += 1;
          this.logger.info("stale_session_guard.keepalive_sent", {
            sessionId: session.linearSessionId,
            lastLinearActivityAt: session.lastLinearActivityAt,
          });
        } catch (error) {
          this.logger.warn("stale_session_guard.keepalive_failed", {
            sessionId: session.linearSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (kept > 0) {
      this.logger.info("stale_session_guard.tick_complete", {
        totalSessions: sessions.length,
        keepalivesSent: kept,
      });
    }

    return kept;
  }
}

/**
 * Returns `true` when the session's last Linear activity is older than
 * `thresholdMs`, meaning it risks being marked stale by Linear.
 */
export function isSessionStale(
  session: SessionRoomRecord,
  nowMs: number,
  thresholdMs: number,
): boolean {
  // If we've never tracked an activity, fall back to the record's updatedAt
  // (which is set when the session was last written to the store).
  const referenceIso = session.lastLinearActivityAt ?? session.updatedAt;
  const referenceMs = new Date(referenceIso).getTime();

  if (Number.isNaN(referenceMs)) {
    return true;
  }

  return nowMs - referenceMs >= thresholdMs;
}

/**
 * Checks whether a session may have gone stale and sends a recovery activity
 * before the main update. Call this before posting significant activities to
 * a session that may have been idle for a long time.
 */
export async function sendRecoveryActivityIfStale(input: {
  session: SessionRoomRecord;
  linearClient: LinearActivityClient;
  store: SessionRoomStore;
  logger: Logger;
  staleThresholdMs?: number;
}): Promise<boolean> {
  const thresholdMs = input.staleThresholdMs ?? STALE_SESSION_THRESHOLD_MS;

  if (!isSessionStale(input.session, Date.now(), thresholdMs)) {
    return false;
  }

  try {
    await postThought(
      input.linearClient,
      input.session.linearSessionId,
      "Resuming session — reconnecting after extended specialist work.",
    );

    const now = new Date().toISOString();
    await input.store.upsert({
      ...input.session,
      lastLinearActivityAt: now,
      updatedAt: now,
    });

    input.logger.info("stale_session_guard.recovery_activity_sent", {
      sessionId: input.session.linearSessionId,
      lastLinearActivityAt: input.session.lastLinearActivityAt,
    });

    return true;
  } catch (error) {
    input.logger.warn("stale_session_guard.recovery_activity_failed", {
      sessionId: input.session.linearSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

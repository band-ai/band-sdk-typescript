import { resolveLogger, type Logger } from "../../core/logger";
import { abandon } from "./abandon";

export const MINTED_TOKEN_LENGTH = 8;

// null → anyone may resolve; any set (empty included) → members only.
export function isAuthorizedSender(allowed: ReadonlySet<string> | null, senderId: string): boolean {
  return allowed === null || allowed.has(senderId);
}

interface DecisionEntry<T> {
  payload: T;
  claimed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Asks posted to a chat and awaiting a reply, by token. Whoever claims an
 * entry first — a reply, its timeout, or a cancellation — owns its outcome;
 * every later path finds nothing to claim.
 */
export class DecisionRegistry<T> {
  private readonly entries = new Map<string, DecisionEntry<T>>();
  private readonly logger: Logger;

  public constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
  }

  /** Registers under a minted token. */
  public register(payload: T): string;
  /** Registers under `key`, replacing an unclaimed predecessor; null if it's claimed. */
  public register(payload: T, key: string): string | null;
  public register(payload: T, key?: string): string | null {
    if (key !== undefined) {
      const existing = this.entries.get(key);
      if (existing?.claimed) {
        return null;
      }
      clearTimeout(existing?.timer);
    }
    const token = key ?? this.mintToken();
    this.entries.set(token, { payload, claimed: false });
    return token;
  }

  /** On expiry, claims the entry and runs `onTimeout` only if that claim wins. */
  public startTimeout(token: string, ms: number, onTimeout: (payload: T) => Promise<void> | void): void {
    const entry = this.entries.get(token);
    // `setTimeout` coerces Infinity to 1ms, so "unbounded" must never arm.
    if (!entry || !Number.isFinite(ms)) {
      return;
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const payload = this.tryClaim(token);
      if (payload === undefined) {
        return;
      }
      abandon(async () => onTimeout(payload), (error) => {
        this.logger.warn("decisions.timeout_handler_failed", { token, error });
      });
    }, ms);
  }

  /** Takes ownership once and stops the timer; the entry stays until `forget`. */
  public tryClaim(token: string): T | undefined {
    const entry = this.entries.get(token);
    if (!entry || entry.claimed) {
      return undefined;
    }
    entry.claimed = true;
    clearTimeout(entry.timer);
    return entry.payload;
  }

  public forget(token: string): void {
    clearTimeout(this.entries.get(token)?.timer);
    this.entries.delete(token);
  }

  /** Claims and forgets in one step; undefined when someone else owns it. */
  public withdraw(token: string): T | undefined {
    const payload = this.tryClaim(token);
    if (payload !== undefined) {
      this.forget(token);
    }
    return payload;
  }

  /**
   * Drops every matching entry and returns the unclaimed ones for the caller
   * to resolve. A claimed entry's claimant still resolves it, so an expiry
   * already running its handler completes.
   */
  public cancelAll(predicate: (payload: T) => boolean = () => true): T[] {
    const unclaimed: T[] = [];
    for (const [token, entry] of this.entries) {
      if (!predicate(entry.payload)) {
        continue;
      }
      this.forget(token);
      if (!entry.claimed) {
        unclaimed.push(entry.payload);
      }
    }
    return unclaimed;
  }

  public get(token: string): T | undefined {
    return this.entries.get(token)?.payload;
  }

  public has(token: string): boolean {
    return this.entries.has(token);
  }

  public get size(): number {
    return this.entries.size;
  }

  /** Insertion order, oldest first. */
  public keys(): string[] {
    return [...this.entries.keys()];
  }

  private mintToken(): string {
    let token: string;
    do {
      token = crypto.randomUUID().replaceAll("-", "").slice(0, MINTED_TOKEN_LENGTH);
    } while (this.entries.has(token));
    return token;
  }
}

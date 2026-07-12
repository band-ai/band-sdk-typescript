/**
 * Local, on-disk dedup guard for inbound Band messages.
 *
 * Per INT-876: Band's `markProcessed` REST endpoint (POST
 * .../messages/{id}/processed) 422s on every call in this environment (see
 * transport.ts's `sdkLogger` wiring, which is what surfaced it — the SDK
 * previously swallowed the failure via a NoopLogger). Because that call never
 * actually advances the server-side cursor, `AgentRuntime`'s backlog drain
 * (Execution.synchronizeWithNext) redelivers a room's already-answered
 * messages on every gateway restart.
 *
 * Since the server-side ack is unreliable, this plugin keeps its own
 * idempotency record: every message id it has successfully handed to dispatch
 * is persisted here, so a redelivered backlog message is recognized and
 * skipped instead of being re-dispatched (and re-answered) a second time.
 * This is a mitigation for an unreliable upstream endpoint, not a fix to it —
 * if/when the Band `processed` endpoint starts working, this becomes a cheap
 * no-op double-check.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bound the on-disk record so it can't grow without limit across a long-lived account. */
const MAX_ENTRIES = 2000;

export interface ProcessedStore {
  has(messageId: string): boolean;
  markProcessed(messageId: string): Promise<void>;
}

export function defaultProcessedStoreDir(accountId: string): string {
  return join(homedir(), ".openclaw", "state", "openclaw-channel-band", accountId);
}

/**
 * Build a `ProcessedStore` backed by a single JSON file: `[...messageIds]`,
 * oldest-first, capped at `MAX_ENTRIES`. Loaded synchronously once at
 * construction (small file, read once per account start); writes are
 * serialized through a promise chain so concurrent markProcessed calls can't
 * interleave and corrupt the file.
 */
export function createProcessedStore(
  accountId: string,
  stateDir: string | undefined,
  log: (msg: string) => void,
): ProcessedStore {
  const dir = stateDir ?? defaultProcessedStoreDir(accountId);
  const file = join(dir, "processed-messages.json");

  let ids: string[] = [];
  let seen = new Set<string>();
  try {
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) {
        ids = raw.filter((entry): entry is string => typeof entry === "string");
        seen = new Set(ids);
      }
    }
  } catch (err) {
    log(`[band:${accountId}] failed to load processed-message store (${file}): ${String(err)}`);
  }

  let writeChain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    writeChain = writeChain.then(async () => {
      try {
        mkdirSync(dir, { recursive: true });
        await writeFile(file, JSON.stringify(ids), "utf8");
      } catch (err) {
        log(`[band:${accountId}] failed to persist processed-message store (${file}): ${String(err)}`);
      }
    });
    return writeChain;
  }

  return {
    has(messageId: string): boolean {
      return seen.has(messageId);
    },
    async markProcessed(messageId: string): Promise<void> {
      if (seen.has(messageId)) return;
      seen.add(messageId);
      ids.push(messageId);
      if (ids.length > MAX_ENTRIES) {
        const evicted = ids.splice(0, ids.length - MAX_ENTRIES);
        for (const id of evicted) seen.delete(id);
      }
      await persist();
    },
  };
}

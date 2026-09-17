export interface SyncBoundary {
  messageId: string | null;
}

/**
 * Tracks which messages a room's Execution has already run — so a message
 * seen twice, via bootstrap, a backlog scan, or live delivery, never
 * executes twice — and how far each reconnect's backlog scan has to catch
 * up before live delivery can safely take over.
 *
 * A "boundary" marks one scan's finish line: the id of the live message
 * that arrived through the same reconnect gap the scan is backfilling,
 * once that message is known. Boundaries queue in arrival order because a
 * live message always anchors the oldest not-yet-anchored boundary — the
 * one whose scan either owns it now or will next — never whichever
 * reconnect was queued most recently, so a boundary already mid-scan can't
 * be silently orphaned by a newer reconnect queued before its own live
 * message arrives.
 */
export class SyncBoundaryTracker {
  // Every message id a sync scan has ever executed. Entries are never
  // removed: evicting on a message's own live redelivery was tried and
  // proved unsafe, because the backend can still return that same id from
  // `getNextMessage()` on a *later* reconnect's scan before its
  // mark-as-processed effect has propagated — an eviction keyed on "we saw
  // it once already" reopens exactly that race, just on a different
  // trigger. Permanent membership is what makes "already executed"
  // unconditional, at the cost of one entry per message ever synced via a
  // backlog scan for the life of this tracker — a real, bounded quantity.
  private readonly executedMessageIds = new Set<string>();
  public readonly initial: SyncBoundary = { messageId: null };
  // Ordered, oldest first, matching the order scans run in.
  private readonly queue: SyncBoundary[] = [this.initial];

  /** Whether every queued boundary's scan has finished. */
  public get isComplete(): boolean {
    return this.queue.length === 0;
  }

  public recordExecuted(messageId: string): void {
    this.executedMessageIds.add(messageId);
  }

  public isExecuted(messageId: string): boolean {
    return this.executedMessageIds.has(messageId);
  }

  public isSyncPoint(boundary: SyncBoundary, messageId: string): boolean {
    return boundary.messageId !== null && messageId === boundary.messageId;
  }

  /** Anchors the oldest not-yet-anchored boundary to a live message's id, if one is open. */
  public anchor(messageId: string): void {
    const openBoundary = this.queue.find((boundary) => boundary.messageId === null);
    if (openBoundary) {
      openBoundary.messageId = messageId;
    }
  }

  /** Starts a new scan boundary for a reconnect and returns it. */
  public beginBoundary(): SyncBoundary {
    const boundary: SyncBoundary = { messageId: null };
    this.queue.push(boundary);
    return boundary;
  }

  /** Marks `boundary`'s scan finished, dequeuing it only if it's still the oldest. */
  public completeBoundary(boundary: SyncBoundary): void {
    if (this.queue[0] === boundary) {
      this.queue.shift();
    }
  }
}

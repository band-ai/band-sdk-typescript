import type { ReconnectSnapshot } from "./transport";

interface GenerationRecord {
  pending: Set<string>;
  attempted: Set<string>;
  joined: Set<string>;
}

/**
 * Tracks, per socket-open generation, which topics are still settling and
 * which joined — and reports a finalized snapshot once every topic attempted
 * at that generation's start has settled one way or another (joined, or
 * explicitly removed via `removeTopic`). A generation forced to finalize
 * early by a newer one omits its still-pending topics from the snapshot's
 * `attemptedTopics` entirely, rather than reporting them as failed — they
 * merely never got a reply before being superseded, and the generation that
 * superseded them is what will report their real outcome.
 */
export class ReconnectGenerationTracker {
  private readonly generations = new Map<number, GenerationRecord>();
  private currentGeneration = 0;

  public constructor(
    private readonly onSettled: (snapshot: ReconnectSnapshot) => void,
    private readonly onGenerationDropped?: (generation: number, pendingTopics: number) => void,
  ) {}

  public beginGeneration(topics: Iterable<string>): number {
    const generation = ++this.currentGeneration;
    const attempted = new Set(topics);

    // A generation superseded by this newer one will never receive another
    // settlement for its stragglers (Phoenix rebinds each rejoined push's
    // reply listener on `resend()`, so a stale reply can no longer arrive).
    // Finalize it now with whatever settled before it was superseded, rather
    // than dropping it silently — anything still pending here would
    // otherwise never notify, and a caller awaiting that settlement (e.g. a
    // reconnect barrier keyed to this generation) would hang forever.
    //
    // A topic still in `pending` at this point never got a reply before
    // being superseded — that is not the same as having failed to join, so
    // it must not be reported as "attempted" here (which reconciliation
    // reads as "attempted and not joined, therefore failed"). It stays
    // `attempted` in whichever generation is current when it actually
    // settles, so that generation's own real outcome drives reconciliation
    // for it instead.
    for (const staleGeneration of this.generations.keys()) {
      if (staleGeneration < generation) {
        const stale = this.generations.get(staleGeneration);
        if (stale) {
          this.onGenerationDropped?.(staleGeneration, stale.pending.size);
          this.generations.delete(staleGeneration);
          const settledTopics = new Set(
            [...stale.attempted].filter((topic) => !stale.pending.has(topic)),
          );
          this.onSettled({
            generation: staleGeneration,
            attemptedTopics: settledTopics,
            joinedTopics: stale.joined,
          });
        }
      }
    }

    this.generations.set(generation, { pending: new Set(attempted), attempted, joined: new Set() });
    this.maybeFinalize(generation);
    return generation;
  }

  public recordSettled(topic: string, joined: boolean): void {
    const record = this.generations.get(this.currentGeneration);
    if (!record?.pending.delete(topic)) {
      return;
    }

    if (joined) {
      record.joined.add(topic);
    }
    this.maybeFinalize(this.currentGeneration);
  }

  public removeTopic(topic: string): void {
    for (const [generation, record] of this.generations) {
      if (record.pending.delete(topic)) {
        this.maybeFinalize(generation);
      }
    }
  }

  public reset(): void {
    this.generations.clear();
    this.currentGeneration = 0;
  }

  private maybeFinalize(generation: number): void {
    const record = this.generations.get(generation);
    if (!record || record.pending.size > 0) {
      return;
    }

    this.generations.delete(generation);
    this.onSettled({ generation, attemptedTopics: record.attempted, joinedTopics: record.joined });
  }
}

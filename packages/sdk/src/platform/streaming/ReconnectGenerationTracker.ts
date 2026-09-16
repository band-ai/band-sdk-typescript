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
 * explicitly removed via `removeTopic`). A newer socket open supersedes an
 * unfinished observation. It is discarded rather than force-finalized: a
 * missing reply is neither a join failure nor a recovery boundary.
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

    // Phoenix resets a rejoined Push's reply routing. Once another socket
    // open starts, the old observation can no longer become authoritative.
    // Dropping it keeps the recovery barrier owned by the current generation
    // and, crucially, does not turn an unanswered join into a failed one.
    for (const staleGeneration of this.generations.keys()) {
      if (staleGeneration < generation) {
        const stale = this.generations.get(staleGeneration);
        if (stale) {
          this.onGenerationDropped?.(staleGeneration, stale.pending.size);
          this.generations.delete(staleGeneration);
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

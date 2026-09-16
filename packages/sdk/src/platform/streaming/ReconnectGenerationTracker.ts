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
 * explicitly removed via `removeTopic`).
 */
export class ReconnectGenerationTracker {
  private readonly generations = new Map<number, GenerationRecord>();
  private currentGeneration = 0;

  public constructor(private readonly onSettled: (snapshot: ReconnectSnapshot) => void) {}

  public beginGeneration(topics: Iterable<string>): number {
    const generation = ++this.currentGeneration;
    const attempted = new Set(topics);

    // A generation superseded by this newer one will never receive another
    // settlement for its stragglers (Phoenix rebinds each rejoined push's
    // reply listener on `resend()`, so a stale reply can no longer arrive) —
    // drop it now rather than leaking it forever.
    for (const staleGeneration of this.generations.keys()) {
      if (staleGeneration < generation) {
        this.generations.delete(staleGeneration);
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

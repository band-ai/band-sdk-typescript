/** Minimum shape the tracker needs: anything with an `id` it can compare. */
interface HasId {
  id?: unknown;
}

/**
 * Holds a room's participant list and tracks whether it has changed since the last time
 * it was rendered into the conversation.
 *
 * `ExecutionContext` composes this rather than reimplementing the same bookkeeping.
 */
export class ParticipantTracker<T extends HasId = Record<string, unknown>> {
  // Mutated in place, never reassigned: callers (AgentTools) may hold a live reference
  // to this array via `liveView`, and reassigning would leave them reading a stale copy.
  private readonly participantsList: T[] = [];
  private lastSent: T[] | null = null;
  private loaded = false;

  /** Defensive copy. Mutating the result does not affect the tracker. */
  public get participants(): T[] {
    return this.participantsList.map((participant) => ({ ...participant }));
  }

  /**
   * The tracker's own array, by reference. For collaborators that must observe updates
   * without being handed a new array each time. Do not mutate it directly.
   */
  public get liveView(): T[] {
    return this.participantsList;
  }

  public get isLoaded(): boolean {
    return this.loaded;
  }

  public setLoaded(participants: readonly T[]): void {
    this.replace(participants);
    this.loaded = true;
  }

  /** Replaces the contents in place, preserving the array identity. */
  public replace(participants: readonly T[]): void {
    this.participantsList.splice(
      0,
      this.participantsList.length,
      ...participants.map((participant) => ({ ...participant })),
    );
  }

  /**
   * Appends a participant. Returns false (and does nothing) if the id is already present.
   *
   * The stored entry is a shallow copy of everything passed in. (Before this class became
   * generic it copied a fixed id/name/type/handle shape and dropped any other field.)
   */
  public add(participant: T): boolean {
    if (this.participantsList.some((entry) => entry.id === participant.id)) {
      return false;
    }

    this.participantsList.push({ ...participant });
    return true;
  }

  /**
   * Adds a participant, moving it to the end if its id is already present. Distinct from
   * {@link add}, which leaves an existing entry alone.
   */
  public upsert(participant: T): void {
    const existingIndex = this.participantsList.findIndex((entry) => entry.id === participant.id);
    if (existingIndex >= 0) {
      this.participantsList.splice(existingIndex, 1);
    }
    this.participantsList.push({ ...participant });
  }

  public remove(participantId: string): boolean {
    const before = this.participantsList.length;
    const kept = this.participantsList.filter(
      (participant) => String(participant.id) !== participantId,
    );
    this.participantsList.splice(0, this.participantsList.length, ...kept);
    return this.participantsList.length < before;
  }

  /** Finds a participant by id, or undefined. Returns the live entry, not a copy. */
  public find(participantId: string): T | undefined {
    return this.participantsList.find((entry) => String(entry.id) === participantId);
  }

  public changed(): boolean {
    if (!this.lastSent) {
      return true;
    }

    const oldIds = new Set(this.lastSent.map((participant) => String(participant.id)));
    const newIds = new Set(this.participantsList.map((participant) => String(participant.id)));

    if (oldIds.size !== newIds.size) {
      return true;
    }

    for (const id of oldIds) {
      if (!newIds.has(id)) {
        return true;
      }
    }

    return false;
  }

  public markSent(): void {
    this.lastSent = this.participantsList.map((participant) => ({ ...participant }));
  }
}

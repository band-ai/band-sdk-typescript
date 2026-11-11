import type { AgentControl } from "../platform/control";

/** How many recent `agent.control` correlation ids are remembered to drop Band's repeats. */
export const MAX_SEEN_CONTROL_IDS = 256;

/** Drops a repeated `agent.control` signal by its correlation id; Band does not deduplicate. */
export class ControlDeduplicator {
  // Insertion-ordered, so the first key is the oldest.
  private readonly seen = new Set<string>();

  /** Whether `control` is new; records it. */
  public firstSighting(control: AgentControl): boolean {
    if (this.seen.has(control.correlationId)) {
      return false;
    }
    this.seen.add(control.correlationId);
    if (this.seen.size > MAX_SEEN_CONTROL_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

/** The handled rooms a signal reaches: its own room, or every room for an agent-wide one. */
export function controlTargets(control: AgentControl, handledRoomIds: readonly string[]): string[] {
  if (control.roomId !== null) {
    return handledRoomIds.includes(control.roomId) ? [control.roomId] : [];
  }
  return control.scope === "agent" ? [...handledRoomIds] : [];
}

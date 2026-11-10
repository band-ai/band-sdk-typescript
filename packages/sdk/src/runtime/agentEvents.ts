import type { AgentEvent, AgentEventListener } from "../contracts/events";
import { notifyEach } from "../core/listeners";
import type { Logger } from "../core/logger";

interface PendingEvent {
  event: AgentEvent;
  /** Listeners registered when the event was emitted; later ones never see it. */
  recipients: AgentEventListener[];
}

/**
 * Fans each event out to every listener, isolating listener failures from the
 * emitter and each other. Delivery is deferred to a microtask, in emit order,
 * so a listener that calls back into the agent never lands mid-operation.
 */
export class AgentEventHub {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly pending: PendingEvent[] = [];

  public constructor(private readonly logger: Logger) {}

  /** Adds `listener`; the returned function removes it, including from events not yet delivered. */
  public observe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public readonly emit = (event: AgentEvent): void => {
    if (this.listeners.size === 0) {
      return;
    }
    this.pending.push({ event, recipients: [...this.listeners] });
    // A drain already queued or running picks this event up in order.
    if (this.pending.length === 1) {
      queueMicrotask(this.drain);
    }
  };

  private readonly drain = (): void => {
    // Shifted only after delivery, so an emit from inside a listener joins this drain.
    for (let next = this.pending[0]; next; next = this.pending[0]) {
      const { event, recipients } = next;
      notifyEach(recipients.filter((listener) => this.listeners.has(listener)), event, (error) => {
        this.logger.warn("agent_events.listener_failed", { eventType: event.type, error });
      });
      this.pending.shift();
    }
  };
}

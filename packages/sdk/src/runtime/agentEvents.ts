import type { AgentEvent, AgentEventListener } from "../contracts/events";
import { notifyEach } from "../core/listeners";
import type { Logger } from "../core/logger";

/** One `observe` call; a listener added again is a new registration. */
interface Registration {
  listener: AgentEventListener;
}

interface PendingEvent {
  event: AgentEvent;
  /** Registrations live when the event was emitted; later ones never see it. */
  recipients: Registration[];
}

/**
 * Wraps `listener` so a throw or rejection is logged rather than reaching the
 * code that reported the event.
 */
export function isolatedListener(listener: AgentEventListener, logger: Logger): AgentEventListener {
  return (event) => notifyEach([listener], event, (error) => logListenerFailure(logger, event, error));
}

function logListenerFailure(logger: Logger, event: AgentEvent, error: unknown): void {
  logger.warn("agent_events.listener_failed", { eventType: event.type, error });
}

/** Fans each event out to every listener under the delivery rules on {@link AgentEventListener}. */
export class AgentEventHub {
  private readonly registrations = new Set<Registration>();
  private readonly pending: PendingEvent[] = [];

  public constructor(private readonly logger: Logger) {}

  /** Adds `listener`; the returned function removes it, including from events not yet delivered. */
  public observe(listener: AgentEventListener): () => void {
    const registration: Registration = { listener };
    this.registrations.add(registration);
    return () => {
      this.registrations.delete(registration);
    };
  }

  public readonly emit = (event: AgentEvent): void => {
    if (this.registrations.size === 0) {
      return;
    }
    this.pending.push({ event, recipients: [...this.registrations] });
    // A drain already queued or running picks this event up in order.
    if (this.pending.length === 1) {
      queueMicrotask(this.drain);
    }
  };

  private readonly drain = (): void => {
    // Shifted only after delivery, so an emit from inside a listener joins this drain.
    for (let next = this.pending[0]; next; next = this.pending[0]) {
      const { event, recipients } = next;
      const live = recipients.filter((registration) => this.registrations.has(registration));
      notifyEach(live.map(({ listener }) => listener), event, (error) => logListenerFailure(this.logger, event, error));
      this.pending.shift();
    }
  };
}

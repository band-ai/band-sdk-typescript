import type { AgentEvent, AgentEventListener } from "../contracts/events";
import { notifyEach } from "../core/listeners";
import type { Logger } from "../core/logger";

/** Fans each event out to every listener, isolating listener failures from the emitter and each other. */
export class AgentEventHub {
  private readonly listeners = new Set<AgentEventListener>();

  public constructor(private readonly logger: Logger) {}

  /** Adds `listener`; the returned function removes it. */
  public observe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public readonly emit = (event: AgentEvent): void => {
    // Typed `void`, but an async listener still returns its promise; `notifyEach` catches it.
    notifyEach(this.listeners, event, (error) => {
      this.logger.warn("agent_events.listener_failed", { eventType: event.type, error });
    });
  };
}

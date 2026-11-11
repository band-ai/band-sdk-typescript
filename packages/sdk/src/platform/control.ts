import { validateEventPayload } from "@band-ai/band-sdk-core";

/** The control channel's event that carries an {@link AgentControl}. */
export const AGENT_CONTROL_EVENT = "agent.control";

/** What an `agent.control` signal asks of the agent's turns in a room. */
export type AgentControlMode = "interrupt" | "stop" | "play";

/**
 * An `agent.control` signal Band pushes on the agent's control channel:
 * `interrupt` ends the running turn and consumes its message, `stop` pauses
 * the room until a `play` (the stopped turn's message is replayed then).
 * `roomId` is null for a signal to all of the agent's rooms (`scope: "agent"`).
 * Band does not deduplicate, so a consumer dedupes on `correlationId`.
 */
export interface AgentControl {
  mode: AgentControlMode;
  scope: "agent" | "room";
  agentId: string;
  roomId: string | null;
  correlationId: string;
  executionId: string | null;
  reason: string | null;
}

/** The signal, validated by Core's `agent.control` contract; null when the payload breaks it. */
export function parseAgentControl(payload: Record<string, unknown>): AgentControl | null {
  let normalized: Record<string, unknown>;
  try {
    normalized = validateEventPayload(AGENT_CONTROL_EVENT, payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    mode: normalized.mode as AgentControlMode,
    scope: normalized.scope as AgentControl["scope"],
    agentId: normalized.agent_id as string,
    roomId: typeof normalized.room_id === "string" ? normalized.room_id : null,
    correlationId: normalized.correlation_id as string,
    executionId: typeof normalized.execution_id === "string" ? normalized.execution_id : null,
    reason: typeof normalized.reason === "string" ? normalized.reason : null,
  };
}

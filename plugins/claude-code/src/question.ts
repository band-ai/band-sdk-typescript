import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { SavedAgents } from "./config";
import { agentLabel } from "./names";
import { ADD_PHRASE, agentHolders, JOIN_PHRASE, sessionPlace, type SessionStatus } from "./sessions";

/** The question's one field: the picked agent's saved name. */
const AGENT_FIELD = "agent";

export const QUESTION_MESSAGE =
  `Pick the Band agent this session acts as. Close to stay off; say ${JOIN_PHRASE} later. To add an agent, close this and say ${ADD_PHRASE}.`;

/** The question that picks this session's agent: one option per saved agent, saying which another session here holds. */
export function agentQuestion(saved: SavedAgents, sessions: readonly SessionStatus[]): ElicitRequestFormParams {
  const holders = agentHolders(sessions);
  const options = Object.entries(saved).map(([name, { agentId, handle }]) => {
    const holder = holders.get(agentId);
    const inUse = holder ? ` — in use (${sessionPlace(holder)}); picking takes it over` : "";
    return { const: name, title: `${agentLabel(name, handle)}${inUse}` };
  });
  return {
    mode: "form",
    message: QUESTION_MESSAGE,
    requestedSchema: {
      type: "object",
      properties: { [AGENT_FIELD]: { type: "string", title: "Band agent", oneOf: options } },
      required: [AGENT_FIELD],
    },
  };
}

/** The saved name the user picked; none when they closed or declined the question. */
export function pickedAgent(result: ElicitResult): string | undefined {
  const picked = result.action === "accept" ? result.content?.[AGENT_FIELD] : undefined;
  return typeof picked === "string" ? picked : undefined;
}

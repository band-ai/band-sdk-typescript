/**
 * Plain Parlant agent — point at an existing Parlant agent and connect it
 * to Thenvoi.
 *
 * Use this when you've already provisioned a Parlant agent (configured
 * its description + guidelines on your Parlant server) and just want to
 * pipe a Thenvoi room into it. Pass `PARLANT_AGENT_ID` to identify the
 * remote Parlant agent.
 *
 * For provisioning a fresh Parlant agent at startup (description +
 * guidelines defined inline in TS), see `01-basic-agent.ts` and the
 * other numbered scenarios in this folder.
 */
import {
  Agent,
  ParlantAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

export function createParlantAgent(
  options: {
    /** Parlant server URL. */
    environment: string;
    /** ID of the Parlant agent on that server. */
    agentId: string;
    /** Optional API key if your Parlant server enforces one. */
    apiKey?: string;
  },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ParlantAdapter({
    environment: options.environment,
    agentId: options.agentId,
    apiKey: options.apiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-parlant",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const environment = process.env.PARLANT_ENVIRONMENT;
  const parlantAgentId = process.env.PARLANT_AGENT_ID;

  if (!environment || !parlantAgentId) {
    throw new Error(
      "Set PARLANT_ENVIRONMENT and PARLANT_AGENT_ID to run this example.",
    );
  }

  const config = loadAgentConfig("parlant_agent");
  void createParlantAgent(
    {
      environment,
      agentId: parlantAgentId,
      apiKey: process.env.PARLANT_API_KEY,
    },
    config,
  ).run();
}


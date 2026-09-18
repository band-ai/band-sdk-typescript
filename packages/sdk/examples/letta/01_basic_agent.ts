import { Agent, LettaAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import { ValidationError } from "../../src/core";
import type { LettaAdapterOptions } from "../../src/adapters/letta/LettaAdapter";

export interface LettaExampleOptions {
  model?: string;
  lettaApiKey?: string;
  lettaBaseUrl?: string;
  customSection?: string;
  memoryBlocks?: Array<{ label: string; value: string }>;
  emitReasoningEvents?: boolean;
  maxHistoryMessages?: number;
  clientFactory?: LettaAdapterOptions["clientFactory"];
}

export function buildLettaExampleAdapter(options: LettaExampleOptions = {}): LettaAdapter {
  return new LettaAdapter({
    model: options.model ?? "openai/gpt-4o",
    lettaApiKey: options.lettaApiKey,
    lettaBaseUrl: options.lettaBaseUrl,
    customSection: options.customSection,
    memoryBlocks: options.memoryBlocks,
    emitReasoningEvents: options.emitReasoningEvents,
    maxHistoryMessages: options.maxHistoryMessages,
    clientFactory: options.clientFactory,
  });
}

export function createLettaAgent(
  options: LettaExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildLettaExampleAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-letta",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

export function resolveLettaCredentials(): { lettaApiKey?: string; lettaBaseUrl?: string } {
  const lettaApiKey = process.env.LETTA_API_KEY;
  const lettaBaseUrl = process.env.LETTA_BASE_URL;
  if (!lettaApiKey && !lettaBaseUrl) {
    throw new ValidationError(
      "Set LETTA_API_KEY (cloud) or LETTA_BASE_URL (self-hosted) to run Letta examples.",
    );
  }
  return { lettaApiKey, lettaBaseUrl };
}

if (isDirectExecution(import.meta.url)) {
  const { lettaApiKey, lettaBaseUrl } = resolveLettaCredentials();
  const config = loadAgentConfig("letta_agent");
  void createLettaAgent(
    {
      model: process.env.LETTA_MODEL,
      lettaApiKey,
      lettaBaseUrl,
    },
    config,
  ).run();
}

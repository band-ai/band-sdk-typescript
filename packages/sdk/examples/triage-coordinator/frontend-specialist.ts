/**
 * Frontend specialist — answers frontend / UI / React / CSS / browser
 * questions when the triage coordinator routes them in.
 *
 * The shape is intentionally identical to a "plain" tool-calling agent.
 * What makes this part of the triage demo is just two things:
 *   1. The Thenvoi agent's `description` (set on the platform side, not
 *      in code) tells the coordinator what this agent is for.
 *   2. The system prompt tells the agent to stay in scope and bow out
 *      politely if the question isn't actually frontend.
 *
 * Anything you wire up the same way — register on Thenvoi with a clear
 * description, give it a tight system prompt — is automatically
 * routable by the coordinator.
 */
import {
  Agent,
  OpenAIAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const FRONTEND_PROMPT = `You are a **Frontend Specialist**. You answer questions about:
- React / Next.js / Vue / Svelte / Angular / Solid
- TypeScript on the frontend
- CSS, layout, animations, design systems
- Browser APIs, performance, accessibility

If a question is *not* frontend (backend, data, infra, security,
product, hiring, etc.), say so politely in one sentence and tag the
human — don't try to answer outside your lane. The triage coordinator
will route them to a better specialist.

Always reply via \`thenvoi_send_message\` and tag the human who asked.`;

interface FrontendOptions {
  model?: string;
  apiKey?: string;
}

export function createFrontendAgent(
  options: FrontendOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new OpenAIAdapter({
    openAIModel: options.model ?? "gpt-5.5",
    apiKey: options.apiKey,
    systemPrompt: FRONTEND_PROMPT,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "frontend-specialist",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY to run the frontend specialist.");
  }
  const config = loadAgentConfig("frontend_specialist");
  console.log("[frontend] starting:", config.agentId);
  void createFrontendAgent({ apiKey }, config).run();
}

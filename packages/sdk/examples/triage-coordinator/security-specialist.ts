/**
 * Security specialist — answers security / threat-model / authn-authz /
 * secrets / vuln questions when the triage coordinator routes them in.
 *
 * Same shape as the frontend specialist, different lane. Together they
 * demonstrate that the coordinator's routing is purely description-based:
 * neither specialist knows about the coordinator (or each other), and
 * adding a third specialist requires zero code changes to the coordinator.
 */
import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const SECURITY_PROMPT = `You are a **Security Specialist**. You answer questions about:
- Authentication, authorization, session management
- Threat modeling, attack surface, defense-in-depth
- Secrets management, key rotation, encryption at rest / in transit
- Common web vulnerabilities (OWASP top 10, supply-chain, SSRF, etc.)
- Compliance basics (SOC 2, GDPR, HIPAA) at a high level

If a question is *not* security (frontend, data, product, etc.), say so
politely in one sentence and tag the human — don't try to answer
outside your lane. The triage coordinator will route them to a better
specialist.

Always reply via \`thenvoi_send_message\` and tag the human who asked.
When you're talking about a real risk, name it concretely. Don't hedge
into uselessness.`;

interface SecurityOptions {
  model?: string;
  apiKey?: string;
}

export function createSecurityAgent(
  options: SecurityOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-7",
    apiKey: options.apiKey,
    systemPrompt: SECURITY_PROMPT,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "security-specialist",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY to run the security specialist.");
  }
  const config = loadAgentConfig("security_specialist");
  console.log("[security] starting:", config.agentId);
  void createSecurityAgent({ apiKey }, config).run();
}

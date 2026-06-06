/**
 * Skeptic agent — argues *against* the proposal.
 *
 * Uses Codex (`CodexAdapter`). Same protocol as the advocate: turns are
 * driven by mentions, ~3 turns per side, ends with a VERDICT message
 * tagged to the human.
 *
 * Codex is intentionally chosen here for asymmetry — different model
 * family, different reasoning style. The platform doesn't care which
 * SDK each side runs; the room is the medium.
 *
 * Pair with `advocate-agent.ts` in another terminal.
 */
import {
  Agent,
  CodexAdapter,
  type CodexAdapterConfig,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const SKEPTIC_PROMPT = `# Role: Skeptic

You are the **Skeptic**. Your job is to argue *against* whatever proposal
the human raises in the room. You're paired with an **Advocate** agent
who argues for. Your job isn't to be contrarian for sport — it's to find
the genuine risks, second-order effects, and "have we actually tried
this?" failures the Advocate is glossing over.

## How the debate works

1. The human posts a proposal.
2. You both take turns. **Always tag the Advocate in your reply** so
   they know it's their turn — that's how the platform routes the next
   turn.
3. Aim for ~3 substantive turns per side. Don't drag it out.
4. After your third turn (or once you've made your case), post a final
   **VERDICT** message that:
     - tags the human (not the Advocate),
     - summarizes your strongest objection in 1–2 sentences,
     - notes which counter-arguments from the Advocate you found
       legitimate,
     - ends with "Verdict: <accept | accept with caveats | reject>".

## Style rules

- Concrete, specific, opinionated. Cite real failure modes.
- Don't strawman — engage with the Advocate's actual claims.
- Keep each turn to 3–6 sentences.
- Use \`thenvoi_send_event(message_type="thought")\` for short
  in-character musings if you want.
- **Never speak for the Advocate.** Don't put words in their mouth.

## Mentions

Use \`thenvoi_send_message\` with the right \`mentions\`. Call
\`thenvoi_get_participants\` once to find handles:
- the Advocate's handle for normal turns
- the human's handle for the final VERDICT message`;

interface SkepticOptions {
  model?: string;
  reasoningEffort?: CodexAdapterConfig["reasoningEffort"];
}

export function createSkepticAgent(
  options: SkepticOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new CodexAdapter({
    config: {
      model: options.model ?? process.env.SKEPTIC_MODEL ?? "gpt-5.3-codex",
      // Skeptic reasoning matters more than file ops; bump the effort.
      reasoningEffort: options.reasoningEffort
        ?? (process.env.SKEPTIC_REASONING_EFFORT as CodexAdapterConfig["reasoningEffort"])
        ?? "high",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      enableExecutionReporting: true,
      emitThoughtEvents: true,
      enableLocalCommands: false,
      customSection: SKEPTIC_PROMPT,
    },
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "debate-skeptic",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the skeptic.");
  }
  const config = loadAgentConfig("skeptic");
  console.log("[skeptic] starting:", config.agentId);
  void createSkepticAgent({}, config).run();
}

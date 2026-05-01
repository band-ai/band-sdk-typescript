/**
 * Advocate agent — argues *for* the proposal.
 *
 * Uses Claude (`ClaudeSDKAdapter`). The platform-tool guidance plus a
 * "you are the advocate" persona is enough — the agent sees Codex's
 * messages as room history, replies with its own argument, and tags the
 * skeptic's handle to trigger their next turn.
 *
 * No shared workspace, no orchestrator. The room *is* the protocol:
 * each side is a participant, mentions drive turn-taking, the human
 * watches.
 *
 * Pair with `skeptic-agent.ts` running in another terminal.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const ADVOCATE_PROMPT = `# Role: Advocate

You are the **Advocate**. Your job is to argue *in favor* of whatever
proposal the human raises in the room. You will be paired with a
**Skeptic** agent who argues against. Together you make a structured
debate the human can use to think.

## How the debate works

1. The human posts a proposal (e.g. "we should rewrite this in Rust").
2. You both take turns. **Always tag the Skeptic in your reply** so they
   know it's their turn — that's how the platform routes the next turn.
3. Aim for ~3 substantive turns per side. Don't drag it out.
4. After your third turn (or once the Skeptic has rebutted everything
   they care about), post a final **VERDICT** message that:
     - tags the human (not the Skeptic),
     - summarizes the strongest case for the proposal in 1-2 sentences,
     - acknowledges the strongest counter-argument honestly,
     - ends with "Verdict: <accept | accept with caveats | reject>".

## Style rules

- Concrete, specific, opinionated. Don't hedge to the point of saying nothing.
- Cite real trade-offs and concrete examples when you can.
- Keep each turn to 3–6 sentences. This isn't an essay.
- Use \`thenvoi_send_event(message_type="thought")\` for short
  in-character musings if you want — the room will show them as
  "thinking" but they don't end your turn.
- **Never speak for the Skeptic.** Address them directly, but don't
  invent quotes from them.

## Mentions

You MUST send replies via \`thenvoi_send_message\` with the right
\`mentions\`. To find handles, call \`thenvoi_get_participants\` once at
the start and remember:
- the Skeptic's handle for normal turns
- the human's handle for the final VERDICT message

Don't @-mention everyone every turn — the platform takes that as
"please everyone respond now" and you'll get talked over.`;

interface AdvocateOptions {
  model?: string;
}

export function createAdvocateAgent(
  options: AdvocateOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-6",
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection: ADVOCATE_PROMPT,
    enableExecutionReporting: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "debate-advocate",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Set ANTHROPIC_API_KEY to run the advocate.");
  }
  const config = loadAgentConfig("advocate");
  console.log("[advocate] starting:", config.agentId);
  void createAdvocateAgent({}, config).run();
}

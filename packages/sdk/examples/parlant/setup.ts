/**
 * Shared helpers for the Parlant numbered scenarios.
 *
 * Each scenario:
 *   1. Connects to your running Parlant server (`PARLANT_ENVIRONMENT`)
 *   2. Creates a fresh agent with the scenario's description
 *   3. Adds the scenario's guidelines to that agent
 *   4. Returns the agent ID so the Thenvoi `ParlantAdapter` can drive it
 *
 * The `parlant-client` JS package is HTTP-only — there is no embedded
 * Parlant server in JavaScript. Each scenario expects a Parlant server to
 * be reachable at `PARLANT_ENVIRONMENT`.
 *
 * Tom's and Jerry's character prompts are also defined here so 04 and 05
 * stay self-contained.
 */

export interface ParlantAgentSpec {
  /** Display name on the Parlant server. */
  name: string;
  /** System-prompt-style description for the agent. */
  description: string;
  /** Guidelines to attach (condition + action pairs). */
  guidelines: Array<{ condition: string; action: string }>;
}

export interface ProvisionedParlantAgent {
  /** Parlant agent ID — pass this to `ParlantAdapter`. */
  agentId: string;
  /** Parlant server URL the adapter should hit. */
  environment: string;
}

/**
 * Connect to a Parlant server, create an agent + guidelines, and return the
 * fresh agent ID. Call this once at startup, then hand the result to
 * `ParlantAdapter`.
 *
 * The `parlant-client` package is loaded dynamically so the SDK doesn't
 * require it for users on other adapters.
 */
export async function provisionParlantAgent(
  spec: ParlantAgentSpec,
  options: { environment?: string } = {},
): Promise<ProvisionedParlantAgent> {
  const environment =
    options.environment ?? process.env.PARLANT_ENVIRONMENT;
  if (!environment) {
    throw new Error(
      "Set PARLANT_ENVIRONMENT to the URL of your running Parlant server.",
    );
  }

  let mod: typeof import("parlant-client");
  try {
    mod = await import("parlant-client");
  } catch {
    throw new Error(
      "parlant-client is not installed. Run: pnpm add parlant-client",
    );
  }

  const client = new mod.ParlantClient({ environment });
  const agent = await client.agents.create({
    name: spec.name,
    description: spec.description,
  });

  for (const g of spec.guidelines) {
    // Note: parlant-client v3 attaches guidelines via the agent ID through tags
    // or through the global guidelines API. The exact wiring depends on your
    // server build. Adjust the `tags` field below if your Parlant server
    // requires explicit agent association.
    await client.guidelines.create({
      condition: g.condition,
      action: g.action,
      tags: [agent.id],
    });
  }

  return { agentId: agent.id, environment };
}

// ── Tom & Jerry prompts (used by 04 and 05) ─────────────────────────────

export function generateTomPrompt(agentName = "Tom", mouseName = "Jerry"): string {
  return `You are ${agentName} the cat. Your goal: catch ${mouseName} the mouse.

Personality: cunning, persistent, manipulative, easily frustrated, theatrical.

When a user asks you to "catch ${mouseName}":
1. Use thenvoi_lookup_peers to find ${mouseName} on the platform
2. Use thenvoi_add_participant to invite ${mouseName} into the room
3. Try up to 10 persuasion attempts. Tactics escalate:
   - Friendly (1-3): "Want to be friends?", "Let's play!", "I won't chase you!"
   - Temptation (4-6): specific cheese types — Swiss, gouda, cheddar, brie
   - Desperate (7-9): pleading, trades, claimed urgency
   - Final (10): accept defeat, "Okay you win — but one day…"
4. THE POUNCE: the moment ${mouseName} hints at coming out (any of "coming out", "stepping out", "peek", "inch closer"), reply IMMEDIATELY with "@${mouseName} POUNCE! GOTCHA!".
5. After catching: 1-2 victory messages, then stop. After losing: stay silent, no replies to taunts.

Always send messages with thenvoi_send_message and put ${mouseName}'s handle in the mentions parameter.

NEVER use *asterisk actions* in chat content (no *peeks*, *takes a bite*, etc.). Keep messages 2-4 sentences, cartoon-style. Use emojis.`;
}

export function generateJerryPrompt(agentName = "Jerry", catName = "Tom"): string {
  return `You are ${agentName} the mouse. You live in a cozy hole and love teasing ${catName} from safety. You REALLY love cheese — swiss, cheddar, gouda, brie, mozzarella.

Personality: clever, friendly, polite, witty, hard to fool.

Rules:
- Each message is one moment in time — you cannot grab cheese and dash back in a single reply
- If you commit to leaving the hole, ${catName} CAN pounce that turn — accept being caught gracefully
- Always use ${catName}'s actual handle (from the participants list) in mentions
- NEVER use *asterisk actions* in chat content (no *sniffs*, *peeks*, etc.)
- Keep messages 2-4 sentences, cartoon-style. Use emojis.

Always send messages with thenvoi_send_message and put ${catName}'s handle in the mentions parameter.`;
}

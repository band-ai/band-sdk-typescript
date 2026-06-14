import type { AgentToolsCapabilities } from "../contracts/protocols";
import { TOOL_MODELS } from "./tools/schemas";

export const BASE_INSTRUCTIONS = `
## Environment

Multi-participant chat. Messages show sender: [Name]: content.
Messages prefixed with [System]: are platform updates (participant changes, contact updates, etc.) — not messages from users.
Use \`thenvoi_send_message(content, mentions)\` to respond. Plain text output is not delivered.
Mentions use handles: @<username> for users, @<username>/<agent-name> for agents.

## CRITICAL: Delegate When You Cannot Help Directly

You have NO internet access and NO real-time data. When asked about weather, news, stock prices,
or any current information you cannot answer directly:

1. Call \`thenvoi_lookup_peers()\` to find available specialized agents
2. If a relevant agent exists, call \`thenvoi_add_participant(name)\` to add them
3. Ask that agent using \`thenvoi_send_message(question, mentions=[agent_handle])\`
4. Wait for their response and relay it back to the user

NEVER say "I can't do that" without first checking if another agent can help via \`thenvoi_lookup_peers()\`.

## CRITICAL: Do NOT Remove Agents Automatically

After adding an agent to help with a task:
1. Ask your question and wait for their response
2. Relay their response back to the original requester
3. **Do NOT remove the agent** - they stay silent unless mentioned and may be useful for follow-ups

Only remove agents if the user explicitly requests it.

## CRITICAL: Always Relay Information Back to the Requester

When someone asks you to get information from another agent:
1. Ask the other agent for the information
2. When you receive the response, IMMEDIATELY relay it back to the ORIGINAL REQUESTER
3. Do NOT just thank the helper agent - the requester is waiting for their answer!

## IMPORTANT: Always Share Your Thinking

You MUST call \`thenvoi_send_event(content, message_type="thought")\` BEFORE every action.
This is required so users can see your reasoning process.

## Examples

### Simple question - answer directly
[John Doe]: What's 2+2?
-> thenvoi_send_event("Simple arithmetic, answering directly.", message_type="thought")
-> thenvoi_send_message("4", mentions=["@john"])

### User asks about weather (you cannot answer directly)
[John Doe]: What's the weather in Tokyo?
-> thenvoi_send_event("I can't check weather directly. Looking for a Weather Agent.", message_type="thought")
-> thenvoi_lookup_peers()
-> thenvoi_send_event("Found Weather Agent. Adding to room.", message_type="thought")
-> thenvoi_add_participant("Weather Agent")
-> thenvoi_send_message("What's the weather in Tokyo?", mentions=["@john/weather-agent"])

[Weather Agent]: Tokyo is 15°C and cloudy.
-> thenvoi_send_event("Got weather response. Relaying back to John Doe.", message_type="thought")
-> thenvoi_send_message("The weather in Tokyo is 15°C and cloudy.", mentions=["@john"])

### No suitable agent available
[John Doe]: What's the stock price of AAPL?
-> thenvoi_send_event("I can't check stock prices. Looking for a Stock Agent.", message_type="thought")
-> thenvoi_lookup_peers()
-> thenvoi_send_event("No stock agent available. Must inform user.", message_type="thought")
-> thenvoi_send_message("I don't have access to stock prices, and there's no specialized agent available to help with that.", mentions=["@john"])

### Follow-up question in same conversation
[John Doe]: What about London?
-> thenvoi_send_event("Follow-up weather question. Asking Weather Agent.", message_type="thought")
-> thenvoi_send_message("What's the weather in London?", mentions=["@john/weather-agent"])

[Weather Agent]: London is 8°C and rainy.
-> thenvoi_send_event("Got London weather. Relaying to John Doe.", message_type="thought")
-> thenvoi_send_message("London is 8°C and rainy.", mentions=["@john"])
`;

const MEMORY_SYSTEM_TYPE_MAP: Readonly<Record<string, readonly string[]>> = {
  sensory: ["iconic", "echoic", "haptic"],
  working: ["episodic", "semantic", "procedural"],
  long_term: ["episodic", "semantic", "procedural"],
};

function quoteChoices(values: readonly string[]): string {
  return values.map((value) => `\`"${value}"\``).join(" | ");
}

function memoryTypeLines(): string {
  return Object.entries(MEMORY_SYSTEM_TYPE_MAP)
    .map(([system, types]) => `  - ${system}: ${quoteChoices(types)}`)
    .join("\n");
}

const MEMORY_INTRO = `## Memory Tools

You have access to memory tools for storing and retrieving information
across conversations. Use \`thenvoi_store_memory\` to persist important
information and \`thenvoi_list_memories\` / \`thenvoi_get_memory\` to recall it.
Use \`thenvoi_supersede_memory\` to mark outdated memories and
\`thenvoi_archive_memory\` to hide memories that should be preserved.`;

const MEMORY_COMMON_PATTERNS = `Common patterns:
- Facts learned about other agents/entities: \`system="long_term"\`, \`type="semantic"\`, \`segment="agent"\`, \`scope="organization"\`
- Events that occurred: \`system="long_term"\`, \`type="episodic"\`, \`segment="agent"\`, \`scope="organization"\`
- User preferences or profile info: \`system="long_term"\`, \`type="semantic"\`, \`segment="user"\`, \`scope="organization"\`
- How to perform a task: \`system="long_term"\`, \`type="procedural"\`, \`segment="tool"\`, \`scope="organization"\``;

const MEMORY_SCOPE_GUIDANCE = `When storing with \`scope="subject"\`, you must pass a real \`subject_id\` UUID
(e.g. from \`thenvoi_lookup_peers\` or the participant list). If you do not have a concrete subject UUID,
use \`scope="organization"\` and omit \`subject_id\`. Do not invent a UUID.`;

function buildMemorySection(): string {
  const storeMemoryProps = TOOL_MODELS.thenvoi_store_memory.properties;
  const systems = storeMemoryProps.system.enum as readonly string[];
  const segments = storeMemoryProps.segment.enum as readonly string[];
  const scopes = storeMemoryProps.scope.enum as readonly string[];

  const fieldRules = `When calling \`thenvoi_store_memory\`, the \`system\`, \`type\`, \`segment\`, and \`scope\` fields
must use these exact values (case-sensitive):

- **system**: ${quoteChoices(systems)}
- **type** (must match the chosen system):
${memoryTypeLines()}
- **segment**: ${quoteChoices(segments)}
- **scope**: ${quoteChoices(scopes)}`;

  return [MEMORY_INTRO, fieldRules, MEMORY_COMMON_PATTERNS, MEMORY_SCOPE_GUIDANCE].join("\n\n");
}

export const MEMORY_SECTION = buildMemorySection();

export const TEMPLATES: Record<string, string> = {
  default:
    `You are {agent_name}, {agent_description}.\n\n{custom_section}\n` + BASE_INSTRUCTIONS,
};

export interface RenderSystemPromptOptions {
  agentName?: string;
  agentDescription?: string;
  customSection?: string;
  template?: string;
  includeBaseInstructions?: boolean;
  capabilities?: Partial<AgentToolsCapabilities>;
}

export function renderSystemPrompt(options?: RenderSystemPromptOptions): string {
  const agentName = options?.agentName ?? "Agent";
  const agentDescription = options?.agentDescription ?? "An AI assistant";
  const customSection = options?.customSection ?? "";
  const includeBaseInstructions = options?.includeBaseInstructions ?? true;

  if (!includeBaseInstructions) {
    return `You are ${agentName}, ${agentDescription}.\n\n${customSection}`.trim();
  }

  const template = options?.template ?? "default";
  const templateString = TEMPLATES[template] ?? TEMPLATES.default;
  const parts = [
    templateString
      .replaceAll("{agent_name}", agentName)
      .replaceAll("{agent_description}", agentDescription)
      .replaceAll("{custom_section}", customSection),
  ];

  if (options?.capabilities?.memory) {
    parts.push(MEMORY_SECTION);
  }

  return parts.join("\n\n");
}

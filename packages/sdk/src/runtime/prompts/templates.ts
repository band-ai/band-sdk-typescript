import type { AgentToolsCapabilities } from "../../contracts/protocols";
import { BASE_INSTRUCTIONS } from "./base";
import { MEMORY_SECTION } from "./memory";

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

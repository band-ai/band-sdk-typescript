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

/**
 * `prompt` plus the memory guidance, when the memory tools are exposed. Every
 * prompt an adapter sends needs it, including a caller's own raw one: without
 * it the model gets the tools but not the scope and subject rules.
 */
export function withMemoryGuidance(prompt: string, memory?: boolean): string {
  return memory ? [prompt, MEMORY_SECTION].join("\n\n") : prompt;
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
  const rendered = templateString
    .replaceAll("{agent_name}", agentName)
    .replaceAll("{agent_description}", agentDescription)
    .replaceAll("{custom_section}", customSection);

  return withMemoryGuidance(rendered, options?.capabilities?.memory);
}

/**
 * 06 — Anthropic agent with custom tools.
 *
 * Adds two `CustomToolDef`s — a calculator and a (mock) weather tool —
 * alongside the platform tools. Claude's tool-calling loop sees them as
 * tool definitions; the adapter dispatches the call to your handler and
 * feeds the result back to the model.
 *
 * Custom tools are how you wire your own APIs / business logic into a
 * Thenvoi agent: write a Zod schema for the inputs, a handler function
 * for the implementation, and pass them via `customTools`.
 */
import { z } from "zod";

import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import type { CustomToolDef } from "@thenvoi/sdk/runtime";

const calculatorTool: CustomToolDef = {
  name: "calculator",
  description: "Perform a mathematical calculation safely.",
  schema: z.object({
    operation: z
      .enum(["add", "subtract", "multiply", "divide"])
      .describe("Math operation"),
    left: z.number().describe("First number"),
    right: z.number().describe("Second number"),
  }),
  handler: ({ operation, left, right }: Record<string, unknown>) => {
    const a = Number(left);
    const b = Number(right);
    switch (operation) {
      case "add": return `${a + b}`;
      case "subtract": return `${a - b}`;
      case "multiply": return `${a * b}`;
      case "divide": return b === 0 ? "Error: division by zero" : `${a / b}`;
      default: return `Unknown operation: ${String(operation)}`;
    }
  },
};

const weatherTool: CustomToolDef = {
  name: "get_weather",
  description: "Get current weather for a city (mock implementation).",
  schema: z.object({
    city: z.string().describe("Name of the city"),
  }),
  handler: ({ city }: Record<string, unknown>) =>
    `Weather in ${String(city)}: Sunny, 22 °C`,
};

interface ToolsAgentOptions {
  model?: string;
  apiKey?: string;
}

export function createToolsAgent(
  options: ToolsAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-6",
    apiKey: options.apiKey,
    customTools: [calculatorTool, weatherTool],
    enableExecutionReporting: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "anthropic-tools-agent",
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
    throw new Error("Set ANTHROPIC_API_KEY to run this example.");
  }
  const config = loadAgentConfig("anthropic_tools_agent");
  void createToolsAgent({ apiKey }, config).run();
}

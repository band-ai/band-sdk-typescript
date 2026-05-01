/**
 * 03 — Google ADK with custom tools.
 *
 * Adds a calculator and a (mock) weather tool alongside the platform
 * tools. The adapter registers each `CustomToolDef` as an ADK function
 * tool — the ADK Runner picks whichever fits the user's question.
 *
 * Custom tools are how you wire your own APIs / business logic into the
 * agent: write a Zod schema for the inputs, a handler function for the
 * implementation, and pass them via `additionalTools`.
 */
import { z } from "zod";

import {
  Agent,
  GoogleADKAdapter,
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
  handler: ({ city }: Record<string, unknown>) => `Weather in ${String(city)}: Sunny, 22 °C`,
};

interface ToolsAgentOptions {
  model?: string;
}

export function createToolsAgent(
  options: ToolsAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new GoogleADKAdapter({
    model: options.model ?? "gemini-3-flash",
    customSection: [
      "You are a helpful assistant with access to platform tools, a calculator, and a weather tool.",
      "When users ask math questions, use the calculator.",
      "When users ask about weather, use get_weather.",
      "Always reply with thenvoi_send_message.",
    ].join("\n"),
    additionalTools: [calculatorTool, weatherTool],
    enableExecutionReporting: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "google-adk-tools-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set GOOGLE_API_KEY or GOOGLE_GENAI_API_KEY to run this example.");
  }
  const config = loadAgentConfig("google_adk_agent");
  void createToolsAgent({}, config).run();
}

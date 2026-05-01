/**
 * 02 — Custom tools.
 *
 * Adds a calculator and a (mock) weather tool alongside the platform tools.
 * The LLM picks whichever tool fits the user's question; the adapter handles
 * platform-side actions.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/02-custom-tools.ts
 */
import { z } from "zod";

import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  loadChatOpenAI,
  loadMemorySaver,
  loadToolHelper,
} from "./prompts";

async function buildCustomTools(): Promise<unknown[]> {
  const tool = await loadToolHelper();

  const calculate = tool(
    async (input: Record<string, unknown>) => {
      const operation = String(input.operation);
      const left = Number(input.left);
      const right = Number(input.right);
      switch (operation) {
        case "add": return `Result: ${left + right}`;
        case "subtract": return `Result: ${left - right}`;
        case "multiply": return `Result: ${left * right}`;
        case "divide":
          if (right === 0) return "Error: Cannot divide by zero";
          return `Result: ${left / right}`;
        case "power": return `Result: ${left ** right}`;
        default:
          return `Error: Unknown operation '${operation}'. Use: add, subtract, multiply, divide, or power`;
      }
    },
    {
      name: "calculate",
      description: "Perform a mathematical calculation safely.",
      schema: z.object({
        operation: z
          .enum(["add", "subtract", "multiply", "divide", "power"])
          .describe("The operation to perform"),
        left: z.number().describe("The first number"),
        right: z.number().describe("The second number"),
      }),
    },
  );

  const getWeather = tool(
    async (input: Record<string, unknown>) => {
      const city = String(input.city);
      // Mock — wire up a real provider in your fork.
      return `Weather in ${city}: Sunny, 72°F`;
    },
    {
      name: "get_weather",
      description: "Get weather for a city (mock implementation).",
      schema: z.object({ city: z.string().describe("Name of the city") }),
    },
  );

  return [calculate, getWeather];
}

export async function createCustomToolsAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-5.5");
  const checkpointer = await loadMemorySaver();
  const additionalTools = await buildCustomTools();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    additionalTools,
    customSection: `You are a helpful assistant with access to:
- Platform tools (thenvoi_send_message, thenvoi_add_participant, etc.)
- Calculator tool for math
- Weather tool for weather info

When users ask math questions, use the calculator.
When users ask about weather, use get_weather.
Always send your response using thenvoi_send_message.`,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "custom-tools-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run this example.");
  }
  const config = loadAgentConfig("custom_tools_agent");
  void createCustomToolsAgent({}, config).then((agent) => agent.run());
}

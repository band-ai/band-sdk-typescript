/**
 * 04 — Calculator subgraph as a tool.
 *
 * Builds a standalone LangGraph (`createCalculatorGraph`) that knows nothing
 * about Thenvoi, then wraps it as a LangChain tool and hands it to the
 * Thenvoi agent. The agent decides when to delegate math to the subgraph.
 *
 * The standalone graph is kept inline so the example stays self-contained
 * per the standalone-folder rule.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/04-calculator-as-tool.ts
 */
import { z } from "zod";

import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  loadChatOpenAI,
  loadMemorySaver,
  loadToolHelper,
} from "./prompts";

interface CalcInput {
  operation: "add" | "subtract" | "multiply" | "divide";
  a: number;
  b: number;
}

interface CalcOutput {
  result: number;
  error: string | null;
}

/**
 * Standalone calculator graph — no Thenvoi imports.
 *
 * Compiles a one-node LangGraph that takes {operation, a, b} and returns
 * {result, error}. Designed to be importable by any LangChain/LangGraph
 * agent, not just this example.
 */
async function createCalculatorGraph(): Promise<{
  invoke: (input: CalcInput) => Promise<CalcOutput>;
}> {
  const lg = await import("@langchain/langgraph");
  const { Annotation, StateGraph, START, END, MemorySaver } = lg;

  const State = Annotation.Root({
    operation: Annotation<CalcInput["operation"]>(),
    a: Annotation<number>(),
    b: Annotation<number>(),
    result: Annotation<number>(),
    error: Annotation<string | null>(),
  });

  const calculate = (state: typeof State.State): Partial<typeof State.State> => {
    const { operation, a, b } = state;
    let result: number;
    switch (operation) {
      case "add": result = a + b; break;
      case "subtract": result = a - b; break;
      case "multiply": result = a * b; break;
      case "divide":
        if (b === 0) throw new Error("Cannot divide by zero");
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation: ${String(operation)}`);
    }
    return { result, error: null };
  };

  const compiled = new StateGraph(State)
    .addNode("calculate", calculate)
    .addEdge(START, "calculate")
    .addEdge("calculate", END)
    .compile({ checkpointer: new MemorySaver() });

  return {
    invoke: async (input: CalcInput) => {
      const out = (await compiled.invoke(input, {
        configurable: { thread_id: `calc-${Date.now()}-${Math.random()}` },
      })) as CalcOutput;
      return out;
    },
  };
}

async function buildCalculatorTool(): Promise<unknown> {
  const tool = await loadToolHelper();
  const calc = await createCalculatorGraph();

  return tool(
    async (input: Record<string, unknown>) => {
      const out = await calc.invoke({
        operation: input.operation as CalcInput["operation"],
        a: Number(input.a),
        b: Number(input.b),
      });
      return `Calculation result: ${out.result}`;
    },
    {
      name: "calculator",
      description:
        "Use this tool to perform mathematical calculations. It can add, subtract, multiply, and divide numbers.",
      schema: z.object({
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      }),
    },
  );
}

export async function createCalculatorAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-4o");
  const checkpointer = await loadMemorySaver();
  const calculatorTool = await buildCalculatorTool();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    additionalTools: [calculatorTool],
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "calculator-agent",
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
  const config = loadAgentConfig("calculator_agent");
  void createCalculatorAgent({}, config).then((agent) => agent.run());
}

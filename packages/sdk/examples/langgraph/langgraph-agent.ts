import { Agent, LangGraphAdapter, type LangGraphGraph, loadAgentConfig, isDirectExecution } from "../../src/index";

export class EchoLangGraph implements LangGraphGraph {
  public async invoke(input: Record<string, unknown>): Promise<unknown> {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const latest = messages[messages.length - 1];
    if (Array.isArray(latest) && latest[0] === "user") {
      return {
        messages: [["assistant", `Echo from LangGraph: ${String(latest[1] ?? "")}`]],
      };
    }

    return {
      messages: [["assistant", "Echo from LangGraph"]],
    };
  }
}

export function createLangGraphAgent(
  options?: { graph?: LangGraphGraph },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new LangGraphAdapter({
    graph: options?.graph ?? new EchoLangGraph(),
    customSection: "Use Thenvoi tools for side effects and final replies.",
    emitExecutionEvents: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-langgraph",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("langgraph_agent");
  void createLangGraphAgent(undefined, config).run();
}

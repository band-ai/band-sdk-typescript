/**
 * 06 — SQL agent subgraph.
 *
 * Demonstrates the *pattern* of delegating database queries to a SQL subagent
 * with its own LLM and tools, and exposing it as a single tool to the main
 * Thenvoi agent.
 *
 * Shipping a full SQLite-backed example would force every reader to install
 * SQL tooling. The TS port stubs `createSqlSubagent` so the scenario stays
 * runnable without that stack — replace the stub with a real database-backed
 * agent (e.g. `langchain/community` SQL toolkit, your own retriever, an MCP
 * database tool) and the rest of the wiring stays the same.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/06-delegate-to-sql-agent.ts
 */
import { z } from "zod";

import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  loadChatOpenAI,
  loadMemorySaver,
  loadToolHelper,
} from "./prompts";

interface SqlInput {
  question: string;
}

interface SqlOutput {
  answer: string;
}

/**
 * Stub SQL subagent.
 *
 * Replace with a graph that uses a real LLM + SQL tools to list tables,
 * inspect schemas, generate queries, and execute them.
 */
async function createSqlSubagent(): Promise<{
  invoke: (input: SqlInput) => Promise<SqlOutput>;
}> {
  return {
    invoke: async ({ question }) => ({
      answer:
        "[stub SQL] Replace examples/langgraph/06-delegate-to-sql-agent.ts#createSqlSubagent " +
        `with a real database-backed agent to answer: "${question}"`,
    }),
  };
}

async function buildSqlTool(): Promise<unknown> {
  const tool = await loadToolHelper();
  const sql = await createSqlSubagent();

  return tool(
    async (input: Record<string, unknown>) => {
      const out = await sql.invoke({ question: String(input.question) });
      return out.answer;
    },
    {
      name: "database_assistant",
      description:
        "Use this tool to query the database and answer questions about data. It can list tables, examine schemas, and run SQL queries safely.",
      schema: z.object({
        question: z.string().describe("Natural-language question about the database"),
      }),
    },
  );
}

export async function createSqlAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-5.5");
  const checkpointer = await loadMemorySaver();
  const sqlTool = await buildSqlTool();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    additionalTools: [sqlTool],
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "sql-agent",
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
  const config = loadAgentConfig("sql_agent");
  void createSqlAgent({}, config).then((agent) => agent.run());
}

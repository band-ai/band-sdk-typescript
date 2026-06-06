/**
 * 05 — RAG subgraph as a tool.
 *
 * Demonstrates the *pattern* of wrapping an Agentic-RAG LangGraph subgraph
 * as a tool the main Thenvoi agent can call.
 *
 * Replicating a full retrieval stack (vector store, document loader,
 * grading/rewriting graph) in this example would force every reader to
 * install heavy deps. The TS port instead uses a stub `createRagGraph` so
 * the scenario is runnable end-to-end without that stack — swap the stub
 * for your own indexer + retriever to make it real.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/05-rag-as-tool.ts
 */
import { z } from "zod";

import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  loadChatOpenAI,
  loadMemorySaver,
  loadToolHelper,
} from "./prompts";

interface RagInput {
  question: string;
}

interface RagOutput {
  answer: string;
}

/**
 * Stub Agentic-RAG graph.
 *
 * Replace `answer` with a real retrieval + grading + generation pipeline
 * (e.g. LangGraph state machine over a Chroma/Pinecone/PG-vector store).
 * The integration with the main Thenvoi agent stays identical regardless
 * of how the answer is produced.
 */
async function createRagGraph(): Promise<{
  invoke: (input: RagInput) => Promise<RagOutput>;
}> {
  return {
    invoke: async ({ question }) => ({
      answer:
        "[stub RAG] Replace examples/langgraph/05-rag-as-tool.ts#createRagGraph " +
        `with a real retrieval pipeline to answer: "${question}"`,
    }),
  };
}

async function buildRagTool(): Promise<unknown> {
  const tool = await loadToolHelper();
  const rag = await createRagGraph();

  return tool(
    async (input: Record<string, unknown>) => {
      const out = await rag.invoke({ question: String(input.question) });
      return out.answer;
    },
    {
      name: "research_ai_topics",
      description:
        "Use this tool to research AI topics like reward hacking, hallucination, and diffusion models. Pass the user's question; the tool decides when to retrieve and rewrites questions for better results.",
      schema: z.object({
        question: z.string().describe("The research question to answer"),
      }),
    },
  );
}

const RAG_INSTRUCTIONS = `

## RAG Research Tool

You have access to \`research_ai_topics\` for AI research questions
(reward hacking, hallucination, diffusion models, video generation).

### When to Use RAG Tool
- Technical AI questions that need factual information
- When the user explicitly asks to research or look up something

### How to Use It
1. Call \`research_ai_topics\` with the question
2. Take the answer the tool returns
3. Send it to the chat with \`thenvoi_send_message\`

### "Tell X about Y" Pattern
1. \`thenvoi_get_participants()\` → find the recipient
2. \`research_ai_topics(question="…")\` → get the answer
3. \`thenvoi_send_message\` with the recipient in \`mentions\` and the answer in \`content\`
`;

export async function createRagAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-5.5");
  const checkpointer = await loadMemorySaver();
  const ragTool = await buildRagTool();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    additionalTools: [ragTool],
    customSection: RAG_INSTRUCTIONS,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "rag-agent",
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
  const config = loadAgentConfig("rag_agent");
  void createRagAgent({}, config).then((agent) => agent.run());
}

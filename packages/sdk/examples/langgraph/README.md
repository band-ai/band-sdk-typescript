# LangGraph examples

Eight scenarios showing the `LangGraphAdapter` from the simplest possible setup to multi-agent character roleplay. Each scenario is a single `.ts` file that can be copy-pasted into a new project — they import from `@thenvoi/sdk` and a small shared `prompts.ts` (also in this folder).

## Scenarios

| File | Description |
|------|-------------|
| `01-simple-agent.ts` | Smallest possible LangGraph agent: just an LLM + checkpointer |
| `02-custom-tools.ts` | Adds a calculator and a (mock) weather tool alongside platform tools |
| `03-custom-personality.ts` | Pirate persona via `customSection` |
| `04-calculator-as-tool.ts` | Wraps a standalone LangGraph subgraph as a tool |
| `05-rag-as-tool.ts` | Pattern for delegating retrieval-augmented Q&A to a subgraph (stub graph included) |
| `06-delegate-to-sql-agent.ts` | Pattern for hierarchical agents with a SQL subagent (stub graph included) |
| `07-tom-agent.ts` | Tom the cat — character agent that pursues Jerry |
| `08-jerry-agent.ts` | Jerry the mouse — counterpart to Tom |

The original `langgraph-agent.ts` (an in-memory `EchoLangGraph` with no LLM) stays alongside as a tiny zero-dependency smoke target; the new scenarios are the realistic ones.

## Prerequisites

- Node 20+, pnpm.
- Provider package(s):
  ```bash
  pnpm add @langchain/openai            # required for 01–08 (default model is gpt-5.5)
  pnpm add @langchain/anthropic         # only if you want to use Claude models
  ```
  `@langchain/langgraph` is already a dependency of this SDK.
- Thenvoi credentials per scenario, in `agent_config.yaml`.
- `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` if you're using Claude models).

Config keys per scenario:

| Scenario | Config key |
|----------|-----------|
| 01 | `simple_agent` |
| 02 | `custom_tools_agent` |
| 03 | `custom_personality_agent` |
| 04 | `calculator_agent` |
| 05 | `rag_agent` |
| 06 | `sql_agent` |
| 07 | `tom_agent` |
| 08 | `jerry_agent` |

## Running

```bash
pnpm --dir packages/sdk exec tsx examples/langgraph/01-simple-agent.ts
# …same shape for the other 7.
```

Each script fails fast with a clear error if `OPENAI_API_KEY` or Thenvoi credentials are missing.

## Notes on 05 (RAG) and 06 (SQL)

A full retrieval pipeline (vector store + document loader + grading/rewriting graph) and a full SQL toolkit (driver + schema introspection + query execution) are both heavy dependencies that vary a lot by deployment target. Both scenarios here ship with a **stub subgraph** that demonstrates the wrapping pattern verbatim — replace `createRagGraph` / `createSqlSubagent` with a real implementation (LangChain `Chroma`, your own retriever, the LangChain SQL toolkit, an MCP database tool, etc.) and the rest of the wiring is unchanged.

## Tom and Jerry (07 + 08)

Run both agents (in two terminals), then in a Thenvoi room with both agents and a human, message Tom: `@Tom catch Jerry!`. Tom looks up Jerry, invites him into the room, and runs up to 10 persuasion attempts. The instant Jerry's reply hints at coming out, Tom pounces.

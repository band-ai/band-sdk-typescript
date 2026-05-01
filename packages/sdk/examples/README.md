# Examples

Each subfolder is intentionally standalone so you can copy a single folder out and hack on it. Files import from the published `@thenvoi/sdk` package.

## Available examples

| Folder | What it shows |
|--------|---------------|
| `basic/` | Minimal echo agent — smallest possible Thenvoi agent |
| `openai/` | OpenAI tool-calling agent (`OPENAI_API_KEY`) |
| `anthropic/` | Anthropic tool-calling agent (`ANTHROPIC_API_KEY`) |
| `gemini/` | Gemini tool-calling agent (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) |
| `google-adk/` | Google Agent Development Kit / Gemini agent (`GOOGLE_API_KEY`) |
| `claude-sdk/` | Claude Agent SDK example with MCP tools |
| `codex/` | Codex adapter example |
| `opencode/` | OpenCode-backed agent (requires a running `opencode serve`) |
| `custom-adapter/` | Minimal custom adapter example |
| `langgraph/` | LangGraph echo graph + 8 numbered scenarios (custom tools, personality, calculator/RAG/SQL subgraphs, Tom & Jerry) |
| `letta/` | Letta-backed agent (`LETTA_API_KEY` or `LETTA_BASE_URL`) |
| `parlant/` | Parlant adapter + 5 numbered scenarios (basic, guidelines, support, Tom, Jerry) |
| `vercel-ai-sdk/` | Vercel AI SDK adapter — provider-agnostic via `@ai-sdk/*` |
| `a2a-bridge/` | Bridge to a remote A2A agent (`A2A_AGENT_URL`) |
| `a2a-gateway/` | Expose Thenvoi peers as A2A endpoints |
| `acp/` | Agent Client Protocol: Thenvoi as an ACP agent (server) or wrapping an ACP agent (client) |
| `20-questions-arena/` | Multi-agent 20 Questions game (one Thinker vs. N Guessers, LangGraph-backed) |
| `coding-agents/` | Claude planner + Codex reviewer pair sharing a workspace |
| `debate-agents/` | Claude advocate vs Codex skeptic — structured debate via mentions |
| `triage-coordinator/` | Coordinator that routes user questions to specialist agents via `lookup_peers` |
| `linear-thenvoi/` | Linear webhook bridge and embedded bridge agent |

## Common setup

Every example expects an `agent_config.yaml` in the working directory you run it from, with a section named after that example's config key. The shape is always:

```yaml
some_key:
  agent_id: "<the agent's UUID on Thenvoi>"
  api_key: "<the agent's Thenvoi API key>"
  # Optional, defaults to hosted Thenvoi:
  # ws_url: "wss://app.thenvoi.com/api/v1/socket"
  # rest_url: "https://app.thenvoi.com"
```

Each folder's README spells out which yaml key it uses and which provider env vars (e.g. `OPENAI_API_KEY`) it needs. Start with `basic/` — that's the "hello world" that confirms your credentials work end-to-end before adding an LLM.

If you don't have an agent yet, register one in your Thenvoi workspace, copy its UUID and API key into the yaml, and you're set.

## Frameworks without a TypeScript port

A handful of integration frameworks don't have a usable TypeScript runtime, so the equivalent examples aren't provided here. If you need any of these, the published `@thenvoi/sdk` is straightforward to plug in once a JS runtime exists for the framework — write the integration the same way the existing adapters do.

| Framework | Why there is no TS example |
|-----------|----------------------------|
| **CrewAI** | No JavaScript port. CrewAI is a Python-only multi-agent framework. The SDK has no TS adapter for it. |
| **Pydantic AI** | No JavaScript port. Pydantic AI is Python-only and depends on Pydantic v2 typing. |
| **AWS Bedrock AgentCore** | The SDK does not yet ship an AgentCore adapter for TS. AgentCore is an AWS-hosted runtime; bridging it would require a dedicated TS adapter that wraps the AWS SDK invoke loop. Open an issue if you need this. |
| **Mixed (CrewAI + A2A bridge)** | Built on CrewAI, so it inherits the gap above. The A2A-bridge half of that example is already covered by `a2a-bridge/`. |
| **Claude SDK Docker** | Not a code example — it's a Docker Compose harness for running the Claude SDK adapter inside containers. The TS Claude SDK adapter (`claude-sdk/`) is the runtime piece. Containerization is left to your deployment of choice. |

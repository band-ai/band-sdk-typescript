# Examples

Each subfolder is intentionally standalone so you can copy a single folder out and hack on it.

Folders:

- `basic/`
- `openai/` — includes `openai-memory-agent.ts` for ToolCalling memory tools (`includeMemoryTools: true`)
- `anthropic/`
- `gemini/`
- `claude-sdk/`
- `codex/`
- `custom-adapter/`
- `langgraph/`
- `parlant/`
- `a2a-bridge/`
- `a2a-gateway/`
- `linear-thenvoi/`
- `dog-landing-page/`

## OpenAI memory example

`openai/openai-memory-agent.ts` runs an OpenAI agent with Thenvoi memory tools enabled.

Setup:

1. Copy `agent_config.yaml.example` to `agent_config.yaml` and configure `openai_memory_agent` (include `ws_url` / `rest_url` for non-production platforms).
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`, `THENVOI_API_KEY_USER`, and platform URLs.

Run:

```bash
cd packages/sdk
pnpm example:openai-memory
```

Then mention the agent in a Thenvoi chat and ask it to remember a durable preference.

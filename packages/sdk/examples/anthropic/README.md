# `anthropic/` — Anthropic (Claude) tool-calling agent

A Thenvoi agent backed by Anthropic's Messages API. Thenvoi platform tools become Claude tool definitions; the model picks one per turn and the adapter executes it. Identical shape to the `openai/` and `gemini/` examples — only the adapter and key change.

## What it shows

- Wiring `AnthropicAdapter` into `Agent.create`
- Driving Thenvoi platform actions through Claude's tool-use loop
- Failing fast on missing `ANTHROPIC_API_KEY`

## Files

| File | What it does |
|------|--------------|
| `anthropic-agent.ts` | Adapter + agent + CLI runner. ~50 lines. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `ANTHROPIC_API_KEY` env var
- `agent_config.yaml` in the working directory:

```yaml
anthropic_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --dir packages/sdk exec tsx examples/anthropic/anthropic-agent.ts
```

Default model is `claude-sonnet-4-6`. Override by editing `anthropicModel` in the file.

## What "working" looks like

1. Process starts, no errors.
2. From a Thenvoi room the agent is in, ask: `Summarize the last three messages in this room.`
3. The agent calls `thenvoi_get_participants` (or relies on history) and replies in chat with a summary.

## Common errors

| Error | Cause |
|-------|-------|
| `Set ANTHROPIC_API_KEY to run this example.` | Env var not set |
| `Anthropic 401 invalid_api_key` | Bad or revoked key |
| `Anthropic 429 rate_limit_error` | Past your tier's per-minute or daily limit |
| Agent connects but never replies | Agent isn't a participant in the room |

## Customizing

```ts
new AnthropicAdapter({
  anthropicModel: "claude-opus-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  customSection: "Always reply in bullet points.",
  maxHistoryMessages: 50,
});
```

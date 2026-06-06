# `gemini/` — Google Gemini tool-calling agent

A Thenvoi agent backed by Google's Gemini API. Thenvoi platform tools become Gemini function declarations; the model picks one per turn and the adapter executes it. Same shape as `openai/` and `anthropic/`.

## What it shows

- Wiring `GeminiAdapter` into `Agent.create`
- Driving Thenvoi platform actions through Gemini's tool-calling loop
- Failing fast on missing API key

## Files

| File | What it does |
|------|--------------|
| `gemini-agent.ts` | Plain Gemini agent — minimal, ~50 lines |
| `02-custom-tools.ts` | Calculator + weather tools wired in via `customTools` |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` env var (either name works)
- `agent_config.yaml` in the working directory:

```yaml
gemini_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export GEMINI_API_KEY=...
pnpm --dir packages/sdk exec tsx examples/gemini/gemini-agent.ts
```

Default model is `gemini-3-flash-preview`. Override by editing `geminiModel` in the file.

## What "working" looks like

1. Process starts, no errors.
2. From a Thenvoi room the agent is in, ask: `What's a haiku about debugging?`.
3. The agent calls `thenvoi_send_message` and posts the haiku to chat.

## Common errors

| Error | Cause |
|-------|-------|
| `Set GEMINI_API_KEY or GOOGLE_API_KEY to run this example.` | Neither env var is set |
| `Gemini 400 INVALID_ARGUMENT` | Model name is wrong, or the key doesn't have access to that model |
| `Gemini 429 RESOURCE_EXHAUSTED` | Past quota |
| Agent connects but never replies | Agent isn't a participant in the room |

## Note on `google-adk/`

If you want the Google **Agent Development Kit** (Runner + tools as ADK function tools, not the bare Gemini API), see `examples/google-adk/`. That's a higher-level path; this folder is the direct-API shape.

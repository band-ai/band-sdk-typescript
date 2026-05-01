# `anthropic/` — Anthropic (Claude) tool-calling agent

A Thenvoi agent backed by Anthropic's Messages API. Thenvoi platform tools become Claude tool definitions; the model picks one per turn and the adapter executes it. Identical shape to the `openai/` and `gemini/` examples — only the adapter and key change.

## What it shows

- Wiring `AnthropicAdapter` into `Agent.create`
- Driving Thenvoi platform actions through Claude's tool-use loop
- Failing fast on missing `ANTHROPIC_API_KEY`

## Files

| File | What it does |
|------|--------------|
| `anthropic-agent.ts` | Plain Anthropic agent — minimal, ~50 lines |
| `02-custom-instructions.ts` | Specialized "support agent" persona via `systemPrompt` |
| `03-tom-agent.ts` | Tom the cat — character agent that pursues Jerry |
| `04-jerry-agent.ts` | Jerry the mouse — counterpart to Tom |
| `05-contact-management.ts` | Auto-approve incoming contact requests via `ContactEventConfig` callback |
| `06-custom-tools.ts` | Calculator + weather tools wired in via `customTools` |
| `characters.ts` | Tom + Jerry character prompts (used by 03 and 04) |

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

Default model is `claude-sonnet-4-7`. Override by editing `anthropicModel` in the file.

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

The example uses defaults for everything but model + key. Common knobs:

```ts
new AnthropicAdapter({
  anthropicModel: "claude-opus-4-7",
  apiKey: process.env.ANTHROPIC_API_KEY,
  systemPrompt: "Always reply in bullet points.",
});
```

## Yaml entries used by the numbered scenarios

```yaml
anthropic_agent:    # 01-anthropic-agent.ts (the plain runner) and 05
  agent_id: ...
  api_key: ...
support_agent:      # 02-custom-instructions.ts
  agent_id: ...
  api_key: ...
tom_agent:          # 03-tom-agent.ts
  agent_id: ...
  api_key: ...
jerry_agent:        # 04-jerry-agent.ts
  agent_id: ...
  api_key: ...
anthropic_tools_agent: # 06-custom-tools.ts
  agent_id: ...
  api_key: ...
```

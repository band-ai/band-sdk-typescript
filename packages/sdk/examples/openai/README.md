# `openai/` — OpenAI tool-calling agent

A Thenvoi agent backed by OpenAI's chat-completions API. The model receives Thenvoi platform tools (send messages, look up peers, manage participants, create rooms) as OpenAI function definitions, picks one, and the adapter executes it. Conversation history per room is automatic.

## What it shows

- Wiring `OpenAIAdapter` into `Agent.create`
- How a tool-calling LLM drives platform actions instead of you implementing them by hand
- Failing fast on missing `OPENAI_API_KEY` rather than at first turn

## Files

| File | What it does |
|------|--------------|
| `openai-agent.ts` | Plain OpenAI agent — minimal, ~50 lines |
| `02-custom-tools.ts` | Calculator + weather tools wired in via `customTools` |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- An `OPENAI_API_KEY` env var with a valid key
- `agent_config.yaml` in the working directory:

```yaml
openai_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export OPENAI_API_KEY=sk-...
pnpm --dir packages/sdk exec tsx examples/openai/openai-agent.ts
```

Override the model with the `OPENAI_MODEL` argument inside `createOpenAIAgent({ model: "gpt-5.4-mini" })` or by editing `openAIModel` in the file. The default is `gpt-5.5`.

## What "working" looks like

1. Process starts, no errors logged.
2. From a Thenvoi room the agent is in, ask it something: `What's 17 * 23?`.
3. The agent replies with the answer, calling `thenvoi_send_message` under the hood. Tool calls are visible in the process logs.
4. Try `Who else is in this room?` — the agent calls `thenvoi_get_participants` and replies with the list.

## Common errors

| Error | Cause |
|-------|-------|
| `Set OPENAI_API_KEY to run this example.` | The env var isn't exported in your shell |
| `OpenAI 401 invalid_api_key` | Bad or revoked key |
| `OpenAI 429 rate_limit_exceeded` | You're past the per-minute or per-day quota; back off or upgrade |
| Agent connects but never replies | The agent isn't a participant in the room you're messaging from. Add it on the platform first. |

## Customizing

The example uses defaults for everything but model + key. The full set of `OpenAIAdapter` options is documented in `@thenvoi/sdk`'s adapter docs — common ones:

```ts
new OpenAIAdapter({
  openAIModel: "gpt-5.5",
  apiKey: process.env.OPENAI_API_KEY,
  systemPrompt: "Be terse. Always greet the user by name.",
  customTools: [...],     // see 02-custom-tools.ts
});
```

## Yaml entries

```yaml
openai_agent:        # 01-openai-agent.ts
  agent_id: ...
  api_key: ...
openai_tools_agent:  # 02-custom-tools.ts
  agent_id: ...
  api_key: ...
```

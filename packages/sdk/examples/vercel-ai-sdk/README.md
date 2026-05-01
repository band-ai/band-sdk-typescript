# `vercel-ai-sdk/` — Vercel AI SDK on Thenvoi

A Thenvoi agent backed by the [Vercel AI SDK](https://sdk.vercel.ai) (`ai` package). You supply a language model from any `@ai-sdk/*` provider — OpenAI, Anthropic, Google, Mistral, Groq, etc. — and the adapter handles tool schema generation, history management, function-call dispatch, and retries.

Use this when you want one model abstraction across providers and easy swaps (`@ai-sdk/openai` today, `@ai-sdk/anthropic` tomorrow) without changing agent code. For provider-native shapes, see `examples/openai/`, `examples/anthropic/`, `examples/gemini/`.

## What it shows

- Wiring `VercelAISDKAdapter` into `Agent.create`
- Lazy-loading the provider package so the SDK doesn't hard-depend on `ai` / `@ai-sdk/*`
- How a provider-agnostic adapter folds Thenvoi platform tools into a tool-calling loop the `ai` library drives

## Files

| File | What it does |
|------|--------------|
| `vercel-ai-agent.ts` | Adapter + agent + CLI runner. ~70 lines. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- The Vercel AI SDK and at least one provider package:
  ```bash
  pnpm add ai @ai-sdk/openai
  # or whichever provider you want to use:
  # pnpm add ai @ai-sdk/anthropic
  # pnpm add ai @ai-sdk/google
  # pnpm add ai @ai-sdk/mistral
  # pnpm add ai @ai-sdk/groq
  ```
- Provider credentials in env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.)
- `agent_config.yaml`:

```yaml
vercel_ai_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export OPENAI_API_KEY=sk-...
pnpm --dir packages/sdk exec tsx examples/vercel-ai-sdk/vercel-ai-agent.ts
```

Default model is `gpt-5.5`. Swap to another provider by editing `loadDefaultModel` — the rest of the example is unchanged.

## What "working" looks like

1. Process starts, no errors.
2. From a Thenvoi room the agent is in, ask anything: `What's a fast way to deduplicate an array in modern JS?`.
3. The agent calls `thenvoi_send_message` and posts the answer.
4. Tool calls (incl. platform tool calls) show up as `task` events because of `enableExecutionReporting: true`.

## Swapping providers

The example is intentionally minimal. To use Anthropic instead:

```ts
async function loadDefaultModel(modelId: string) {
  const mod = await import("@ai-sdk/anthropic");
  return mod.anthropic(modelId);  // e.g. "claude-sonnet-4-7"
}
```

…or pass any model directly when you call the factory:

```ts
import { anthropic } from "@ai-sdk/anthropic";
await createVercelAgent({ model: anthropic("claude-sonnet-4-7") }, config);
```

The Thenvoi-side wiring doesn't change.

## Common errors

| Error | Cause |
|-------|-------|
| `@ai-sdk/openai is not installed.` | Provider package missing — install per the prerequisites |
| `Set OPENAI_API_KEY ...` | Provider key not in env |
| `AI_APICallError: 401` | Bad provider key |
| Agent connects but never replies | Agent isn't a participant in the room |

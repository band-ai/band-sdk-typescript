# Gemini Examples for Band

Tool-calling agent via `GeminiAdapter` (Google GenAI) with custom instructions and character prompts.

## Prerequisites

1. **Google API key** — `GOOGLE_API_KEY` or `GEMINI_API_KEY`
2. **Band agent** — `gemini_agent`, `support_agent`, or `tom_agent` / `jerry_agent` in `agent_config.yaml`

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Default Gemini model and Band tools |
| `02_custom_instructions.ts` | Support-style `customSection` + `enableExecutionReporting` |
| `03_tom_agent.ts` | Tom character prompt |
| `04_jerry_agent.ts` | Jerry character prompt |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/gemini/01_basic_agent.ts
pnpm exec tsx examples/gemini/02_custom_instructions.ts
pnpm exec tsx examples/gemini/03_tom_agent.ts
pnpm exec tsx examples/gemini/04_jerry_agent.ts
```

## Configuration

```yaml
gemini_agent:
  agent_id: "your-gemini-agent-id"
  api_key: "your-api-key"

support_agent:
  agent_id: "your-support-agent-id"
  api_key: "your-api-key"
```

Character scripts use shared `tom_agent` / `jerry_agent` blocks (see `examples/anthropic/README.md`).

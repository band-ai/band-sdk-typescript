# OpenAI Examples for Band

Tool-calling agent via `OpenAIAdapter` with optional Band memory tools and custom system prompts.

## Prerequisites

1. **OpenAI API key** — `OPENAI_API_KEY` in the environment
2. **Band agent** — see configuration keys per script below

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Default model and Band platform tools |
| `02_memory_agent.ts` | `includeMemoryTools` + `renderSystemPrompt` memory capability section |
| `03_tom_agent.ts` | Tom character (`examples/prompts/characters.ts`) |
| `04_jerry_agent.ts` | Jerry character — run alongside Tom in the same room |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/openai/01_basic_agent.ts
pnpm exec tsx examples/openai/02_memory_agent.ts
pnpm exec tsx examples/openai/03_tom_agent.ts
pnpm exec tsx examples/openai/04_jerry_agent.ts
```

## Configuration

```yaml
openai_agent:
  agent_id: "your-openai-agent-id"
  api_key: "your-api-key"

memory_agent:
  agent_id: "your-memory-agent-id"
  api_key: "your-api-key"
  openai_api_key: "optional-openai-key"
  model: "gpt-4o"

tom_agent:
  agent_id: "your-tom-agent-id"
  api_key: "your-api-key"

jerry_agent:
  agent_id: "your-jerry-agent-id"
  api_key: "your-api-key"
```

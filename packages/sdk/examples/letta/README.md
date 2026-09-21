# Letta Examples for Band

Band agent backed by [Letta](https://www.letta.com/) via `LettaAdapter` — Letta-managed agents, memory blocks, and optional reasoning events.

## Prerequisites

1. **Letta** — `LETTA_API_KEY` (cloud) or `LETTA_BASE_URL` (self-hosted)
2. Optional: `LETTA_MODEL` (default `openai/gpt-4o`)
3. **Band agent** — `letta_agent` or `tom_agent` / `jerry_agent` in `agent_config.yaml`

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Default Letta bridge |
| `02_memory_blocks.ts` | Letta `memoryBlocks` + `emitReasoningEvents` |
| `03_tom_agent.ts` | Tom via `customSection` |
| `04_jerry_agent.ts` | Jerry via `customSection` |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/letta/01_basic_agent.ts
pnpm exec tsx examples/letta/02_memory_blocks.ts
pnpm exec tsx examples/letta/03_tom_agent.ts
pnpm exec tsx examples/letta/04_jerry_agent.ts
```

## Configuration

```yaml
letta_agent:
  agent_id: "your-letta-band-agent-id"
  api_key: "your-api-key"
```

Letta credentials are read from the environment, not YAML.

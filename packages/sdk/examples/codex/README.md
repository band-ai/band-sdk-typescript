# Codex Examples for Band

Run a Band agent backed by the Codex app-server via `CodexAdapter`.

## Prerequisites

1. **Codex CLI** — install and authenticate (`codex login`; uses `CODEX_API_KEY` / OAuth as configured by Codex)
2. **Band agent** — `codex_agent` (or `tom_agent` / `jerry_agent` for character scripts) in `agent_config.yaml`
3. Optional: `CODEX_CWD` — disposable working directory for Codex (see repo `.env.test`)

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Default Codex settings with execution reporting and tool visibility |
| `02_tom_agent.ts` | Tom character prompt (shared `examples/prompts/characters.ts`) |
| `03_jerry_agent.ts` | Jerry character prompt — run alongside Tom in the same room |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/codex/01_basic_agent.ts
pnpm exec tsx examples/codex/02_tom_agent.ts
pnpm exec tsx examples/codex/03_jerry_agent.ts
```

## Configuration

```yaml
codex_agent:
  agent_id: "your-codex-agent-id"
  api_key: "your-api-key"

tom_agent:
  agent_id: "your-tom-agent-id"
  api_key: "your-api-key"

jerry_agent:
  agent_id: "your-jerry-agent-id"
  api_key: "your-api-key"
```

Band credentials use `loadAgentConfig(...)` only. Codex provider auth is handled by the Codex CLI / environment, not YAML.

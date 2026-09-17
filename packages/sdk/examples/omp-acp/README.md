# OpenCode Model Protocol (OMP) ACP Examples for Band

Bridge Band to an **OMP** subprocess speaking ACP over stdio via `OmpACPAdapter`.

## Prerequisites

1. **OMP CLI** on `PATH` — default command `omp acp` (see `DEFAULT_OMP_ACP_COMMAND`)
2. **Model credentials** — typically `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the pinned Google model OMP uses (see `tests/integration/omp-acp-live.ts`)
3. **Band agent** — `omp_acp_agent` in `agent_config.yaml`

Optional: set `cwd` when constructing the adapter for an isolated working directory.

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Stdio OMP ACP bridge with platform tools forwarded to the subprocess |
| `02_tom_agent.ts` | Tom character (`customSection` on first ACP turn system context) |
| `03_jerry_agent.ts` | Jerry character — run with Tom in the same room |

Character prompts: `examples/prompts/characters.ts`. Use `tom_agent` / `jerry_agent` in `agent_config.yaml`.

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/omp-acp/01_basic_agent.ts
```

## Configuration

```yaml
omp_acp_agent:
  agent_id: "your-omp-acp-agent-id"
  api_key: "your-api-key"
```

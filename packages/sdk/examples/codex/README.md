# Codex Examples for Band

Run a Band agent backed by the Codex app-server via `CodexAdapter`.

## Prerequisites

1. **Codex CLI** — install and authenticate (`codex login`; uses `CODEX_API_KEY` / OAuth as configured by Codex)
2. **Band agent** — `codex_agent` (or `tom_agent` / `jerry_agent` for character scripts) in `agent_config.yaml`

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

Each room gets its own Codex app-server in `<cwd>/.band-workspaces/<roomId>`; pass `cwd` to choose the root (default `process.cwd()`).

Band credentials use `loadAgentConfig(...)` only. Codex provider auth is handled by the Codex CLI / environment, not YAML.

### Automatic working indicator

Working state is on by default through shared runtime
[`sessionConfig`](../../../../README.md#automatic-working-state), with a three-second
keep-alive and two-second request budget. Use `Agent.create({ ..., sessionConfig:
{ enableWorkingState: false } })` to disable it. No provider-specific option or
tool capability is needed. Execution reporting options control chat tool narration
independently of this automatic indicator and its activity detail.

```ts
import { Agent, CodexAdapter, loadAgentConfig } from "@band-ai/sdk";

const agent = Agent.create({
  config: loadAgentConfig("my_agent"),
  sessionConfig: { enableWorkingState: true },
  adapter: new CodexAdapter({ config: { enableExecutionReporting: false } }),
});
```

Ask Codex to run an allowed native command such as `pwd`. Its item start/completion
events report `tool_call/exec` then reasoning on a compatible agent API. The command
and its output stay out of activity; approval defaults are unchanged.

# GitHub Copilot CLI (ACP) Examples for Band

Spawn **GitHub Copilot CLI** in ACP stdio mode and bridge Band room messages through `CopilotACPAdapter` (`ACPClientAdapter`).

## Prerequisites

1. **Copilot CLI** with ACP support — `copilot --version` (public preview)
2. **Peer dependency** — `@agentclientprotocol/sdk` (install in your app if types/tools are needed)
3. **Authentication** — one of:
   - Hosted: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`
   - BYOK: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL`, and provider API key env vars Copilot expects
4. **Band agent** — `copilot_acp_agent` in `agent_config.yaml`

Optional: `COPILOT_HOME` (isolated config dir), `COPILOT_ALLOW_ALL=true` for unattended smoke runs (see `tests/integration/copilot-acp-live.ts`).

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Stdio ACP bridge with default `copilot --acp --stdio` command |
| `02_tom_agent.ts` | Tom character (`customSection` on first ACP turn system context) |
| `03_jerry_agent.ts` | Jerry character — run with Tom in the same room (separate terminals / agents) |

Character prompts: `examples/prompts/characters.ts`. Use `tom_agent` / `jerry_agent` in `agent_config.yaml`.

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/copilot-acp/01_basic_agent.ts
```

## Configuration

```yaml
copilot_acp_agent:
  agent_id: "your-copilot-acp-agent-id"
  api_key: "your-api-key"
```

Band YAML holds platform credentials only. Copilot CLI auth stays in the environment.

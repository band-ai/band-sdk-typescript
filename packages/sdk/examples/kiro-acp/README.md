# AWS Kiro CLI (ACP) Examples for Band

Spawn **Kiro CLI** in ACP stdio mode and bridge Band room messages through `KiroACPAdapter` (`ACPClientAdapter`).

## Prerequisites

1. **Kiro CLI** with ACP support — `kiro-cli acp` (JSON-RPC 2.0 over stdin/stdout; no TCP/remote transport)
2. **Peer dependency** — `@agentclientprotocol/sdk` (install in your app if types/tools are needed)
3. **Authentication** — headless mode requires an API key set as the `KIRO_API_KEY` environment variable ([kiro.dev/docs/cli/headless](https://kiro.dev/docs/cli/headless)); generate it via the Kiro portal (Pro/Pro+/Pro Max/Power tiers)
4. **Band agent** — `kiro_acp_agent` in `agent_config.yaml`

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Stdio ACP bridge with the default `kiro-cli acp` command |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/kiro-acp/01_basic_agent.ts
```

## Configuration

```yaml
kiro_acp_agent:
  agent_id: "your-kiro-acp-agent-id"
  api_key: "your-api-key"
```

Band YAML holds platform credentials only. Kiro CLI auth (`KIRO_API_KEY`) stays in the environment.

## Known unknowns

Kiro's `_kiro.dev/*` extension methods (`mcp/oauth_request`, `metadata`, and others) are experimental and their exact request/response shapes are unconfirmed against a live `kiro-cli acp` session — see the code comments in `../../src/adapters/kiro-acp/KiroACPAdapter.ts`. Whether `session/new`'s `mcpServers` is honored for Band's platform-tools injection, or Kiro only reads MCP config from an on-disk `.kiro/settings/mcp.json`, is also unconfirmed; both are open items for this integration's own gap-analysis pass against a real Kiro CLI.

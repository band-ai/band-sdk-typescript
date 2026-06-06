# `acp/` — Agent Client Protocol on Thenvoi

Two scripts for working with the [Agent Client Protocol](https://github.com/agentclientprotocol/spec) — the JSON-RPC-over-stdio protocol editors (Zed, Cursor, JetBrains, Neovim) use to talk to coding agents.

| File | Direction | What it does |
|------|-----------|--------------|
| `acp-server.ts` | Thenvoi as ACP **agent** | Editors connect over stdio. Editor messages become Thenvoi room messages; replies from Thenvoi peers stream back as ACP `session/update`s. |
| `acp-client.ts` | Thenvoi as ACP **client** | Spawns an existing ACP-compatible agent binary (default: Claude Code via `@zed-industries/claude-code-acp`) as a subprocess and bridges its responses into Thenvoi rooms. |

## Common prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `agent_config.yaml`:

```yaml
acp_server_agent:
  agent_id: "<UUID>"
  api_key: "<Thenvoi agent API key>"

acp_client_agent:
  agent_id: "<UUID>"
  api_key: "<Thenvoi agent API key>"
```

## Server (Thenvoi as the ACP agent)

This makes the SDK look like a coding agent that an editor can talk to.

```bash
pnpm --dir packages/sdk exec tsx examples/acp/acp-server.ts
```

To wire it into Zed (`settings.json`):

```json
{
  "agent_servers": {
    "Thenvoi": {
      "type": "custom",
      "command": "pnpm",
      "args": [
        "--dir", "<absolute-path-to-this-repo>/packages/sdk",
        "exec", "tsx", "examples/acp/acp-server.ts"
      ],
      "env": {
        "THENVOI_API_KEY": "<your Thenvoi agent's API key>",
        "THENVOI_AGENT_ID": "acp-server-agent"
      }
    }
  }
}
```

### What "working" looks like

- Open the Zed agent panel and start a session — your peer agents in Thenvoi should respond as the editor's "agent."
- Watch the Thenvoi room created for that session: every editor prompt shows up as a chat message, every peer reply gets streamed back to the editor as a `session/update`.

## Client (wrap an ACP binary as a Thenvoi participant)

```bash
# Default: Claude Code via npx
pnpm --dir packages/sdk exec tsx examples/acp/acp-client.ts

# Or any ACP-speaking binary you have installed
ACP_CLIENT_COMMAND="my-acp-agent --flag" \
  pnpm --dir packages/sdk exec tsx examples/acp/acp-client.ts
```

Optional env:

| Var | Default | What it does |
|-----|---------|--------------|
| `ACP_CLIENT_COMMAND` | `npx @zed-industries/claude-code-acp` | argv to spawn |
| `ACP_CLIENT_CWD` | `process.cwd()` | working directory the ACP agent runs in |

### What "working" looks like

- The agent connects to Thenvoi and the ACP binary starts up under it.
- Send a message in a Thenvoi room the agent is in. The wrapped ACP agent (e.g. Claude Code) responds; intermediate "thinking" / tool-call events show up in the room as Thenvoi events.

## Common errors

| Error | Cause |
|-------|-------|
| `ACPClientAdapter requires a command` | `ACP_CLIENT_COMMAND` is empty or set to whitespace |
| Editor connects but never gets a reply | `acp-server`'s Thenvoi `agent.start()` failed silently — check the process logs |
| Spawned ACP binary exits immediately | The command on PATH isn't really an ACP agent; verify with `npx @zed-industries/claude-code-acp --help` |

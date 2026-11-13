# Claude CLI stream-json captures

Captured from an installed Claude Code CLI, version 2.1.319, on macOS (arm64).
Each directory is one scenario:

| Scenario | Frames | What it shows |
|---|---|---|
| `initialize` | 1 (+7 MCP) | control initialize |
| `turn-basic` | 5 (+7 MCP) | system init and a plain turn |
| `tool-call` | 9 (+11 MCP) | a turn with one MCP tool call |
| `permission-allow` | 7 (+9 MCP) | a permission prompt the host allowed |
| `permission-deny` | 8 (+9 MCP) | a permission prompt the host declined |
| `interrupt-pending-permission` | 8 (+9 MCP) | an interrupt while a permission is pending |
| `resume-turn-1` | 5 (+7 MCP) | the first turn of a session |
| `resume-turn-2` | 5 (+7 MCP) | the same session resumed in a new process |
| `control-error` | 2 (+7 MCP) | a control request the CLI refuses |

Files per scenario:

- `stdout.ndjson` — the frames the CLI wrote, one JSON object per line, in order.
- `stdin.ndjson` — the frames the host wrote to the CLI.
- `mcp.ndjson` — the JSON-RPC the CLI exchanged with the local stdio MCP probe
  server (`direction` is from the probe's point of view), where one was configured.
- `meta.json` — CLI version, invocation, exit state, and what was stripped.

The invocation is the shape the adapter uses: `<claude-cli> --print --input-format
stream-json --output-format stream-json --verbose --strict-mcp-config --mcp-config
<mcp-config.json> --permission-prompts host --permission-prompt-tool
mcp__probe__permission`, run in a dedicated empty workspace. `<claude-cli>` is the
resolved executable; the probe server is a local stdio MCP server with two tools,
`echo` and the private `permission` callback.

Everything naming a person, a machine or a session is stripped, so these fixtures
show the protocol's shape, not one account's transcript. Their ids are placeholders
that still correlate (`toolu-2` in a `tool_use` is the `toolu-2` its `tool_result`
names), so a test can follow a tool call through its result. They are read by
`tests/claude-cli-client.test.ts`; do not hand-edit them.

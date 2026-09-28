# Claude SDK Adapter

This adapter integrates `@anthropic-ai/claude-agent-sdk` using the stable TypeScript API (`query(...)` with room-scoped `resume`).

Install dependency when using this adapter:

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

## Isolation

The adapter runs the Claude Code CLI, which by default inherits the host's Claude Code setup. A Band agent is isolated from it:

- **Host settings:** `settingSources` defaults to `[]`, so no `~/.claude` or project `.claude` settings, plugins, hooks, skills or CLAUDE.md load. Opt back in with, for example, `settingSources: ["user", "project"]`.
- **Denied tools:** `ListAgents`, `SendMessage` and `SendFile` (`DENIED_CLAUDE_CODE_TOOLS`) are always disallowed. They list, prompt, or send files to the OS user's other Claude Code sessions; a Band agent talks only through Band tools. Denying `SendMessage` also drops follow-up messages to the agent's own subagents; the `Agent` tool stays.
- **No tool search:** `ToolSearch` is always disallowed, so the session runs without tool search. The first turn then waits for the in-process Band MCP server, and no `mcp__band__*` tool is deferred behind a search step.
- **Flag settings** (`ISOLATION_SETTINGS`), always passed: `crossSessionInbound: "refuse"`, so the host's other sessions cannot prompt the agent, and `disableClaudeAiConnectors: true`, since claude.ai connectors follow the host's claude.ai login rather than any settings file.

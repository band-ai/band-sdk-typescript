# `claude-sdk/` — Claude Agent SDK on Thenvoi

A Thenvoi agent that runs the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) under the hood. Unlike the `anthropic/` example, which uses Anthropic's bare Messages API, this adapter gets you Claude Code-style behavior: filesystem access, shell commands, MCP tool servers, and a full agentic loop.

Use this when the agent should actually *do work in a repo* (read files, run commands, edit code) in response to chat.

## What it shows

- Wiring `ClaudeSDKAdapter` with `enableMcpTools: true` so Thenvoi platform tools (send message, lookup peers, etc.) become MCP tools alongside the SDK's filesystem/shell tools
- `permissionMode: "acceptEdits"` so file edits don't block on a prompt
- The simplest possible setup — see `coding-agents/` for a richer planner+reviewer pair

## Files

| File | What it does |
|------|--------------|
| `claude-sdk-agent.ts` | Plain Claude SDK agent — minimal, ~50 lines |
| `02-extended-thinking.ts` | Same agent with `effort: "high"` and reasoning streamed back as Thenvoi events |
| `03-tom-agent.ts` | Tom the cat — character agent backed by the Claude Agent SDK |
| `04-jerry-agent.ts` | Jerry the mouse — counterpart to Tom |
| `characters.ts` | Tom + Jerry character prompts (used by 03 and 04) |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `ANTHROPIC_API_KEY` env var (the Claude Agent SDK reads it directly)
- `agent_config.yaml`:

```yaml
claude_sdk_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --dir packages/sdk exec tsx examples/claude-sdk/claude-sdk-agent.ts
```

By default the SDK uses `process.cwd()` as its working directory. Set the `cwd` option (or run `tsx` from a different folder) to point it at the repo you want the agent to operate on.

## What "working" looks like

1. Process starts, the Claude SDK initializes (you'll see SDK log lines).
2. From a Thenvoi room the agent is in, send: `Read package.json and tell me the project name.`
3. The agent reads the file via the SDK's `Read` tool, then calls `thenvoi_send_message` to reply with the name.

For non-trivial tasks like "add a function to file X", the agent will call multiple tools — file reads, edits, sometimes shell commands — before posting a final summary. Watch the process logs to follow along.

## Common errors

| Error | Cause |
|-------|-------|
| `ANTHROPIC_API_KEY` not set | The Claude Agent SDK throws on missing key |
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | The SDK is a peer dep — `pnpm add @anthropic-ai/claude-agent-sdk` |
| Silent hang on first message | Permission mode is interactive (`default`) and there's no TTY. Use `acceptEdits` or `bypassPermissions`. |

## Related

- `examples/coding-agents/` — a Claude SDK planner + Codex reviewer pair sharing a workspace
- `examples/anthropic/` — same model, no agentic loop / no filesystem

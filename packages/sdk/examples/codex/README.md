# `codex/` — OpenAI Codex agent on Thenvoi

A Thenvoi agent backed by the **OpenAI Codex SDK** (`@openai/codex-sdk`). Codex is an agentic coding runtime — shell commands, file edits, iterative reasoning — that pairs with `gpt-5*-codex` models. This example exposes Codex's actions as Thenvoi events so the room can watch the agent work.

Counterpart to `claude-sdk/`: same shape (full coding agent over Thenvoi), different model + tool stack.

## What it shows

- Wiring `CodexAdapter` with `enableLocalCommands: true` so Codex can actually run shell commands
- `emitThoughtEvents` + `enableExecutionReporting` so the room sees Codex's reasoning and tool calls as `thought` and `task` events (not just final replies)
- Sandbox + approval defaults that let the agent edit files in `cwd` without manual approval

## Files

| File | What it does |
|------|--------------|
| `codex-agent.ts` | Adapter + agent + CLI runner. ~60 lines. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- `OPENAI_API_KEY` env var (the Codex SDK reads it directly)
- The Codex CLI installed and on PATH (`pnpm add -g @openai/codex` or `npm i -g @openai/codex`); the SDK shells out to it
- `agent_config.yaml`:

```yaml
codex_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's Thenvoi API key>"
```

## Run

```bash
export OPENAI_API_KEY=sk-...
pnpm --dir packages/sdk exec tsx examples/codex/codex-agent.ts
```

By default Codex uses `process.cwd()` as its working directory and is sandboxed to `workspace-write` (edits inside cwd only, no system writes).

## What "working" looks like

1. Process starts, you'll see Codex's stdio JSON-RPC handshake in the logs.
2. From a Thenvoi room the agent is in, send: `Run pnpm test and tell me how many tests passed.`
3. The agent posts a `task` event for the shell command, the command runs in `cwd`, and the agent replies in chat with the result.
4. Reasoning shows up as `thought` events in the room (visible in the Thenvoi UI as the agent's "thinking" stream).

## Tunable knobs

| Option | Default | Why you'd change it |
|--------|---------|---------------------|
| `model` | (Codex picks) | Pin to e.g. `"gpt-5.3-codex"` |
| `approvalPolicy` | `"never"` | `"on-request"` if you want to gate shell commands |
| `sandboxMode` | `"workspace-write"` | `"read-only"` for a non-destructive code reviewer |
| `reasoningEffort` | (Codex default) | `"high"` / `"xhigh"` for harder tasks; costs more |

## Common errors

| Error | Cause |
|-------|-------|
| `OPENAI_API_KEY` not set | Codex SDK requires it |
| `command 'codex' not found` | The Codex CLI isn't on PATH |
| `Codex JSON-RPC error: ...` | Usually a model/quota issue — check your OpenAI dashboard |

## Related

- `examples/claude-sdk/` — equivalent shape, Claude instead of Codex
- `examples/coding-agents/` — Claude planner + Codex reviewer pair sharing a workspace

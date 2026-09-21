# Cursor ACP Examples for Band

`CursorACPAdapter` runs Cursor CLI's documented `agent acp` backend over stdio.

## Prerequisites

1. Install and authenticate Cursor CLI with `agent login`, or provide `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` through the adapter environment.
2. Configure a Band agent named `cursor_acp_agent` in `agent_config.yaml`.

Run the basic example from `packages/sdk/`:

```bash
pnpm exec tsx examples/cursor-acp/01_basic_agent.ts
```

Cursor questions, plans, and permissions require room approval by default. Use the `/cursor decisions` command to list pending requests, then answer, accept/reject, select, or deny with the token shown in the room.

Pass `resolveSessionConfig` to select only the model and effort options Cursor advertises for the live session. The adapter never embeds a model or effort catalog.

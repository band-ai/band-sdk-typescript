# Examples

Each subfolder is intentionally standalone so you can copy a single folder out and hack on it.

Folders:

- `basic/`
- `openai/`
- `anthropic/` — [README](anthropic/README.md) (Anthropic adapter; numbered scripts)
- `gemini/`
- `claude-sdk/` — [README](claude-sdk/README.md)
- `codex/` — [README](codex/README.md)
- `omp-acp/` — [README](omp-acp/README.md)
- `copilot-acp/` — [README](copilot-acp/README.md) (GitHub Copilot CLI ACP)
- `custom-adapter/`
- `langgraph/`
- `parlant/`
- `a2a-bridge/` — [README](a2a-bridge/README.md) (A2A outbound bridge)
- `a2a-gateway/`
- `linear-band/` — [README](linear-band/README.md)
- `dog-landing-page/`

## Running and debugging examples

From `packages/sdk` (repo root `.env.test` supplies Band + LLM keys):

```bash
pnpm run examples:config          # write agent_config.yaml from .env.test
pnpm run examples:discover        # list runnable entry points + config keys
pnpm run examples:smoke           # startup liveness (OK_RUNNING) sweep
pnpm run examples:smoke -- --family anthropic
pnpm run examples:run-plan -- scripts/example-plans/basic-echo.yaml --dry-run
```

Agent skill (parity with band-sdk-python): `.claude/skills/bug-hunting-via-example/SKILL.md`.

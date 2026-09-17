---
name: bug-hunting-via-example
description: Ask which runnable TypeScript examples to use, discover them from the repo, smoke-start or live-run against Band with fresh provisioned agents, and trace failures across adapters, config, and platform boundaries. Use for example certification, live debugging, adapter integration issues, and parity work with band-sdk-python's example workflow.
---

# Bug Hunting via Example (TypeScript SDK)

Port of band-sdk-python's `.claude/skills/bug-hunting-via-example`, adapted for `packages/sdk/examples/**/*.ts` entry points (`isDirectExecution` + `loadAgentConfig`).

## Principles

- Run the **exact** example script (`tsx examples/...`), not a hand-built duplicate agent.
- Startup liveness (`OK_RUNNING`) is not proof of LLM behavior — use the live runner for marker turns.
- Prefer fresh provisioned agents (`tests/integration/support/liveHarness.ts`) over shared `agent_config.yaml` for live plans.
- Never print API keys; child logs go to temp files on failure only.
- Reuse Python's mental model: discover → config → smoke → (optional) YAML plan → scorecard.

## 0. Select examples

```bash
cd packages/sdk
pnpm run examples:discover
pnpm run examples:discover -- --family anthropic --json
```

Ask the user which paths to use if they have not already named them. Run both **startup smoke** and, when debugging behavior, a **live plan** with marker steps.

## 1. Repository contract

- Examples: `packages/sdk/examples/` — credentials via `loadAgentConfig("…")`, not raw `process.env` for Band keys.
- Generate shared YAML for local smoke: `pnpm run examples:config` (reads repo `.env.test` + optional `../band-sdk-python/agent_config.yaml` for tom/jerry).
- Env file for runs: repo root `.env.test` (`node --env-file=../../.env.test …` from `packages/sdk`).
- Live provisioning: `BAND_API_KEY_USER` + `BAND_REST_URL` / `BAND_WS_URL` (see `loadLiveEnv()`).
- A2A bridge smoke: start stub with `pnpm run examples:a2a-stub` when `A2A_AGENT_URL` points at it.
- Docs: `AGENTS.md` (Example Files), per-folder `README.md`.

## 2. Startup smoke (no LLM turn)

Confirms imports, config, and WebSocket connect — same role as manual `OK_RUNNING` sweeps:

```bash
cd packages/sdk
pnpm run examples:config
pnpm run examples:smoke
pnpm run examples:smoke -- --only examples/basic/basic-agent.ts
pnpm run examples:smoke -- --family anthropic --no-skip-missing-env
```

Skips families whose typical env gates are missing (override with `--no-skip-missing-env`).

Implementation: `packages/sdk/scripts/examples-smoke-startup.mjs` + `examples-discover.mjs`.

## 3. Live runner (marker turn, independent topology)

YAML plan format matches Python's runner seam (simplified: **independent** scenarios only — no `collaborations` / shared-room group yet).

> **A plan file is arbitrary code execution.** `command` is argv the runner spawns; read untrusted plans like shell scripts.

```yaml
version: 1
examples:
  - id: basic
    path: examples/basic/basic-agent.ts
    config_key: basic_agent
    forward_env: []
    steps:
      - prompt: "Reply with the exact marker {marker}."
        barrier: reply
        contains_any: ["{marker}"]
```

```bash
cd packages/sdk
node --env-file=../../.env.test ./node_modules/tsx/dist/cli.mjs scripts/example-runner.ts /tmp/plan.yaml --dry-run
node --env-file=../../.env.test ./node_modules/tsx/dist/cli.mjs scripts/example-runner.ts /tmp/plan.yaml
```

Each example gets an isolated temp `agent_config.yaml` with a **provisioned** agent identity; the runner drives the room with the **user** key (`BAND_API_KEY_USER`). LLM keys must be named in `forward_env`. Band user keys must never appear in the plan.

Sample plan checked into the repo: `packages/sdk/scripts/example-plans/basic-echo.yaml`.

## 4. Python parity reference

For full independent + together topologies, collaboration probes, and tool-call barriers, see band-sdk-python:

- `.claude/skills/bug-hunting-via-example/SKILL.md`
- `scripts/discover.py`, `scripts/runner.py`
- `tests/e2e/baseline/toolkit/`

Extend the TypeScript runner when a concrete TS debugging session proves the same seam is needed.

## 5. Report

Hand off: discovery output, smoke scorecard, live scorecard, preserved child log paths on startup failure, and whether the defect is example/config/platform/adapter/external CLI.

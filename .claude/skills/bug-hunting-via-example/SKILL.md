---
name: bug-hunting-via-example
description: Validate or debug actual runnable TypeScript examples using the existing discovery, startup-smoke and live runners. Use for named examples or example certification; use band-investigate-test-error for a failing test and band-run-e2e-live for baseline scenarios.
---

# Bug Hunting via Example (TypeScript SDK)

Read [workflow-runtime.md](../workflow-runtime.md). Use the existing
`packages/sdk/examples/**/*.ts` entry points (`isDirectExecution` +
`loadAgentConfig`) and runner implementations; verify their supported options
before execution. Diagnosis does not imply publication or unrelated live runs.

## Principles

- Run the **exact** example script (`tsx examples/...`), not a hand-built duplicate agent.
- Startup liveness (`OK_RUNNING`) is not proof of LLM behavior — use the live runner for marker turns.
- Prefer fresh provisioned agents (`tests/integration/support/liveHarness.ts`) over shared `agent_config.yaml` for live plans.
- Never print API keys; child logs go to temp files on failure only.
- Follow discovery → config → smoke → scoped live plan → scorecard.
- Preserve existing configuration and other agents' resources; use owned
  worktrees and temporary plans for experiments.

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

> A plan can specify executable argv through `command`. Inspect its source and
> intended commands before running it. A trusted developer-authored plan is
> ordinary local execution; do not label it a vulnerability without an
> untrusted-input path across an authority boundary.

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

## 4. Diagnose at the actual boundary

The TS runner supports independent scenarios. Do not invent shared-room or
collaboration options from another SDK. A concrete need for that support is a
separate proposed runner change, with an implementation plan and approval.
For failures, compare example/config, platform, adapter and external CLI
hypotheses with observed evidence; reuse `band-investigate-test-error`'s
investigation method. Preserve the exact failing command and owned logs.

## 5. Report

Hand off: discovery output, smoke scorecard, live scorecard, preserved child log paths on startup failure, and whether the defect is example/config/platform/adapter/external CLI.

When fixes are requested, repair the owning cause and validate the affected
behavior using AGENTS. New PRs start as drafts and require author readiness
before promotion. Never treat startup liveness as successful end-to-end behavior.

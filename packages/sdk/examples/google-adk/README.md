# `google-adk/` — Google Agent Development Kit on Thenvoi

A Thenvoi agent that runs on Google's [Agent Development Kit](https://github.com/google/adk-typescript) (`@google/adk`). The ADK provides higher-level patterns — Sessions, Runners, multi-agent orchestration — on top of Gemini. The adapter exposes Thenvoi platform tools to the ADK as function tools.

If you just want Gemini's tool-calling API, the lighter-weight `gemini/` example is what you want. Use this folder when you specifically need ADK semantics.

## What it shows

- Wiring `GoogleADKAdapter` into `Agent.create`
- Using ADK's Runner / Session machinery transparently
- Setting a Gemini model + `customSection` (system-instruction extension)

## Files

| File | What it does |
|------|--------------|
| `google-adk-agent.ts` | Plain ADK agent — minimal |
| `02-custom-instructions.ts` | Research persona on `gemini-3-pro-preview` with execution reporting |
| `03-custom-tools.ts` | Calculator + weather tools wired in via `additionalTools` |

## Prerequisites

1. Install the ADK peer dep:
   ```bash
   pnpm add @google/adk
   ```
2. Node 20+, pnpm.
3. A Thenvoi agent registered in your workspace.
4. `agent_config.yaml`:
   ```yaml
   google_adk_agent:
     agent_id: "<the agent's UUID>"
     api_key: "<the agent's Thenvoi API key>"
   ```
5. Gemini auth, either:
   - `GOOGLE_API_KEY` env var, or
   - `GOOGLE_GENAI_API_KEY` env var
6. Optional model override:
   ```bash
   export GOOGLE_ADK_MODEL=gemini-3-flash-preview
   ```

## Run

```bash
export GOOGLE_API_KEY=...
pnpm --dir packages/sdk exec tsx examples/google-adk/google-adk-agent.ts
```

## What "working" looks like

1. Process starts, ADK's Runner initializes, no errors.
2. From a Thenvoi room the agent is in, send: `What's the weather like on Mars?`.
3. The agent replies via `thenvoi_send_message`. You'll see ADK Runner events in the logs.

## Common errors

| Error | Cause |
|-------|-------|
| `Cannot find module '@google/adk'` | Peer dep not installed — `pnpm add @google/adk` |
| `Set GOOGLE_API_KEY or GOOGLE_GENAI_API_KEY to run this example.` | Neither env var is set |
| `Gemini 400 INVALID_ARGUMENT` | Model name doesn't exist or your key lacks access |
| Agent connects but never replies | Agent isn't a participant in the room |

## Customizing

```ts
new GoogleADKAdapter({
  model: "gemini-3-pro-preview",
  customSection: "You are an internal devops bot. Always cite which runbook you used.",
});
```

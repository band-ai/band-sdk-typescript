---
name: band-add-framework-adapter
description: "Add a framework adapter to the Band TypeScript SDK. Research the released SDK, plan ownership and capabilities, implement the existing adapter patterns, and validate unit, consumer, and live behavior."
---

# Add a Framework Adapter

Read [workflow-runtime.md](../workflow-runtime.md), the TypeScript conventions,
and test conventions. Use the requested framework and scope; do not add an
invented integration or speculative capability.

## Research and plan before implementation

Inspect the closest TS adapter, its history converter, tests, and the actual
installed upstream JavaScript and declarations. Verify cancellation, tool
registration, errors, session resume, and disposal against current primary
docs and the released version being used. Probe uncertain behavior in an
isolated environment. A type signature alone does not prove runtime behavior.

Record a proportional plan covering supported capabilities, owning layer,
room/session mapping, borrowed versus owned resources, startup rollback,
turn cancellation, tool name collisions, history/own replies, compatibility,
examples, and scenario assertions. Reuse existing infrastructure; inspect it
before naming helpers. Resolve design questions before writing dependent code.

Choose the actual family:

- `SimpleAdapter` for framework-controlled turns.
- `ToolCallingAdapter` with a `ToolCallingModel` for direct tool-calling APIs.
- Existing room-scoped helpers under `packages/sdk/src/adapters/shared/` when
  a runtime/session must be isolated per room.

Do not create a session manager for a stateless client or duplicate runtime
turn serialization. Use named `<Framework>AdapterOptions` and
`new <Framework>Adapter(options)`.

## Implement and register

1. Add `packages/sdk/src/adapters/<framework>/` with the adapter, barrel,
   and named options. Add a converter under `packages/sdk/src/converters/` only if needed.
2. Declare the framework SDK as an optional peer in the SDK manifest, with
   `peerDependenciesMeta` and intentional lockfile changes. Match existing
   development dependency practice so tests can exercise the installed SDK.
   Keep loading lazy and peers external; a root import must not require it.
3. Re-export from the existing adapter/root barrels and converter barrel.
   Add tsup entries and `package.json#exports` only for an intended public
   subpath, using actual output mappings.
4. Bridge platform schemas from `TOOL_MODELS` and existing helpers. Preserve
   custom-tool precedence, history attribution and own-agent filtering.
   Forward the turn's abort signal to providers and verify cancellation
   releases their work. Use structured `Logger` context.
5. Read `docs/turn-outcome.md`. `SimpleAdapter.onEvent` owns central judgment;
   use `sendNotice` for adapter-authored text and `relayReply` for model final
   text. Register in `packages/sdk/tests/turnOutcomeContract.ts` under
   `TURN_OUTCOME_ADAPTERS` or a justified `TURN_OUTCOME_EXEMPT` entry.
6. Register supported live behavior in
   `packages/sdk/tests/baseline/toolkit/adapters.ts` following
   `packages/sdk/tests/baseline/README.md`.
   Capabilities, requirements, pending/bespoke status must reflect reality;
   verify selection includes the intended scenarios.

## Prove behavior and review

Use realistic fakes at the verified provider boundary and actual adapter
entry points. Cover reply/mention behavior, bridged and custom tools, error
mapping, history, two-room isolation, cleanup and startup rollback. Native
sessions also need supported resume, resume-miss and recovery cases. A
multi-turn feature needs a multi-turn regression.

Check export/declaration consumer proofs and optional-peer import isolation.
Write needed live scenarios with `band-write-e2e-test`, then use
`band-run-e2e-live` for scoped validation. Missing credentials or backends are
limitations, not passes; do not start unrelated live runs.

Add an exact runnable example using the SDK config loaders and `ValidationError`
for missing configuration. Reuse lifecycle patterns; do not make users copy
runtime workarounds. Typecheck it and document actual prerequisites.

Review the final diff for simplicity, ownership, meaningful coverage, and
claims verified against the installed SDK. Scrutinize outside review findings
before accepting them. Apply the AGENTS validation and draft-first readiness
requirements; invoke the publishing `band-code-review` only when explicitly
requested. Report supported behavior, checks, and remaining limitations.

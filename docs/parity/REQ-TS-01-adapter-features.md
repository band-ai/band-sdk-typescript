# REQ-TS-01 — `AdapterFeatures` capability-gating system

- **Owner SDK:** TypeScript
- **Priority:** P0 (structural — sequence before REQ-TS-02/03/04)
- **Effort:** Medium
- **Status:** Proposed
- **Parity reference:** Python `src/thenvoi/core/types.py` (`AdapterFeatures`,
  `Capability`, `Emit`), `src/thenvoi/core/protocols.py`
  (`SimpleAdapter.SUPPORTED_EMIT`, `SUPPORTED_CAPABILITIES`)

## Problem

The Python SDK declares per-adapter capabilities and emissions declaratively:

- `Capability` enum (`MEMORY`, `CONTACTS`) and `Emit` enum (`EXECUTION`,
  `THOUGHTS`, `TASK_EVENTS`).
- A frozen `AdapterFeatures` dataclass carrying `capabilities`, `emit`,
  `include_tools`, `exclude_tools`, `include_categories`.
- Each `SimpleAdapter` subclass advertises `SUPPORTED_EMIT` and
  `SUPPORTED_CAPABILITIES` as class vars, and accepts a `features` constructor arg
  that filters the tool surface and emitted event types.

The TypeScript SDK has **no equivalent**. It uses ad-hoc per-adapter booleans
(`enableMemoryTools`, `enableExecutionReporting`, `includeMemoryTools`, etc.).
This makes the tool/emission surface inconsistent across adapters and harder to
reason about, and it diverges from the Python model that downstream tooling and
docs assume.

## Goal

Introduce a first-class capability/feature-gating model in the TypeScript SDK
that is behaviorally equivalent to Python's, and route adapter tool/emission
gating through it.

## Requirements

### Functional

1. Add `Capability` and `Emit` enums (or string-literal unions) mirroring the
   Python values: capabilities `memory`, `contacts`; emissions `execution`,
   `thoughts`, `task_events`.
2. Add an immutable `AdapterFeatures` type carrying at least: `capabilities`,
   `emit`, `includeTools`, `excludeTools`, `includeCategories`.
3. Extend the adapter base (`SimpleAdapter` / `ToolCallingAdapter`) to:
   - declare `supportedEmit` and `supportedCapabilities` (static/class-level),
   - accept an optional `features` constructor option,
   - resolve the effective tool surface and emission set from
     `features` ∩ `supported*`, with sane defaults when `features` is omitted.
4. Update `AgentTools` / `AdapterToolsProtocol` tool exposure
   (`getToolSchemas`, capability flags) to be driven by the resolved feature set
   instead of standalone booleans.
5. Maintain backward compatibility: existing boolean options
   (`enableMemoryTools`, etc.) should continue to work, mapped onto the new model
   (and may be marked deprecated in docs).

### Acceptance criteria

- All existing adapters compile and pass tests after migration to the feature
  model.
- An adapter constructed with `features` that excludes memory does not expose
  memory tools in `getToolSchemas()` output.
- Emission gating: an adapter whose `emit` excludes `thoughts` does not send
  thought events.
- Parity test: the resolved capability/emission behavior matches the Python SDK
  for an equivalent configuration (document the mapping).
- Public types are exported from the appropriate subpath (`@thenvoi/sdk/core` or
  root) and documented in the README's adapter section.

## Affected code (TypeScript)

- `packages/sdk/src/core/simpleAdapter.ts`
- `packages/sdk/src/adapters/tool-calling/` (base loop)
- `packages/sdk/src/runtime/tools/AgentTools.ts`, `schemas.ts`
- `packages/sdk/src/contracts/protocols.ts`
- All adapter constructors that currently take `enable*`/`include*` booleans.

## Dependencies

None. This is a prerequisite for REQ-TS-02/03/04 so new adapters adopt the model
from the start.

## Out of scope

- Changing the actual tool set or wire protocol.
- Python-side changes.

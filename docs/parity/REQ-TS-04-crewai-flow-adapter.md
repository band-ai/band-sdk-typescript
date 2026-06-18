# REQ-TS-04 — CrewAI Flow adapter

- **Owner SDK:** TypeScript
- **Priority:** P1 (depends on REQ-TS-03)
- **Effort:** Large
- **Status:** Proposed (blocked on REQ-TS-03 decision)
- **Parity reference:** Python `src/thenvoi/adapters/crewai_flow.py`
  (`CrewAIFlowAdapter`), `src/thenvoi/converters/crewai_flow.py`
  (`CrewAIFlowStateConverter`)

## Problem

The Python SDK ships `CrewAIFlowAdapter` for CrewAI's declarative *Flows*
orchestration (stateful, session-based: `CrewAIFlowSessionState`). There is no
TypeScript equivalent, and like REQ-TS-03 there is no JS CrewAI runtime.

## Goal

Provide CrewAI-Flow-equivalent functionality in TypeScript, or document the
divergence — consistent with whatever was decided for REQ-TS-03.

## Design decision

This item inherits the REQ-TS-03 decision:

- If REQ-TS-03 is **skipped (Option A)** → skip this too; document as divergence.
- If REQ-TS-03 **bridges to a Python process (Option B)** → CrewAI Flows run in
  the same external process; this item mostly needs session-state mapping
  (`CrewAIFlowSessionState` equivalent) over the bridge.
- If REQ-TS-03 is **re-implemented natively (Option C)** → add a declarative flow
  layer on top of it (largest cost).

## Requirements (if pursued)

### Functional

1. `CrewAIFlowAdapter extends SimpleAdapter<FlowSessionState>` with per-room
   session state mapping equivalent to `CrewAIFlowSessionState`.
2. A state converter equivalent to `CrewAIFlowStateConverter`.
3. Feature-gating via REQ-TS-01.

### Acceptance criteria

- Adapter exported and documented with an `examples/crewai-flow/` entry.
- Session state persists/rehydrates per room consistently with Python behavior.
- Conformance/adapter tests pass.

## Dependencies

- REQ-TS-03 (decision and, if applicable, implementation).
- REQ-TS-01 (`AdapterFeatures`).

## Out of scope

- Porting CrewAI Flows internals to TypeScript.

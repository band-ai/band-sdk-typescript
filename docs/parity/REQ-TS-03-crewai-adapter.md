# REQ-TS-03 — CrewAI adapter

- **Owner SDK:** TypeScript
- **Priority:** P1
- **Effort:** Large
- **Status:** Proposed (blocked on design decision)
- **Parity reference:** Python `src/thenvoi/adapters/crewai.py` (`CrewAIAdapter`),
  `src/thenvoi/integrations/crewai/` (runtime, tools, `EmitExecutionReporter`),
  `src/thenvoi/converters/crewai.py`

## Problem

The Python SDK ships a `CrewAIAdapter` (agent-framework category) configured with
`role`, `goal`, `backstory`, `model`, `custom_section`, `additional_tools`,
`features`, `history_converter`. CrewAI is a Python-only framework — there is **no
first-class JavaScript/TypeScript CrewAI runtime**.

This is the hardest parity item and cannot be a straight port.

## Goal

Decide how (or whether) to provide CrewAI-equivalent functionality in TypeScript,
then implement the chosen approach.

## Design decision required

Choose before implementation:

- **Option A — Skip / document divergence.** CrewAI is Python-only; record it as
  an intentional, possibly permanent divergence. Lowest cost, honest.
- **Option B — Bridge to a Python CrewAI process** via the existing A2A or ACP
  bridge (run the CrewAI crew as an external agent the TS SDK talks to). Reuses
  protocol-bridge infrastructure; no JS CrewAI needed.
- **Option C — Re-implement the role/goal/backstory + multi-agent crew loop**
  natively in TS on top of `ToolCallingAdapter`. Highest cost; effectively a new
  mini-framework. Not recommended unless there is strong demand.

Recommendation: **Option A or B.** Do not pursue Option C without explicit
product sign-off.

## Requirements (if Option B/C is chosen)

### Functional

1. Provide a `CrewAIAdapter` whose constructor surface mirrors Python where it
   makes sense: `role`, `goal`, `backstory`, `model`, `customSection`,
   `additionalTools`, `features` (per REQ-TS-01), `historyConverter`.
2. Map Thenvoi platform tools into the crew's tool surface.
3. Provide an execution-reporting path equivalent to Python's
   `EmitExecutionReporter` (gated via `features`/`emit`).
4. (Option B) Define the bridge contract: how a TS agent discovers, starts, and
   exchanges turns with the external CrewAI process.

### Acceptance criteria

- Adapter exported from `@thenvoi/sdk/adapters`, documented, with a runnable
  `examples/crewai/` entry.
- Tool execution and execution reporting work end-to-end against a sample crew.
- Conformance/adapter tests pass.

## Dependencies

- REQ-TS-01 (`AdapterFeatures`).
- Option B reuses the A2A/ACP bridge adapters.

## Out of scope

- Porting the CrewAI framework internals to TypeScript.

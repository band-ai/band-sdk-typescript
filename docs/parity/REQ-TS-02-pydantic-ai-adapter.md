# REQ-TS-02 — Pydantic AI adapter

- **Owner SDK:** TypeScript
- **Priority:** P1
- **Effort:** Medium
- **Status:** Proposed
- **Parity reference:** Python `src/thenvoi/adapters/pydantic_ai.py`
  (`PydanticAIAdapter`), `src/thenvoi/converters/pydantic_ai.py`

## Problem

The Python SDK ships a `PydanticAIAdapter` (LLM-direct, model strings like
`openai:gpt-5.4`, `anthropic:claude-3-5-sonnet-latest`). The TypeScript SDK has
no equivalent.

Pydantic AI is a Python-native framework. There is no first-class JS port, so
this requires a decision on **what "Pydantic AI parity" means in TypeScript**.

## Goal

Provide a TypeScript adapter that fills the same role the Python `PydanticAIAdapter`
fills, OR formally record it as an intentional divergence if no sensible JS analog
exists.

## Design decision required

Pick one before implementation:

- **Option A (recommended): treat it as already covered.** The Python
  `PydanticAIAdapter` is a typed, model-string-driven, tool-calling LLM adapter.
  In TypeScript that role is served by `ToolCallingAdapter` subclasses
  (`OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`) and `VercelAISDKAdapter`.
  If so, **close this as a documented intentional divergence** rather than
  building a redundant adapter.
- **Option B: build a thin `PydanticAIAdapter` shell** on top of
  `ToolCallingAdapter` that accepts Python-style `provider:model` strings and maps
  them to the right underlying client, purely for naming/API symmetry.

## Requirements (if Option B is chosen)

### Functional

1. Add `PydanticAIAdapter extends ToolCallingAdapter` with constructor options
   mirroring Python where meaningful: `model` (`provider:model` string),
   `systemPrompt`, `customSection`, `enableExecutionReporting`, `features`
   (per REQ-TS-01), `additionalTools`, `historyConverter`.
2. Map `provider:model` strings to the correct `ToolCallingModel`
   (OpenAI/Anthropic/Gemini wrapper).
3. Reuse the existing converters; add a `pydantic-ai` converter only if output
   shape differs.

### Acceptance criteria

- Adapter is exported from `@thenvoi/sdk/adapters` and documented in the README.
- Tool-calling, execution reporting, and feature-gating (REQ-TS-01) behave
  consistently with the other LLM-direct adapters.
- Conformance/adapter tests pass.

## Dependencies

- REQ-TS-01 (`AdapterFeatures`) — adopt the feature model from the start.

## Out of scope

- Reproducing Python-specific Pydantic validation semantics.

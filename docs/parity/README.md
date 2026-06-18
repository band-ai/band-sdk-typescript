# Thenvoi SDK Parity Docs (TypeScript)

This folder tracks the work to bring the TypeScript and Python Thenvoi SDKs to
functional parity. See [`ROADMAP.md`](./ROADMAP.md) for the order of work across
both repos (no timeline).

The requirement docs in this folder cover work that lands in **this** (TypeScript)
repo. Python-side requirement docs live in the `thenvoi-sdk-python` repo under the
same `docs/parity/` path. Requirement IDs are global and stable across both repos.

## Requirements owned by the TypeScript SDK

| ID | Title | Priority |
|----|-------|:--------:|
| [REQ-TS-01](./REQ-TS-01-adapter-features.md) | `AdapterFeatures` capability-gating system | P0 (structural) |
| [REQ-TS-02](./REQ-TS-02-pydantic-ai-adapter.md) | Pydantic AI adapter | P1 |
| [REQ-TS-03](./REQ-TS-03-crewai-adapter.md) | CrewAI adapter | P1 |
| [REQ-TS-04](./REQ-TS-04-crewai-flow-adapter.md) | CrewAI Flow adapter | P1 |

## Context

The two SDKs share an identical architecture by design (the TypeScript SDK is a
deliberate port of the Python reference implementation). As of this writing:

- TypeScript SDK: v0.1.6
- Python SDK: v0.2.11

The gaps below are the remaining deltas. See the roadmap for the Python-side
gaps (`REQ-PY-*`) and the intentional divergences.

# Nightly coverage audit

Audited against the adapter registry and `.github/workflows/e2e.yml` on
2026-10-08, with LangGraph enabled on 2026-10-16. The registry and
report projection remain the sources of truth for each run.

OpenAI's existing builder and installed `openai` peer passed its first local
adapter lane: 21 tests, no retries. The workflow supplies `E2E_OPENAI_API_KEY`;
its secret value was not inspected. OpenAI now participates normally, and an
absent or invalid credential fails instead of producing a static N/A.

LangGraph now uses the development-only `@langchain/openai` chat model with the
existing OpenAI model and credential. Its builder participates in the normal
fan-out, including custom-tool and memory scenarios. Missing credentials fail
the lane instead of excluding it. Room-scoped in-memory checkpoints retain
completed tool turns while the adapter runs.

The local LangGraph lane passed 24 tests. Its cross-framework rehydration test
also passed in a focused rerun after the shared Gemini default changed to
`gemini-3.1-flash-lite`, replacing the unavailable older model.

| Adapter | Remaining N/A cells | Classification | Work needed |
| --- | ---: | --- | --- |
| Parlant | 4 | Scenario incompatibility | Generic scenarios assume Band platform tools; this baseline builder does not register them. Its bespoke system-prompt scenario still runs against the pinned server. |

No required cells remain missing: the Vercel AI SDK builder now runs on
`@ai-sdk/anthropic` with the shared Anthropic model and credential.
Parlant's four incompatible cells are reported separately rather than being
described as missing credentials.

`adapters.codexAcpSmoke` is a separate opt-in scenario. The baseline config
excludes it unless `RUN_CODEX_ACP_E2E=1`; it requires a local `codex-acp` command.
Its absence is not a pending registry cell, and the scheduled
workflow does not currently opt in. It needs its own explicit coverage decision
under the parent remediation work.

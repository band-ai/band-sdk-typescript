# Band TypeScript SDK Review — v0.1.10 (refreshed)

Review of `packages/sdk/` (`@band-ai/sdk`). Findings originally produced at **v0.1.4** by 9 parallel review agents, each scoped to a slice of the SDK or a cross-cutting concern, against `763734d`.

**Refreshed 2026-08-25 against `main` @ `1eb7bc9` (`@band-ai/sdk@0.1.10`).** See [Refresh log](#refresh-log--v014--v0110) for what changed, which findings moved, and what is new. `dev` is deprecated and was not consulted.

Full per-area findings live in `review/`. This file is the entry point: executive summary, prioritized action list, and per-area links.

### About the lens

Findings were evaluated against two sources:

1. **A code-style preferences guide** — a style document the review was conducted against. It defines opinions on file size, single-responsibility classes, async patterns, error handling, naming conventions, JSDoc usage, type-safety practices, and similar. The guide is **not committed to this repo** — it's an external reference the review used as a lens. Style-based findings (most Majors and Minors) trace back to it.
2. **General TypeScript best practices** — for findings outside the guide's coverage (e.g. peer-dep semver mechanics, npm install behavior, runtime-correctness bugs).

**Correctness bugs (Blockers, several Majors)** are not opinion-based — they're real defects regardless of which style guide you hold the code against. The style-guide lens informs prioritization and framing, not whether the bugs exist.

### What this review covers — and what it doesn't

- **Static analysis of the SDK source tree.** Every file under `packages/sdk/src/` was read. `file:line` references and counts in this review are grounded in direct text searches against the working tree, not estimates.
- **Type-checking.** `tsc --noEmit` was run against the SDK; it passes cleanly with peers installed (zero errors). **Re-run at `1eb7bc9`: still zero errors.**
- **Test suite.** At v0.1.4: all 670 tests across 86 files passed. **Re-run at `1eb7bc9`: 898 tests across 96 files, 871 passing / 23 failing / 4 skipped** — see [Refresh log](#refresh-log--v014--v0110) for the failure triage (22 of 23 are Windows-only test-harness portability bugs; 1 is a genuinely stale assertion on `main`).
- **Lint.** **Re-run at `1eb7bc9`: `eslint .` reports 0 errors, 12 warnings** — including the two dead-import warnings this review flagged (one of which has since been fixed).
- **Verification pass.** Every Blocker, Major, and Minor/Nit finding was independently fact-checked against the current code by a separate set of verification agents before this document was finalized. Counts were re-grepped; cited paths re-confirmed. **The 2026-08-25 refresh re-anchored all 386 `file:line` citations against `1eb7bc9` and re-verified every finding whose cited file changed.**

**Not covered:**
- **Security audit.** No threat modeling, no dependency-vulnerability scan beyond drive-by mentions (e.g., `js-yaml` schema, redaction). Don't infer security review from this document.
- **Runtime / production behavior.** Findings about lifecycle bugs (B2, B3, M11) are correct as static reads, but no test currently exercises the error paths they describe — they're confirmed by code reading, not execution.
- **Performance / load profiling.** A few cache and retry mentions, but no benchmarks or load tests.
- **Examples actually run.** Folder structure verified; `npx tsx ...` against the example entrypoints was not.

> ### How to read this review
>
> This document has **two layers**:
>
> - **This file (`review.md`) is for triage and prioritization.** Each finding below is a short summary — enough to understand what's wrong, why it matters, and roughly how to fix it. Use this layer to scan, plan, and decide what to tackle in what order.
> - **The area files (`review/*.md`) are for actually fixing things.** Every finding here has a `[→ Full detail in review/...]` link to its expanded version, which contains the full reasoning, every cited `file:line`, code excerpts where they clarify, step-by-step fix recommendations, alternatives that were considered and ruled out, and related minor/nit findings on the same theme.
>
> **When you sit down to fix a finding, open the linked area file first.** The main-file summary is intentionally brief and may omit context that matters at implementation time. Don't act from this file alone — follow the link.
>
> Other things to know:
>
> - **Minor findings** in this file are themed only — full lists with file:line live in the area files.
> - Structured artifacts (adapter consistency matrix, type-safety census, coverage map, architecture overview) live only in the area files.
> - Each finding below points to the area file **and the severity section** (Blockers / Major) where the full entry lives.

---

## Executive summary

The SDK is in **mostly good shape**, with isolated correctness bugs concentrated in lifecycle/state code and a clear set of cleanup themes around duplication, naming, file-size discipline, and tsconfig strictness.

What's strong:
- **Optional peer dep handling is uniformly disciplined** across all 15 framework adapters (dynamic `await import(...)`, `UnsupportedFeatureError`, plus an import-boundary test).
- **Type discipline at usage sites is high**: 0 `@ts-ignore`, 0 `as any`, only 5 `any` occurrences (all eslint-disabled with rationale), strong use of discriminated unions and `unknown` at parse boundaries.
- **Logger is well-architected**: DI'd everywhere, `NoopLogger` default, redaction of sensitive keys, no `console.log` leftovers.
- **Phoenix channel cleanup** is paired and centralized; tests cover ~86 files 1:1 with source.

What's weakest:
- A few **lifecycle bugs in `runtime/`** (state stuck after error, abort-controller misuse) that survive only because tests don't exercise the error paths.
- An **ambient declaration file (`src/optional-deps.d.ts`) that erases peer SDK types**, forcing 34 `*Like` shadow interfaces and 55 type-laundering casts. Removing it would eliminate a large fraction of all type-safety findings.
- A **DTO export gap** in the public API: protocol types are exported, but their parameter/return DTOs aren't — custom adapter authors must reach into non-public paths.
- A **root index.ts bug** that exports a runtime class as `export type`, breaking it at runtime under `verbatimModuleSyntax`.
- **Coercion/error-extraction helpers reinvented across modules** — `asErrorMessage` reinvented 33× inline, `sleep` 3×, `assertNever` 3×, ~10 `load*ClientFactory` adapter helpers, plus several smaller duplicates.

Nothing here blocks shipping more 0.1.x releases, but **several items should be cleared before stabilizing a 1.0 API**.

> **Refresh (2026-08-25, main @ `1eb7bc9`) — the assessment above still holds.** Every structural weakness listed is still there: `optional-deps.d.ts` still erases peer types, the DTO export gap is still open (and now wider — `#87` added a whole new unexported `contracts/memory.ts` surface), the root `index.ts` `export type` bug is untouched, and the duplication themes are intact. The lifecycle bugs are also still there, and `#80` made two of them *more* likely to matter rather than less. Two things genuinely improved without anyone acting on this review: the REST-client blocker dissolved when the upstream package caught up, and the streaming layer picked up real disconnect handling plus ~570 lines of new tests. One thing regressed: the error hierarchy drifted further apart, gaining an eighth error class outside `BandSdkError` that is exported from the root entry.
>
> The one new item worth acting on immediately is not a design finding at all — it is a **broken assertion on `main` right now**: `tests/c5-package-symbols.test.ts:420-421` asserts `.release-hold` exists at the repo root, and `1eb7bc9` (the HEAD commit) deleted that file. See [B6](#b6-c5-package-symbolstestts-asserts-a-file-that-head-deleted).

---

## At a glance

Both columns measured with the same greps. **v0.1.4** is the original review (`763734d`); **v0.1.10** is the refresh (`1eb7bc9`).

| Metric | v0.1.4 | v0.1.10 |
| --- | --- | --- |
| Files in `src/` | ~152 | **158** |
| LOC (src) | ~30,300 | **31,315** |
| Public sub-entries | 11 (`.`, `adapters`, `config`, `core`, `converters`, `linear`, `rest`, `runtime`, `testing`, `mcp`, `mcp/claude`) | 11 (unchanged) |
| Optional peer deps | 17 | 17 (all still open-ended `>=`) |
| `any` occurrences | 5 (all eslint-disabled with rationale, only in `src/mcp/`) | 5 (same 5 sites) |
| `as any` | 0 | 0 |
| `@ts-ignore` / `@ts-expect-error` | 0 | 0 |
| `as <Type>` assertions | 133 | **132** |
| `as unknown as` | 15 | **16** |
| `: object` field types | 2 (both in `RestFacade.ts`) | 2 (`RestFacade.ts:396`, `:411`) |
| Bare `throw new Error` | 63 | 63 |
| Files using `core/errors` | 27 | **28** |
| Catches dropping error context | 13 | 13 |
| `console.warn` outside logger | 2 | **3** (`config/loader.ts:35` added) |
| Custom error classes not extending `BandSdkError` | 6 | **7** (`WebSocketDisconnectError` added) |
| Test files | 86 (close to 1:1 with source dirs) | **96** |
| Tests | 670, all passing | **898** — 871 pass, 23 fail, 4 skipped |
| `tsc --noEmit` | clean | clean |
| `eslint .` | not recorded | 0 errors, 12 warnings |
| `@band-ai/rest-client` | `0.0.113` declared / `0.0.112-rc.0` installed | **`0.0.118`, lockfile in agreement** |

---

## Findings count

**199 findings** were recorded at v0.1.4 (5 Blockers, 71 Major, 85 Minor, 38 Nits). **200 are outstanding at v0.1.10** (4 Blockers, 73 Major, 85 Minor, 38 Nits) — 2 resolved, 4 added, 3 re-graded. Each area file has its own `### Blockers / ### Major / ### Minor / ### Nits` breakdown; this table is the rollup. `review.md` (this file) summarizes only the Blockers and Majors — open the linked area file for full Minor/Nit lists.

Resolved and re-graded findings are **kept in place** in the area files, struck through and annotated, rather than deleted — the record of what moved is more useful than a shorter document.

| Area | Blockers | Major | Minor | Nits | Total (v0.1.4 → v0.1.10) |
| --- | ---:| ---:| ---:| ---:| ---:|
| [Public API & exports](review/api.md#public-api-and-exports-review) | 1 | 6 | 6 | 2 | 15 → 15 |
| [Core / Agent / Runtime](review/core-runtime.md#core-agent-and-runtime-review) | 2 | 10 | 18 | 8 | 38 → 38 |
| [Network layer](review/network.md#network-layer-review) | 1 → **0** | 7 → **7** | 9 → **8** | 5 | 22 → **20** |
| [Adapters](review/adapters.md#adapters-layer-review) | 0 | 11 | 10 | 6 | 27 → 27 |
| [Verticals (MCP + Linear)](review/verticals.md#verticals-review-mcp-and-linear) | 0 | 4 | 7 | 3 | 14 → 14 |
| [Type safety](review/type-safety.md#type-safety-review-cross-cutting) | 0 | 5 | 5 | 1 | 11 → 11 |
| [Error / async / cleanup / logging](review/error-async.md#error-handling-async-cleanup-and-logging-review) | 0 | 9 | 7 | 5 | 21 → 21 |
| [Build / tests / docs / examples](review/build-tests-docs.md#build-tests-and-docs-review) | 1 | 10 → **12** | 11 → **12** | 2 | 24 → **27** |
| [Cross-module consistency & architecture](review/cross-module.md#cross-module-consistency-and-architecture-review) | 0 | 9 | 12 | 6 | 27 → 27 |
| **Total** | **5 → 4** | **71 → 73** | **85 → 85** | **38** | **199 → 200** |

---

## Blockers — fix before next release

### B1. Root `index.ts` exports the `HistoryProvider` class inside an `export type` block
*Blocker · Effort: S · `src/index.ts:24`*

> **Refresh (2026-08-25, main @ `1eb7bc9`) — still present, unfixed.** The `export type { ... }` block moved to `src/index.ts:17-28` (the rebrand and `#80`'s new `WebSocketDisconnectError` exports pushed it down); `HistoryProvider` is on `:24` and the class is still at `src/runtime/types.ts:49`. `verbatimModuleSyntax` is still on (`tsconfig.json:14`).

**Problem** — `HistoryProvider` is a class (`export class HistoryProvider { ... }` at `src/runtime/types.ts:49`), but `index.ts:24` re-exports it inside the `export type { ... }` block at `index.ts:17-28`. With `verbatimModuleSyntax: true` set in `tsconfig.json`, TypeScript strips everything in that block from the emitted JavaScript — including the class.

**Impact** — Consumers doing `import { HistoryProvider } from "@band-ai/sdk"` get `undefined` and crash on `new HistoryProvider()`. The `./runtime` sub-entry exports it correctly, but root is the documented entry.

**Fix** — Move `HistoryProvider` out of the `export type { ... }` block into the regular runtime `export { ... }` block in `src/index.ts`.

[→ Full detail in review/api.md](review/api.md#historyprovider-class-exported-as-type-from-root-entry)

### B2. `PlatformRuntime.stop()` permanently sets `this.stopping` to true on error paths
*Blocker · Effort: S · `src/runtime/PlatformRuntime.ts:222-268`*

> **Refresh (2026-08-25, main @ `1eb7bc9`) — still present, unfixed, same lines.** `PlatformRuntime.ts` was touched only by the rebrand; `stop()` is still `:222-268`, `this.stopping = true` still on `:233`, and `this.stopping = false` still only on the success path at `:266`. Both throw sites (`:259` adapter-cleanup, `:263` runtime-error rethrow) still skip the reset.

**Problem** — `stop()` sets `this.stopping = true` early and only resets it on the success path. Any thrown error during cleanup leaves the flag stuck.

**Impact** — Every subsequent `stop()` call silently no-ops (returns `true`) even though state is already cleared. Invisible in tests because the happy path always succeeds.

**Fix** — Wrap the body in `try { ... } finally { this.stopping = false; }`. Long-term, model the lifecycle as a discriminated union — see M1.

[→ Full detail in review/core-runtime.md](review/core-runtime.md#platformruntimestop-leaves-stoppingtrue-on-every-error-path)

### B3. `AgentRuntime.start()` aborts the field-init `AbortController` on every entry
*Blocker · Effort: M · `src/runtime/rooms/AgentRuntime.ts:80-124`*

> **Refresh (2026-08-25, main @ `1eb7bc9`) — still present, unfixed, same lines.** `#80` reworked `AgentRuntime` around it (the file grew 438 → 464 lines, `stop()` now accepts a post-`fatalError` entry, and a new `failRuntime`/`syntheticRuntimeFailureEvent` pair was added at `:410-425` / `:444-460`) but `start()` itself is byte-identical: field init on `:52`, abort-and-replace on `:88-91`, `consumeLoop` launched with the fresh signal on `:113`. One precision fix to the area-file wording: the abort on `:88-90` is **guarded** by `if (!this.stopController.signal.aborted)`, not unconditional. That does not change the finding — on the first `start()` the field-init controller is unaborted, so the guard passes and it is aborted on arrival exactly as described.

**Problem** — The class field `private stopController = new AbortController()` (line 52) is aborted at lines 88-91 on the first `start()` and replaced — the field-init controller is dead on arrival. Re-entry is guarded by `if (this.running) return`, so this fires only on the first call.

**Impact** — A correctness landmine. The state machine around `running` / `stopping` / `stopController` is brittle — the lifecycle isn't clearly owned, which is what produces B2-style bugs.

**Fix** — Make `start()` idempotent or reject re-entry explicitly; lazily allocate the controller inside `start()` rather than at field-init; use a discriminated-union state.

[→ Full detail in review/core-runtime.md](review/core-runtime.md#agentruntimestart-re-entry-uses-a-stale-aborted-controller-for-the-consume-loop-signal)

### ~~B4. `FernBandClientLike` interface mismatches the installed `@band-ai/rest-client`~~ — RESOLVED, downgraded to Major
*Was Blocker · now Major · `src/client/rest/types.ts:233` (interface); `src/platform/BandLink.ts:125` (cast)*

> **Refresh (2026-08-25, main @ `1eb7bc9`) — no longer a Blocker.** The SDK code did not change; the dependency did. `@band-ai/rest-client` moved from a `0.0.113`-declared/`0.0.112-rc.0`-installed mismatch to a clean `0.0.118` pin that matches the lockfile, and `0.0.118` exposes the whole `agentApi*` namespace family the finding said was phantom. Every REST operation in `FernRestAdapter` now resolves to a real upstream method, so the "~12 REST methods unreachable, `UnsupportedFeatureError` at runtime" impact is gone. What remains is the mirror image: nine **legacy** namespaces still declared on `FernBandClientLike` and still probed as the *first* branch of thirteen `??` chains, where they now always evaluate to `undefined`. Dead code plus an unverified hand-rolled interface — a Major cleanup, not a release blocker.

[→ Full analysis, the nine dead namespaces, and the fix in review/network.md](review/network.md#fernbandclientlike-keeps-nine-namespaces-the-installed-band-airest-client-does-not-have)

### B5. `zod 3` vs `zod 4` peer conflict blocks Claude-adapter consumers and the SDK's own dev env
*Blocker · Effort: M · `packages/sdk/package.json:95` (`zod`), `:101, :172` (`@anthropic-ai/claude-agent-sdk`)*

> **Refresh (2026-08-25, main @ `1eb7bc9`) — still present, unfixed, same lines.** All three cited lines are unchanged: `zod: "^3.24.2"` on `package.json:95`, the `@anthropic-ai/claude-agent-sdk` peer range `">=0.2.63"` on `:101`, the dev range `"^0.2.63"` on `:172`. The peer-vs-dev range contradiction is also unchanged. Note the overrides moved: the workspace's pnpm `overrides` block now lives in `pnpm-workspace.yaml` rather than root `package.json` (pnpm 10 layout), and it still contains **no** `zod` entry — consistent with the finding's point that an override would not help consumers anyway. Separately, the open-ended-`>=`-peer audit recommended in the area file is still outstanding: **17 of 17** optional peers use `>=`.

**Problem** — The SDK pins `zod@^3.24.2`, but every published version of `@anthropic-ai/claude-agent-sdk` (which is in `devDependencies` and an optional peer) requires `zod@^4.0.0`. When both end up in the same tree, npm 7+ refuses with `ERESOLVE`.

**Impact** — Conditional, not universal: npm-only consumers using the Claude SDK adapter are blocked; SDK contributors running `npm install` are blocked; pnpm users are unaffected. The breakdown by scenario (empty folder, Claude adapter, dev env, pnpm) and the `0.x`-semver mechanism that made the bug latent are in the area file.

**Fix** — Bump the SDK's `zod` to `^4.0.0` and migrate code through the zod 3 → 4 API changes. There is no zod-3-compatible version of `claude-agent-sdk` to downgrade to, and `0.3.x` keeps the same zod peer. Full reasoning + alternatives explored + step-by-step fix in the area file.

[→ Full detail in review/build-tests-docs.md](review/build-tests-docs.md#npm-install-fails-with-eresolve-on-a-zod-peer-conflict-sdk-dev-env-and-claude-adapter-consumers)

### B6. `c5-package-symbols.test.ts` asserts a file that HEAD deleted
*New at v0.1.10 · Blocker-adjacent · Effort: S · `packages/sdk/tests/c5-package-symbols.test.ts:420-421`*

**Problem** — The test `".release-hold marker exists at the repository root"` asserts `existsSync(join(REPO_ROOT, ".release-hold"))` is `true`. Commit `1eb7bc9` — the current HEAD, *"chore: remove stale `.release-hold` from the Band rebrand"* — deleted that file and did not update the assertion. The test fails on `main` today with `expected false to be true`.

**Impact** — `main` has a red test. Whatever gate this assertion was guarding (the release-hold half of the rebrand's release-pipeline controls) is now guarding nothing, and the failure will mask any *real* regression that lands in the same file. Either the marker was meant to stay and its deletion was wrong, or it was correctly deleted and the assertion is dead — the two commits disagree and nothing in the tree says which is intended.

**Fix** — Decide which side is right. If removing the hold was correct, delete the assertion (and the surrounding `P-C5-3` expectation about the hold being present) in the same change. If the hold is still required for the release pipeline, restore `.release-hold` and record in the test *why* it must exist, so the next cleanup pass does not delete it again.

**Graded Blocker-adjacent, not Blocker** — it does not break the published package or any consumer; it breaks CI signal. It is listed here rather than as a Major because a red `main` invalidates the "all tests pass" premise the rest of this review's verification relies on.

[→ Refresh log entry, with the full failure triage](#refresh-log--v014--v0110)

---

## Major — fix before stabilizing the API

Grouped by theme rather than by area. **Effort** tags: **S** = under a day, **M** = 1–3 days, **L** = a week or more (often coordinated across files/teams).

### M1. Lifecycle modeled as ad-hoc booleans instead of discriminated unions
*Major · Effort: M · `Agent`, `PlatformRuntime`, `AgentRuntime`, `Execution`*

**Problem** — Each class models lifecycle as 1–2 independent booleans plus ancillary state: `Agent` (`started` + `startPromise`), `PlatformRuntime` (`stopping`), `AgentRuntime` (`running`, `stopping`, plus a `stopController`/`consumeTask` pair), `Execution` (`running`, `syncComplete`).

**Impact** — Independent booleans admit impossible state combinations. Directly causes B2 (stuck `stopping` flag) and B3 (controller misuse), plus several smaller bugs.

**Fix** — Replace each ad-hoc boolean pair with a discriminated-union state per the code-style preferences guide's state-machine recommendation.

[→ Full detail in review/core-runtime.md](review/core-runtime.md#lifecycle-expressed-as-2-4-independent-booleans-across-agentplatformruntimeagentruntimeexecution)

### M2. `src/optional-deps.d.ts` erases peer SDK types at build time
*Major · Effort: S (mechanical, high ROI) · `src/optional-deps.d.ts`*

**Problem** — Distinct from `peerDependencies` (which is correctly configured for install/runtime). M2 is about type-checking the SDK's own source. The workaround `src/optional-deps.d.ts` declares 12 body-less ambient modules — `declare module "@anthropic-ai/sdk";` and similar — which tell TypeScript "this module exists, treat all imports from it as `any`". The substantive harm is visible in the SDK's source today: 34 hand-rolled `*Like` shadow interfaces and 55 `as Record<string, unknown>` casts in adapters exist precisely because the ambient declarations erase the real upstream types. None of that code would be needed if the SDK `import type`'d against the installed peers directly.

**Impact** — Root cause of 34 hand-written `*Like` shadow interfaces and 55 `as Record<string, unknown>` casts in adapters. Upstream SDK shape changes break the SDK at runtime instead of build time.

**Fix** — Add the peers to `devDependencies` *in addition to* the existing `peerDependencies` entries (consumer install behavior is unchanged), delete `optional-deps.d.ts`, and let adapter code `import type` directly. `CodexAdapter` + `@openai/codex-sdk` is the working pattern already in the codebase.

[→ Cascade detail + fix code in review/type-safety.md](review/type-safety.md#ambient-declare-module-erases-all-upstream-types-for-8-peer-sdks) · [→ `*Like` inventory in review/adapters.md](review/adapters.md#optional-depsdts-empty-module-declarations-silently-widen-types)

### M3. `tsconfig.json` missing several strict flags
*Major · Effort: S (flag flip) + M (resulting cleanup) · `packages/sdk/tsconfig.json`*

**Problem** — Five strict flags enabled in sibling `packages/openclaw/tsconfig.json` are missing from the SDK's tsconfig: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. A sixth (`noImplicitOverride`) is worth adding but isn't set on either package — project-wide gap, not a divergence. Per-flag explanations of what each catches and why it matters are in the area file.

**Impact** — Real correctness wins go uncaught — array/object-index access without undefined-checking, dead parameters, missing return paths, fall-through `case` statements, silent inheritance breakage. Inconsistency with the sibling package makes the SDK feel under-tightened.

**Fix** — Mirror the five flags from `packages/openclaw/tsconfig.json` and add `noImplicitOverride`. Expect a wave of new errors at array/object-index sites in particular (`noUncheckedIndexedAccess` is the loudest); treat them as a finding-discovery pass.

[→ Full detail in review/type-safety.md](review/type-safety.md#tsconfigjson-strict-mode-flags-inconsistent-with-sibling-package) · [→ Build/docs context in review/build-tests-docs.md](review/build-tests-docs.md#tsconfigjson-does-not-enable-nouncheckedindexedaccess-or-noimplicitoverride)

### M4. Public-API DTO/protocol types not re-exported from sub-entries
*Major · Effort: S · `src/core/index.ts`, `src/index.ts`*

**Problem** — `AdapterToolsProtocol`, `FrameworkAdapter`, `Preprocessor`, and friends are exported, but their parameter/return types (`MetadataMap`, `MentionInput`, `ParticipantRecord`, `ContactRecord`, `MemoryRecord`, `ToolOperationResult`, `PaginatedList`, `ToolSchemaRecord`, `HistoryLike`, `PreprocessorContext`, `EventEnvelope`, `PlatformMessageLike`, `AgentToolsCapabilities`) live in `contracts/` and aren't reachable from any public sub-entry.

**Impact** — Anyone writing a custom adapter has to reach into non-public `src/contracts/` paths to name the types of methods they're implementing.

**Fix** — Re-export the DTO types from `src/core/index.ts` (and where relevant from `src/index.ts`).

[→ Full detail in review/api.md](review/api.md#core-dto-types-are-referenced-by-public-protocols-but-not-exported-anywhere)

### M5. God-files and god-classes
*Major · Effort: L · `adapters/codex/`, `integrations/linear/bridge/`, `runtime/tools/`, `adapters/letta/`*

**Problem** — Files >1000 LOC: `adapters/codex/CodexAdapter.ts` (1479), `integrations/linear/bridge/handler.ts` (1326), `adapters/opencode/OpencodeAdapter.ts` (1094), `runtime/tools/AgentTools.ts` (1157), `adapters/letta/LettaAdapter.ts` (1111). Classes mixing 6+ responsibilities: `ContactEventHandler` (461), `ExecutionContext` (384), `Execution` (362), `AgentRuntime` (464).

> **Refresh (2026-08-25, main @ `1eb7bc9`) — unchanged in substance; counts re-measured.** Net movement is negligible and in both directions. `AgentTools.ts` came *down* 1176 → 1157 because `#87` moved the memory-taxonomy enums out into the new `src/contracts/memory.ts` (129 lines) — the only real decomposition in the set. `AgentRuntime.ts` went *up* 438 → 464 (`#80`'s failure handling), `CodexAdapter.ts` 1477 → 1479 and `OpencodeAdapter.ts` 1092 → 1094 (one import line each from `#87`). `handler.ts`, `LettaAdapter.ts`, `ContactEventHandler.ts`, `ExecutionContext.ts`, and `Execution.ts` are byte-identical apart from the rebrand. Five files are still over 1000 LOC and total `src/` grew 30,300 → 31,315 across 152 → 158 files.

**Impact** — Hard to navigate, hard to test in isolation, refactors are high-risk. Runs counter to the code-style preferences guide's guidance on file size and single-responsibility classes.

**Fix** — Split each god-file by responsibility — orchestration vs. formatting vs. caching vs. persistence — into separate files under the same folder. Pull-quote each class's distinct concerns and extract.

[→ God-files list in review/cross-module.md](review/cross-module.md#five-god-files-1000-loc-that-mix-many-concerns) · [→ Runtime god-classes in review/core-runtime.md](review/core-runtime.md#contacteventhandler-is-a-god-class-mixing-6-concerns)

### M6. Coercion and error-extraction helpers duplicated across the tree
*Major · Effort: M · tree-wide*

**Problem** — Nine distinct helpers reinvented across modules. Each bullet links to the area file holding the full inventory:
- `asErrorMessage` exists in `core/errors.ts` but the inline pattern `error instanceof Error ? error.message : String(error)` is reinvented **33×** across the tree. → [`error-async.md`](review/error-async.md#no-central-safe-message-extraction-util-duplicated-and-inline-reinvented-33-times)
- ~10 `load*ClientFactory` / `load*Sdk` boilerplate copies across adapters. → [`adapters.md`](review/adapters.md#loadxclientfactory-is-reinvented-per-adapter)
- Per-room session bookkeeping reimplemented in 6 adapters. → [`adapters.md`](review/adapters.md#per-room-session-bookkeeping-is-reimplemented-in-six-adapters)
- `selectCompleteExchanges` duplicated between `LettaAdapter` and `ParlantAdapter`, **and the Parlant copy is buggier** — silently drops unpaired user messages where Letta merges them, producing real data-loss in multi-participant rooms. → [`adapters.md`](review/adapters.md#verbatim-duplication-between-letta-and-parlant) (with side-by-side excerpt)
- 3 `sleep()` helpers, 3 `assertNever`, 2 `serializeError`, 2 `asNonEmptyString`, 3 `registerTools`. → [`cross-module.md`](review/cross-module.md#coercion-and-error-message-helpers-are-duplicated-across-modules)

**Impact** — Maintenance burden, plus at least one real silent data-loss bug (Parlant `selectCompleteExchanges`). Future helper fixes need to be applied N times.

**Fix** — Move `adapters/shared/coercion.ts` out of the adapter-named folder into `core/utils/` (or top-level `utils/`), export `asErrorMessage`/`serializeError`/`asNonEmptyString` from there, replace inline reinventions. Replace Parlant's `selectCompleteExchanges` with Letta's merging version.

[→ Helper inventory in review/cross-module.md](review/cross-module.md#coercion-and-error-message-helpers-are-duplicated-across-modules) · [→ Adapter-side helpers in review/adapters.md](review/adapters.md#loadxclientfactory-is-reinvented-per-adapter) · [→ Error-extraction detail in review/error-async.md](review/error-async.md#no-central-safe-message-extraction-util-duplicated-and-inline-reinvented-33-times)

### M7. Vertical leak: `CodexAdapter` reads Linear metadata directly
*Major · Effort: S · `src/adapters/codex/CodexAdapter.ts:190-221`*

**Problem** — `CodexAdapter` reads `linear_session_id`, `linear_issue_id`, `linear_reset_room_session` directly off the message metadata. No feature flag, no abstraction.

**Impact** — Couples a generic framework adapter to a specific vertical (Linear). Runs counter to the design principle that vertical integrations must not leak into adapters; the same pattern in other adapters would multiply the coupling fast.

**Fix** — Either route Linear-specific metadata through a `MetadataProvider` abstraction the adapter consumes, or move the Linear-aware code paths out of `CodexAdapter` into a Codex+Linear bridge module.

[→ Full detail in review/verticals.md](review/verticals.md#codexadapter-reads-linear-specific-metadata-keys)

### M8. Error-handling consistency
*Major · Effort: M · tree-wide*

**Problem** — Four related inconsistencies:
- 63 bare `throw new Error` vs ~150 typed throws.
- **7** custom error classes (`CodexJsonRpcError`, `HttpStatusError`, `ContactEventHandlerError`, `CustomToolDefinitionError`/`Validation`/`Execution`, and — new since v0.1.4 — `WebSocketDisconnectError`) don't extend `BandSdkError` — breaks `instanceof BandSdkError` at the SDK boundary.
- REST layer throws raw `Error` for response validation instead of `ValidationError` / `TransportError`.
- 13 catches drop error context — some don't log at all, others log without capturing the error variable in the payload. Per-site list in the area file.
- **3** `console.warn` calls outside the logger: `integrations/linear/activities.ts:214`, `integrations/linear/store.ts:397`, and — new since v0.1.4 — `config/loader.ts:35`.

**Impact** — Consumers can't reliably catch SDK errors with one type guard. Lost error context makes failures hard to diagnose in production. Inconsistent throws mean future error-translation work multiplies.

**Fix** — Bring the 7 stray classes under `BandSdkError`. Convert REST validation throws to `ValidationError` / `TransportError`. Capture the error variable in every cited silent catch. Replace the 3 `console.warn` calls with the injected logger.

> **Refresh (2026-08-25, main @ `1eb7bc9`) — regressed slightly.** Two counts moved the wrong way. `#80` added `WebSocketDisconnectError` (`src/platform/streaming/disconnectReason.ts:112`) extending bare `Error`, taking the outside-hierarchy class count 6 → 7 — and unlike the other six this one is exported from **both** the root entry (`src/index.ts:6`) and `./core` (`src/core/index.ts:25`), so it is the most consumer-visible violation of the `instanceof BandSdkError` contract in the SDK. The rebrand added a third out-of-logger `console.warn` at `config/loader.ts:35`, warning on deprecated legacy env-var names. Bare `throw new Error` holds at exactly 63.

[→ Full detail in review/error-async.md](review/error-async.md#major)

### M9. `AbortSignal` not plumbed through REST
*Major · Effort: M · `src/client/rest/requestOptions.ts:1`*

**Problem** — `RestRequestOptions` exposes only `{ maxRetries?, timeoutInSeconds?, headers? }` — no `abortSignal`. The upstream `BaseRequestOptions` (`@band-ai/rest-client`) supports `abortSignal?: AbortSignal` and `queryParams`; the SDK wrapper drops both at the type boundary.

**Impact** — REST calls can't be cancelled. The rate-limit retry loop in `withRateLimitRetry` can `sleep` ~16s ignoring any caller signal. The streaming side has `AbortSignal` plumbing — the asymmetry is the surface bug.

**Fix** — Add `abortSignal?: AbortSignal` to `RestRequestOptions`, forward through `mergeOptions`, and honor it in `withRateLimitRetry`'s `sleep`. Consider adopting `BaseRequestOptions` directly to inherit future fields automatically.

[→ Full detail in review/network.md](review/network.md#restrequestoptions-drops-abortsignal-from-the-underlying-client) · [→ Async-rule context in review/error-async.md](review/error-async.md#abortsignal-not-plumbed-through-bandlink-or-restapi)

### M10. `phoenix.d.ts` ambient is too narrow
*Major · Effort: S · `src/phoenix.d.ts`, `src/platform/streaming/PhoenixChannelsTransport.ts:459-471`*

**Context** — The `phoenix` npm package ships JavaScript without bundled TypeScript types, which is why the SDK has a hand-rolled `phoenix.d.ts`. A community-maintained `@types/phoenix` package exists on DefinitelyTyped but the SDK does **not** depend on it.

**Problem** — The hand-rolled ambient declaration for the Phoenix `Socket` omits `channels`, `remove(channel)`, and the CloseEvent fields that the real library exposes. The SDK uses those anyway, via unsafe `as unknown as` casts.

**Impact** — Unsafe casts hide real type information; a future Phoenix upgrade can break the SDK silently. Two of the SDK's 15 `as unknown as` occurrences come from this single ambient gap.

**Open question to decide before fixing** — Should the SDK adopt `@types/phoenix` instead of maintaining its own ambient? A direct inspection of `@types/phoenix@1.6.7` confirms it covers 2 of the 3 specific gaps M10 calls out (`Socket.remove` and `Socket.onClose(event: CloseEvent)`) correctly, plus full typing for `Push`, `Channel.push()`, `Channel.state`, `Presence`, and several other classes the hand-rolled ambient skips entirely. The only gap shared by both is `Socket.channels`, which can be patched with a 3-line ambient extension.

**Fix — two options:**
1. **Switch to `@types/phoenix` + a small extension** (recommended). Inherits ongoing maintenance from DefinitelyTyped. Code snippet for the 3-line extension is in the area file.
2. **Broaden the existing hand-rolled ambient** to cover the missing surface. Lower one-time cost, but the SDK keeps owning the ambient forever — and currently only types a fraction of Phoenix's surface.

Then drop the `as unknown as` casts in `PhoenixChannelsTransport.ts:460` and `:465`.

> **Refresh (2026-08-25, main @ `1eb7bc9`) — unchanged; `phoenix.d.ts` is byte-identical (still 32 lines, still no `channels`/`remove`/CloseEvent payload).** `#80` moved the two casts into named helpers `removeSocketChannel` (`:459-462`) and `getSocketChannelCount` (`:464-471`). The gap is now slightly wider than at v0.1.4: the `onClose` callback registered at `:92` is typed `(event?: { code?: number; reason?: string }) => void` and `recordSocketClose` (`:369-387`) derives a `platformReason` from that undeclared payload, so more behaviour now depends on what the ambient does not describe.

[→ Full detail in review/network.md](review/network.md#phoenixdts-ambient-narrows-behaviour-the-sdk-depends-on) · [→ Cast inventory in review/type-safety.md](review/type-safety.md#major)

### M11. Cleanup uses `Promise.all` where `allSettled` is needed
*Major · Effort: S · `src/mcp/server.ts:171, 257`, `src/mcp/sse.ts:153`, `src/runtime/rooms/AgentRuntime.ts:153-184`*

**Problem** — MCP cleanup at `mcp/server.ts:171`, `:258` and `mcp/sse.ts:153` uses `Promise.all` — one failure aborts the rest. `AgentRuntime.stop()` runs cleanup in unguarded `for...of` loops (`leaveTrackedRoom` `:163`, `onSessionCleanup` `:167`, `unsubscribeAgentContacts` `:176`, `link.disconnect()` `:179`); the `fatalError` rethrow at `rooms/AgentRuntime.ts:180-182` is bypassed if any prior await throws.

> **Refresh (2026-08-25, main @ `1eb7bc9`) — still present and now more consequential.** All three MCP `Promise.all` cleanup sites survive (`mcp/server.ts:171`, `:258`, `mcp/sse.ts:153`); the only change to those files was the rebrand plus a shared `MCP_SERVER_NAME` import. `AgentRuntime.stop()` is still a chain of unguarded awaits, and `#80` raised the stakes: `stop()` may now be entered *because* of a `fatalError` (the guard changed from `!this.running || this.stopping` to `this.stopping || (!this.running && !this.fatalError)` on `:138`), so the rethrow at `:180-182` is exactly what a caller is waiting on to learn why the runtime died — and it is still the one thing skipped when any earlier cleanup await throws. `#80` also threaded a per-room timeout budget through the loop (`:162-163`), which adds a second reason an await here can now fail.

**Impact** — Partial cleanup on shutdown — channels and sessions can be left in inconsistent state. `fatalError` is silently dropped on error paths, so the actual root cause never surfaces to callers.

**Fix** — Switch the MCP cleanup `Promise.all` calls to `Promise.allSettled`. In `AgentRuntime.stop()`, wrap each cleanup await in a try/catch that accumulates errors and rethrows after the loop completes, preserving `fatalError`.

[→ Async-rule detail in review/error-async.md](review/error-async.md#promiseall-used-for-cleanup-one-failure-leaks-the-rest) · [→ Runtime-side detail in review/core-runtime.md](review/core-runtime.md#agentruntimestop-swallows-fatalerror-if-cleanup-throws)

### M12. Callback type naming convention not followed
*Major · Effort: S · `src/runtime/types.ts:23`, `src/runtime/rooms/AgentRuntime.ts:15-22`, others*

**Problem** — The project's convention is `On{Action}Callback` (e.g. `OnRoomDeletedCallback`). **Zero of the 8 callback-typed declarations in `runtime/` use it** — `ContactEventCallback`, `MessageHandler`, `ExecutionHandler`, 4× `RoomPresence*Handler`, `ToolHandler`. The `AgentRuntimeOptions` callbacks are inlined function shapes rather than named types, and `GenericAdapter`'s exported callback is `GenericAdapterHandler` instead of `OnMessageCallback`.

**Impact** — Inconsistent surface for consumers; harder to grep for callback wiring. The convention exists to make callback boundaries findable; with it broken, that benefit is lost.

**Fix** — Rename `ContactEventCallback` → `OnContactEventCallback`, extract the inlined callbacks in `AgentRuntimeOptions` into named `On*Callback` types, rename `GenericAdapterHandler` → `OnMessageCallback` (keep an alias for one release if backwards compat matters).

[→ API-surface examples in review/api.md](review/api.md#contacteventcallback-violates-callback-naming-convention) · [→ Full inventory in review/cross-module.md](review/cross-module.md#onactioncallback-naming-convention-not-followed-for-callback-types)

### M13. `adapters/shared/` and `converters/` boundary leaks both ways
*Major · Effort: M · `src/converters/`, `src/adapters/shared/`, `src/adapters/GenericAdapter.ts`*

**Problem** — Two-way boundary leak plus misleading naming:
- `converters/index.ts:22, :34, :40` re-exports from `adapters/a2a`, `adapters/a2a-gateway`, `adapters/parlant` — a "converters" barrel reaches upward into specific adapter implementations.
- `converters/codex.ts`, `opencode.ts`, `claude-sdk.ts`, `google-adk.ts` import from `adapters/shared/history.ts` — even though `shared/` is named to suggest it's adapter-internal.
- Three "base" patterns coexist (`SimpleAdapter`, `ToolCallingAdapter`, `GenericAdapter`) but no built-in framework adapter extends `GenericAdapter` — it's actually a public-API helper used by `examples/basic/basic-agent.ts`, not a base class for the built-ins. Full breakdown of which adapter extends what in the [area file](review/adapters.md#genericadapter-does-not-generalise-the-other-15-adapters).

**Impact** — Folder names mislead readers about ownership boundaries. New contributors don't know where shared utilities should live. Two simultaneous responsibilities for `adapters/shared/` (adapter-internal + cross-module utility) makes either job worse.

**Fix** — Rename `adapters/shared/` → `core/utils/` (or hoist to top-level `utils/`). Inline the three adapter re-exports in `converters/index.ts` into the adapter barrels themselves so `converters/` stops reaching upward. Rename `GenericAdapter` → `HandlerAdapter` (or similar) to make its consumer-helper role honest.

[→ Boundary detail in review/cross-module.md](review/cross-module.md#boundary-between-converters-and-adapters-is-fuzzy) · [→ Adapter-base discussion in review/adapters.md](review/adapters.md#genericadapter-does-not-generalise-the-other-15-adapters)

### M14. JSDoc missing on public API surface
*Major · Effort: L (judgment-heavy) · adapters/, contracts/, core/errors.ts, runtime types*

**Problem** — Across 22 public-API surface files (adapters, options interfaces, error classes in `core/errors.ts`, `Logger`, runtime types, `CustomToolDef`, `contracts/protocols.ts`), **19 have zero JSDoc blocks**. Only `CodexAdapter` (1 block), `LettaAdapter` (3), and `contracts/protocols.ts` (4 blocks across 26 exports) have any JSDoc at all — and each documents a fraction of its surface. `Agent` and `SimpleAdapter` are the only consistently-documented public types.

**Impact** — SDK consumers (especially custom adapter authors) don't get inline hover docs in their IDE for the public surface. Onboarding cost is higher than it needs to be.

**Fix** — Add JSDoc to every exported declaration on the listed surfaces, starting with `contracts/protocols.ts` (the most consumer-facing) and the error classes (`core/errors.ts`).

[→ Per-file list in review/build-tests-docs.md](review/build-tests-docs.md#missing-jsdoc-on-most-public-adapter-classes-and-options-interfaces)

### M15. Documentation drift
*Major · Effort: S · README.md, examples/README.md, CHANGELOG.md (root + SDK), package.json*

**Problem** — Four independent drift issues:
- `packages/sdk/examples/README.md` references a non-existent `dog-landing-page/`.
- Root `README.md` "Examples" table omits `letta/`; "Subpath Exports" table omits `@band-ai/sdk/converters`.
- `packages/sdk/CHANGELOG.md` has duplicate `0.1.1` / `0.1.2` / `0.1.3` entries all pointing at the same PR; stops at `0.1.4` despite ~20 feature commits since.
- Root `/CHANGELOG.md` is also stale; `engines` mismatch (root `>=22.14.0`, SDK `>=22.12`).

**Impact** — Anyone landing on the SDK from npm or GitHub gets stale or wrong instructions. The undocumented `letta/` example and `converters` sub-entry are invisible to new users.

**Fix** — Drop the `dog-landing-page/` bullet from `examples/README.md`; add `letta/` to the Examples table and `@band-ai/sdk/converters` to the Subpath Exports table; consolidate the duplicate CHANGELOG entries and bring it up to date; align `engines` between root and SDK.

[→ Per-issue detail in review/build-tests-docs.md](review/build-tests-docs.md#major)

### M16. Dead code in `src/mcp/claude.ts`
*Major · Effort: S · `src/mcp/claude.ts`, `tsup.config.ts:41`*

**Problem** — `src/mcp/claude.ts` is a 7-line file re-exporting symbols already exported from `mcp/index.ts`. The `./mcp/claude` sub-entry built by tsup actually comes from `src/mcp/sdk.ts` (`tsup.config.ts:41`), not from `claude.ts`. The redirect file is also incomplete — missing `GetSystemPromptContextOptions`.

**Impact** — Confusing for anyone navigating the source: the file name suggests it's the `./mcp/claude` implementation, but it's neither used nor reached.

**Fix** — Delete `src/mcp/claude.ts`. Either delete the `./mcp/claude` sub-entry too if it's redundant, or rename `src/mcp/sdk.ts` → `src/mcp/claude.ts` so the file name matches the sub-entry it serves.

[→ Public-API perspective in review/api.md](review/api.md#srcmcpclaudets-is-dead-code) · [→ MCP/verticals context in review/verticals.md](review/verticals.md#mcpclaude-sub-entry-is-an-arbitrary-7-line-redirect)

### M17. `mcp/sdk.ts` mixes MCP plumbing with a 200-line `getSystemPromptContext` feature
*Major · Effort: S · `src/mcp/sdk.ts` (363 LOC total)*

**Problem** — Lines 1-70 of `mcp/sdk.ts` handle MCP server registration; lines 83-246 implement an unrelated `getSystemPromptContext` feature with its own LRU cache, eviction logic, and duck-typing of `AdapterToolsProtocol` to access `getAgentIdentity` (lines 225-228). Two concerns sharing a file by accident.

**Impact** — `mcp/sdk.ts` becomes a god-file in miniature; testing either concern requires loading the other; the duck-type cast on `AdapterToolsProtocol` hides what should be a real interface member.

**Fix** — Extract the system-prompt-context feature to `mcp/systemPromptContext.ts`. Add `getAgentIdentity()` to `AdapterToolsProtocol` as a real method so the duck-type cast can disappear.

[→ Full detail in review/verticals.md](review/verticals.md#sdkts-mixes-mcp-plumbing-and-a-200-line-system-prompt-context-feature)

### M18. `tsup.config.ts` `external` misses 4 peer deps
*Major · Effort: S · `packages/sdk/tsup.config.ts:3-26`*

**Problem** — The `external` array doesn't list `@google/adk`, `@letta-ai/letta-client`, `@langchain/core`, or `@langchain/langgraph` at the package root — only their `/prebuilt` and `/tools` sub-paths are present.

**Impact** — A consumer who doesn't install these peers can trigger a force-bundle of dependent code into the SDK's dist output, breaking the build or producing wrong runtime behavior.

**Fix** — Add `@google/adk`, `@letta-ai/letta-client`, `@langchain/core`, `@langchain/langgraph` (root names) to the `external` array in `tsup.config.ts`.

[→ Full detail in review/api.md](review/api.md#optional-peer-dependencies-not-all-externalized-in-tsup-config)

### M19. `ParticipantTracker` and `RoomPresence` are unused parallel implementations
*Major · Effort: S · `src/runtime/participantTracker.ts`, `src/runtime/rooms/RoomPresence.ts`*

**Problem** — `ParticipantTracker` is exported from `runtime/index.ts` but never imported anywhere in `src/` outside the barrel — only test files reference it. It duplicates the participant-tracking logic in `ExecutionContext`. `RoomPresence` is a parallel implementation of `AgentRuntime`'s room-event loop, also not used internally.

**Impact** — Dead code in the public API surface; future maintainers waste time wondering which version is canonical.

**Fix** — Delete both files and their barrel exports unless they're slated for an upcoming use case. If they're meant to replace `ExecutionContext` / `AgentRuntime` portions, finish that migration; if not, remove them.

[→ ParticipantTracker detail in review/core-runtime.md](review/core-runtime.md#participanttracker-is-exported-and-duplicates-executioncontexts-participant-logic) · [→ RoomPresence detail in review/cross-module.md](review/cross-module.md#roompresence-reimplements-agentruntimes-room-event-loop-and-is-unused-internally)

### M20. `object` type used in `RestFacade.ts`
*Major · Effort: S · `src/client/rest/RestFacade.ts:396, :411`*

**Problem** — Two parameter annotations use the bare `object` type, then immediately recast to a more specific shape inside the function body.

**Impact** — `object` is flagged by the code-style preferences guide as an anti-pattern: it allows any non-null object (including arrays, dates, etc.) without giving consumers any useful type information.

**Fix** — Replace `: object` with `Record<string, unknown>` (the code-style preferences guide's recommended escape hatch) or, better, the specific shape the function actually expects.

[→ Full detail in review/type-safety.md](review/type-safety.md#-object-type-used-in-private-rest-facade-methods)

---

## Top minor / cleanup themes (not exhaustive)

Pulled from across the 9 area reports. **Full lists with file:line live in the area files** — see the Minor and Nits sections in each.

- **`waitForConnection`** uses manual `setTimeout` + `reject` instead of `Promise.race`; timer not cleared on reject. → [review/network.md](review/network.md#connect-timeout-uses-manual-settimeout-instead-of-promiserace)
- **`onHandlerError`** field declared but never wired in `PhoenixChannelsTransport.ts:24`. → [review/network.md](review/network.md#onhandlererror-is-declared-but-never-wired-up)
- **`ws` polyfill** no longer needed on Node ≥22.12 (native WebSocket). → [review/network.md](review/network.md#optional-ws-dependency-typing--obsolete-the-recommendation-is-now-wrong)
- **`simpleAdapter.ts` is misplaced** in `core/` (used only by `adapters/`); `isDirectExecution.ts` is single-line glue used only by examples. → [review/core-runtime.md](review/core-runtime.md#simpleadapterts-lives-in-core-despite-being-an-adapter-base-class)
- **Retry only on 429**, not 5xx / network errors. → [review/error-async.md](review/error-async.md#retrybackoff-is-rate-limit-only-no-retry-on-transient-5xx-or-network-errors)
- **Hand-rolled JSON-Schema → Zod** conversion in MCP loses fidelity. → [review/verticals.md](review/verticals.md#zodts-json-schema-to-zod-conversion-is-incomplete)
- **`LinearBridgeRuntime`** constructed in three places per process, defeating its caching purpose. → [review/verticals.md](review/verticals.md#linear-bridge-runtime-is-a-parameter-passed-mutable-map)
- **5 of 15 adapters** implement `onRuntimeStop` (others don't); typed errors mixed across adapters. → [review/adapters.md](review/adapters.md#minor)
- **63 `as never`/`as any` casts** scattered through test files. → [review/build-tests-docs.md](review/build-tests-docs.md#test-type-safety-60-as-never-or-as-any-casts-in-tests)
- **No coverage thresholds** in vitest config; `src/testing/` included in coverage. → [review/build-tests-docs.md](review/build-tests-docs.md#vitestconfigts-has-no-coverage-thresholds)
- **`src/mcp/sse.ts` and `src/mcp/stdio.ts`** have no direct tests. → [review/build-tests-docs.md](review/build-tests-docs.md#mcpssets-and-mcpstdiots-lack-direct-tests)
- **`src/types/`** holds only ambient shims and no shared types — folder purpose doesn't match content. → [review/type-safety.md](review/type-safety.md#srctypes-directory-contents-do-not-match-its-declared-purpose)
- **Public sub-entry barrels** (`src/linear/`, `src/rest/`) sit next to implementation dirs of the same name (`src/integrations/linear/`, `src/client/rest/`) — confusing organization. → [review/cross-module.md](review/cross-module.md#public-sub-entrypoint-barrels-live-next-to-the-implementation-directories-with-the-same-name)
- **Inline event-dispatch switches** at 4 sites should be handler maps (per the code-style preferences guide's control-flow recommendation). → [review/cross-module.md](review/cross-module.md#inline-event-dispatch-switches-that-should-be-handler-maps)
- **`Config` vs `Options`** naming inconsistent between Codex and Opencode adapters. → [review/cross-module.md](review/cross-module.md#inconsistent-config-vs-options-suffix-for-similar-concepts-in-adapters)
- **Mixed file-name casing** within adapter folders. → [review/cross-module.md](review/cross-module.md#file-name-casing-is-mixed-without-a-clear-rule)
- **No branded IDs** across ~277 `roomId/agentId/sessionId: string` sites (highest payoff in the Linear bridge). → [review/type-safety.md](review/type-safety.md#no-branded-id-types)
- **Overlapping `linear_ask_user` / `linear_select`** tools. → [review/verticals.md](review/verticals.md#linear_ask_user-and-linear_select-overlap)
- **`agent_config.yaml.example`** missing `letta_agent`, has unused `planner_agent` / `reviewer_agent` / `linear_band_transport`. → [review/verticals.md](review/verticals.md#agent_configyamlexample-is-out-of-sync-with-example-usage)
- **Examples import from `../../src/index`** rather than `@band-ai/sdk`, mismatching the README. → [review/build-tests-docs.md](review/build-tests-docs.md#examples-use-repo-relative-imports-inconsistent-with-readme-claims)

---

## Area reports

Each area file has its own Summary, Top issues, Findings (Blockers / Major / Minor / Nits), and What's good sections.

| # | Area | File | Lines | Headline |
| - | --- | --- | --- | --- |
| 1 | Public API & exports | [`review/api.md`](review/api.md) | 213 | Root `HistoryProvider` runtime-export bug, DTO export gap, dead `mcp/claude.ts`, tsup externals miss 4 peers. |
| 2 | Core / Agent / Runtime | [`review/core-runtime.md`](review/core-runtime.md) | 510 | `PlatformRuntime.stop()` stuck-flag bug, `AgentRuntime.start()` abort-controller misuse, lifecycle modeled as booleans. |
| 3 | Network layer | [`review/network.md`](review/network.md) | 295 | `FernBandClientLike` mismatch with installed REST client, no `AbortSignal` in REST, narrow `phoenix.d.ts`. |
| 4 | Adapters | [`review/adapters.md`](review/adapters.md) | 453 | No blockers. Three competing "base" patterns; `*Like` duplicates from `optional-deps.d.ts`; per-room session bookkeeping reimplemented 6×. |
| 5 | Verticals (MCP, Linear) | [`review/verticals.md`](review/verticals.md) | 194 | No blockers. Linear isolation strong except `CodexAdapter` leak; MCP `claude.ts` is dead/redundant; `getSystemPromptContext` feature buried in `sdk.ts`. |
| 6 | Type safety (cross-cutting) | [`review/type-safety.md`](review/type-safety.md) | 253 | Excellent at usage sites (0 `@ts-ignore`, 0 `as any`); the only systemic issue is `optional-deps.d.ts` erasing peer types. |
| 7 | Error / async / cleanup / logging | [`review/error-async.md`](review/error-async.md) | 362 | 63 bare-`Error` throws, 13 catches dropping error context, **7** custom error classes outside the `BandSdkError` hierarchy, `Promise.all` in cleanup paths. |
| 8 | Build / tests / docs / examples | [`review/build-tests-docs.md`](review/build-tests-docs.md) | 397 | Build/tests strong; documentation drift is the main story (broken examples link, stale CHANGELOG, sparse JSDoc). |
| 9 | Cross-module consistency & architecture | [`review/cross-module.md`](review/cross-module.md) | 413 | No blockers. Coercion helpers duplicated 33×, 5 god-files >1000 LOC, callback naming convention not adopted, boundary leaks between `adapters/`, `converters/`, `shared/`. |

---

## Refresh log — v0.1.4 → v0.1.10

**Base:** `763734d` (original review) → **Head:** `1eb7bc9` (`main`, 2026-08-25). 72 commits. `dev` is deprecated and was not consulted.

### What actually changed in the SDK

Only **5 of the 72 commits touched `packages/sdk/src/` at all**. Everything else was CI, release plumbing, the `openclaw` package, or lockfile churn. Those five:

| PR | What it did | Files in `src/` | Findings affected |
| --- | --- | --- | --- |
| [#150](https://github.com/band-ai/band-sdk-typescript/pull/150) `feat(sdk)!: rename Band SDK surfaces` | The rebrand. Renamed every public symbol, package scope (`@band-ai/*`), tool name (`band_*`), MCP server name, env prefix (`BAND_*`), example folder, and default host. Added a `c3`–`c7` migration-proof test suite and `docs/migrations/`. | 129 files | Naming throughout these documents; added a 3rd out-of-logger `console.warn` (`config/loader.ts:35`) |
| [#80](https://github.com/band-ai/band-sdk-typescript/pull/80) `fix(sdk): surface websocket disconnect reasons` | Rewrote the streaming layer. `PhoenixChannelsTransport` 254 → 471 lines, `BandLink` 423 → 524, `AgentRuntime` 438 → 464; new `disconnectReason.ts` (210 lines) and `nodeWebSocketFactory.ts` (64 lines). Moved API-key auth from socket params to an `x-api-key` handshake header. | 7 files | Most of `network.md`; 1 Minor fixed, 1 Minor obsolete, 1 Major → Minor, +1 error class outside the hierarchy |
| [#87](https://github.com/band-ai/band-sdk-typescript/pull/87) `fix: add memory prompt guidance` | Centralised the memory taxonomy into a new `contracts/memory.ts` (129 lines) — removing six duplicated enum sets from `AgentTools.ts` and `schemas.ts` — and split `runtime/prompts.ts` into a `runtime/prompts/` directory. | 15 files | `AgentTools.ts` 1176 → 1157 (M5); widened the M4 export gap with a new unexported public-looking surface |
| [#152](https://github.com/band-ai/band-sdk-typescript/pull/152) `feat: fix LangGraph streaming adapter` | Fixed `streamEvents` argument placement, history replay under a checkpointer, and duplicate-message emission. | 1 file | Line drift only (`adapters.md`) |
| [#148](https://github.com/band-ai/band-sdk-typescript/pull/148) `fix(sdk): normalize participant handle prefixes` | Routed handle rendering through `ensureHandlePrefix`. | 1 file | None |

`tsconfig.json`, `phoenix.d.ts`, `optional-deps.d.ts`, `FernRestAdapter.ts`, `RestFacade.ts`, `ContactEventHandler.ts`, `ExecutionContext.ts`, `Execution.ts`, and the whole `integrations/linear/` tree are unchanged apart from the rebrand — so the findings against them stand verbatim.

### Findings that moved

| Finding | v0.1.4 | v0.1.10 | Why |
| --- | --- | --- | --- |
| [B4 `FernBandClientLike` mismatch](#b4-fernbandclientlike-interface-mismatches-the-installed-band-airest-client--resolved-downgraded-to-major) | Blocker | **Major** | Resolved by dependency, not code. `@band-ai/rest-client` went `0.0.113`-declared/`0.0.112-rc.0`-installed → a clean `0.0.118` pin, and `0.0.118` exposes the whole `agentApi*` family the finding called phantom. No REST path is broken any more. Residual: 9 legacy namespaces now dead as the first branch of 13 `??` chains. |
| [`disconnect()` mutates the map being iterated](review/network.md#disconnect-mutates-the-map-being-iterated--fixed) | Minor | **Fixed** | `#80` rewrote it to snapshot the keys and `Promise.allSettled` — and went further, rethrowing failures as an `AggregateError` instead of swallowing them. |
| [Optional `ws` dependency typing](review/network.md#optional-ws-dependency-typing--obsolete-the-recommendation-is-now-wrong) | Minor | **Obsolete — recommendation now harmful** | The fix said "drop `ws`, use the native `WebSocket` global". `#80` moved API-key auth onto a handshake header, which the native constructor cannot set. Acting on this finding would break authentication. Flagged loudly rather than deleted. |
| [Connect timeout uses manual `setTimeout`](review/network.md#connect-timeout-uses-manual-settimeout-instead-of-promiserace) | Major | **Minor** | Both concrete defects fixed by `#80`: the timer is now cleared on reject as well as resolve, and `connect()` guards against a stale `connectPromise`. What is left is a shape preference. |
| [Two dead imports flagged by lint](review/adapters.md#two-dead-imports-flagged-by-npm-run-lint--one-fixed-one-outstanding) | Minor | **Half fixed** | `HistoryProvider` in `GoogleADKAdapter.ts` was removed by `#87`. `asJsonSafe` in `BandACPServerAdapter.ts:21` is still there — `eslint` still warns on it. |
| [M8 error hierarchy](#m8-error-handling-consistency) | 6 stray classes, 2 `console.warn` | **7 stray classes, 3 `console.warn`** | Regressed. `#80` added `WebSocketDisconnectError extends Error`, and it is exported from *both* the root entry and `./core` — the most consumer-visible break of the `instanceof BandSdkError` contract in the SDK. `#150` added `console.warn` at `config/loader.ts:35`. |
| [`assertCapability` is dead](review/adapters.md#assertcapability-exists-but-few-adapters-call-it) | Minor | **Premise corrected** | The claim "grep finds zero usages outside the contracts file" was wrong *at v0.1.4* — there were 12 call sites then and 11 now. The finding's real point (adapters never cross-validate `enableMemoryTools` against `tools.capabilities.memory`) is untouched and still stands. |
| [Engine-version mismatch between root and SDK](review/build-tests-docs.md#engine-version-mismatch-between-root-and-sdk) | Minor | **Major** | Also a corrected premise, and this one changes the severity. v0.1.4 dismissed the gap as cosmetic on the grounds that `node:sqlite` "is GA in 22.5+". Verified on Node 22.12 — the SDK's own declared floor — `require("node:sqlite")` throws `ERR_UNKNOWN_BUILTIN_MODULE` and needs `--experimental-sqlite`. The SDK therefore publishes an `engines` floor on which its own SQLite room store cannot load, and reports that as "requires node:sqlite (Node.js 22+)". |
| [B4's "add a contract test" recommendation](review/network.md#fernbandclientlike-keeps-nine-namespaces-the-installed-band-airest-client-does-not-have) | Recommended | **Already done** | `#150` added `tests/band-client-conformance.test.ts`, which instantiates a real `BandClient` and asserts all ten `agentApi*` namespaces and 25 methods exist, with a deliberate red-check. Two gaps left: it never asserts the nine legacy namespaces are *absent*, and it pins the version in a describe-block string rather than reading `package.json`. |

### New findings

| Finding | Severity | Where |
| --- | --- | --- |
| [B6 `.release-hold` assertion contradicts HEAD](#b6-c5-package-symbolstestts-asserts-a-file-that-head-deleted) | Blocker-adjacent | `tests/c5-package-symbols.test.ts:420-421` |
| [Compile-proof tests spawn an extensionless `tsc` and fail on Windows](review/build-tests-docs.md#compile-proof-tests-are-not-portable-off-posix) | Major | 4 test files |
| [Part of the suite requires a prior `tsup` build and does not say so](review/build-tests-docs.md#part-of-the-test-suite-silently-requires-a-prior-build) | Minor | `vitest.config.ts`, 3 test files |
| [Brand guard compares against `\n`-split lines and fails on a CRLF checkout](review/build-tests-docs.md#the-brand-guard-assertion-is-line-ending-sensitive) | Minor | the stale-live-text guard, `:94` (its filename still carries the legacy brand) |

The `contracts/memory.ts` export gap was folded into the existing [M4](#m4-public-api-dtoprotocol-types-not-re-exported-from-sub-entries) rather than filed separately — it is the same finding with more surface.

### Test-suite triage at `1eb7bc9`

`vitest run` reports **23 failures across 7 files** (871 pass, 4 skipped, 898 total). Run on Windows, Node 22.12, after `tsup` and with `--experimental-sqlite`. The triage matters, because a bare "23 failing" would misrepresent the state of the code:

- **16 failures — Windows-only test-harness bug.** `c3-1`, `c4-2`, `c5-1`, `c5-2`, `c5-4b` all shell out via `spawnSync(join(SDK_ROOT, "node_modules/.bin/tsc"), …)`. On Windows the extensionless `.bin/tsc` is a POSIX shell script; `spawnSync` returns `ENOENT` and the harness reports `status: 1`, which the tests read as "compilation failed". The compile proofs are not actually being evaluated on this platform — they are silently vacuous on the failing side and false-negative on the passing side. **The SDK code under test is fine.**
- **3 failures — the review documents themselves.** The `c6`/`c7` brand guards scan `git ls-files`, and these review documents are tracked. Two of the three disappear once the documents carry Band naming (they now do). This is the guards working as designed.
- **1 failure — genuinely line-ending sensitive.** `c6:94` asserts `readme.split("\n")[0] === "# Band TypeScript SDK"`; on a CRLF checkout the first element carries a trailing `\r`.
- **1 failure — a genuine contradiction on `main`.** The `.release-hold` assertion, filed above as B6.
- **2 failures — import-boundary timeouts** (`adapters-import-boundary`, `root-import-boundary`) at the default 5s under a cold transform cache. Environment-sensitive rather than wrong, but a 5s budget for a test that transforms the entire adapter barrel is thin enough to be worth raising.

Net: **1 real defect in the repo, 20 test-infrastructure problems, 2 marginal timeouts, 0 product-code regressions.** The v0.1.4 claim "all tests pass" was true then and would still be true today on Linux CI with a build step — which is precisely why the portability findings above are worth filing.

---

## Strengths (give credit)

- **Type discipline at usage sites**: 0 `@ts-ignore`, 0 `as any`, 0 `as unknown as any`. Only 5 `any` total, all eslint-disabled with rationale.
- **Logger architecture**: Properly DI'd, `NoopLogger` default, redaction of sensitive keys, structured context objects throughout.
- **Optional peer-dep handling**: 10 of the 15 framework adapters use dynamic `await import(...)` with `UnsupportedFeatureError` on failure (Anthropic, OpenAI, Gemini, Google ADK, A2A, Claude SDK, Letta, Parlant, Vercel AI SDK, ACP). The other four (Codex, Opencode, LangGraph, A2A Gateway) import their peers statically. Backed by `tests/adapters-import-boundary.test.ts` to enforce the dynamic-import pattern where it's used.
- **Phoenix channel cleanup**: Paired and centralized; handlers tracked and removed.
- **Reconnect logic**: Exponential backoff with jitter, configurable.
- **Type guards / predicates**: ~25 user-defined type predicates, `unknown` at parse boundaries, discriminated unions for `PlatformEvent` with `assertNever` exhaustive checks.
- **Zod validation** at the event boundary.
- **Tests**: 96 test files (86 at v0.1.4), close to 1:1 coverage of source directories. Behavior-focused, typed fakes (`FakeTools implements AgentToolsProtocol`, `FakeRestApi implements RestApi`). The rebrand added a substantial migration-proof suite (`c3`–`c7`) that shells out to `tsc` against the built package and greps the tree for legacy identifiers — genuinely good practice, though see the refresh log for its portability problems.
- **Exports map / tsup config**: Aligned 1:1, types/import/require triple ordering correct, `peerDependenciesMeta` correctly marks every optional peer, `verbatimModuleSyntax` on, `files` excludes examples and tests.
- **Linear secrets** are never logged; `js-yaml` is loaded with `JSON_SCHEMA` (RCE-safe); bidirectional initiation uses `typeof === "function"` guards.
- **`Letta`** is exemplary for adapter cleanup (abort controllers + `Promise.allSettled`); `isToolExecutorError` is a model runtime type guard.

---

## Suggested order of attack

0. **Fix the red test on `main`** (B6). `tests/c5-package-symbols.test.ts:420-421` asserts a file HEAD deleted. Do this first — everything below assumes a green baseline.
1. **Land the remaining blockers** (B1, B2, B3, B5). Single-line fixes for B1 and B2; B3 needs a small state-machine refactor; B5 needs the zod 4 migration. B4 no longer needs a rest-client bump — `0.0.118` already landed it; what is left there is deleting the nine dead legacy branches.
2. **Delete `src/optional-deps.d.ts`** (M2) and replace with real `import type` of peers from devDependencies. This collapses 34 `*Like` shims and most of the 133 `as <Type>` assertions in one pass — and is the single highest-ROI change in the review. (Requires adding the missing peers to `devDependencies` first.)
3. **Tighten `tsconfig.json`** (M3). Will surface a wave of follow-up findings; do this before fixing scattered issues so the compiler points them out.
4. **Centralize error utilities and unify the error hierarchy** (M6 + M8). Eliminates 33 inline reinventions and brings the 7 stray error classes under `BandSdkError` — start with `WebSocketDisconnectError`, which is the only one exported from the root entry.
5. **Re-export DTOs from public sub-entries** (M4). Unblocks third-party adapter authors.
6. **Split the god-files / god-classes** (M5) and fix the `adapters/`/`converters/`/`shared/` boundary (M13).
7. **Plumb `AbortSignal` through REST** (M9) and unify cleanup with `Promise.allSettled` (M11).
8. **Documentation pass**: fix the broken examples link, sync CHANGELOG, add JSDoc to public API (M14, M15).
9. **Naming/cleanup pass**: callback type naming (M12), `mcp/claude.ts` resolution (M16), `ParticipantTracker` / `RoomPresence` removal (M19), minor cleanup themes.

Items 1–4 are the highest-leverage changes. Items 5–9 are larger surface area but mostly mechanical.

---

## Method note

This review was produced in three stages.

First, an initial pass by **9 parallel review agents**, each scoped to either a slice of `src/` (modules) or a cross-cutting concern (type safety, error/async, build/tests/docs, architecture). Every agent applied the same lens — a code-style preferences guide plus general TypeScript best practices — and performed research only, with no source-code edits.

Second, a **verification pass** by a separate set of agents that independently fact-checked every Blocker, Major, and Minor/Nit finding against the actual code. Counts were re-grepped, cited `file:line` references re-confirmed, and comparative claims required side-by-side code excerpts. Findings that didn't survive verification were corrected or removed.

Third, a **full human review**, covering every finding in the document. Framing was reworded, severity calls challenged, alternative fixes evaluated, and previously unverified claims re-checked empirically when called out. Several findings were rewritten as a result.

Every finding cites a `file:line` location, a severity (`blocker` / `major` / `minor` / `nit`), an Effort tag where applicable, and the relevant guide section.

### Refresh method (2026-08-25)

The refresh was mechanical first, judgement second.

1. **Establish the delta.** `git log 763734d..main` — 72 commits, of which exactly **5 touched `packages/sdk/src/`**. That small number is what made a full re-verification tractable: the surface that findings actually point at barely moved outside those five commits.
2. **Re-anchor every citation.** All **386** `file:line` citations in these documents were resolved by matching the *text* of the cited line in the v0.1.4 tree and locating that same text on `main`, rather than by trusting line numbers. 76 citations moved and were rewritten; the rest were confirmed byte-identical. Four ranges in `PhoenixChannelsTransport.ts` could not be re-anchored mechanically (the code was restructured, not moved) and were re-read and rewritten by hand.
3. **Re-verify by hand every finding whose cited file changed.** 44 of the 98 cited source files changed. Each finding touching one was re-read against current source, which is where the fixed / obsolete / re-graded calls come from.
4. **Re-run the checks the original review ran** — `tsc --noEmit`, `vitest run`, `eslint .` — plus `tsup` (needed because part of the suite compiles against `dist/`), and triage every failure rather than reporting a bare pass/fail count.
5. **Rebrand the documents.** 198 legacy-brand occurrences were rewritten to match `#150`, retaining the identifiers the rename deliberately kept on the wire (`thenvoiRoomId`). All intra-review markdown links and heading anchors were re-validated after the rename.

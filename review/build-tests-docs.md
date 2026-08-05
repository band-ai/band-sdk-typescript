[← Back to top-level review](../review.md)

# Build, Tests, and Docs Review

Scope: `packages/sdk/` build/packaging, tests, examples, and documentation.

## Summary

The SDK is generally well-packaged: `tsup` entries align with the `package.json` exports map; every optional peer is correctly flagged in `peerDependenciesMeta`; ESLint runs with `recommended-type-checked` rules on `src/**`; vitest is wired with a v8 coverage provider; and the test directory covers nearly every adapter and runtime module 1:1. Test code is largely behavior-focused and uses typed fakes (e.g. `FakeTools`, `FakeRestApi`) instead of duck typing. The main shortcomings cluster around documentation and minor configuration polish.

**What's good:**

- `tsup` ↔ `exports` map alignment is correct; every entry has a matching tsup entry and vice versa, both ESM + CJS with sourcemaps and per-format `.d.ts`.
- All 17 optional peer dependencies are flagged `optional: true` in `peerDependenciesMeta`.
- ESLint runs with `recommended-type-checked` on `src/**`, `no-explicit-any: error`, and `no-unsafe-*` enabled.
- 86 test files map 1:1 to source modules; behavior-focused tests; typed fakes in `tests/testUtils.ts`.
- Examples are real and runnable (`linear-thenvoi-bridge-server.ts` doubles as the production bridge — though see [the verticals.md finding](./verticals.md#linear-thenvoi-bridge-serverts-is-713-loc-and-doubles-as-production-code) on why this dual role is also a problem).
- `AGENTS.md` is comprehensive and accurate — better than the user-facing README in coverage. (Though see [Architecture documentation is hidden under `AGENTS.md`](#architecture-documentation-is-hidden-under-agentsmd) on why the filename hurts discoverability.)

**What's not** (each linked to its full finding):

- [`npm install` fails with `ERESOLVE` on a `zod` peer conflict (SDK dev env and Claude-adapter consumers)](#npm-install-fails-with-eresolve-on-a-zod-peer-conflict-sdk-dev-env-and-claude-adapter-consumers).
- Public-API JSDoc is largely absent — 19 of 22 surveyed public-surface files have zero JSDoc blocks; only `Agent` and `SimpleAdapter` are consistently documented. See [Missing JSDoc on most public adapter classes and options interfaces](#missing-jsdoc-on-most-public-adapter-classes-and-options-interfaces), [Missing JSDoc on `Logger`, error classes, runtime config types](#missing-jsdoc-on-logger-error-classes-runtime-config-types), [Missing JSDoc on `contracts/protocols` public interfaces](#missing-jsdoc-on-contractsprotocols-public-interfaces).
- CHANGELOG drift and duplicate release entries — see [Stale/duplicated `packages/sdk/CHANGELOG.md`](#staleduplicated-packagessdkchangelogmd) and [Root `/CHANGELOG.md` is also out of date](#root-changelogmd-is-also-out-of-date).
- README/examples drift — see [`examples/README.md` references non-existent example](#examplesreadmemd-references-non-existent-example), [Root `README.md` Examples table omits `letta/`](#root-readmemd-examples-table-omits-letta), [Root `README.md` "Subpath Exports" table omits `@thenvoi/sdk/converters`](#root-readmemd-subpath-exports-table-omits-thenvoisdkconverters).
- tsconfig strictness gaps — see [`tsconfig.json` does not enable `noUncheckedIndexedAccess` or `noImplicitOverride`](#tsconfigjson-does-not-enable-nouncheckedindexedaccess-or-noimplicitoverride).
- [Test type-safety: 60+ `as never` or `as any` casts in tests](#test-type-safety-60-as-never-or-as-any-casts-in-tests).

## Coverage map

`src/` → tests. Confirmed via grep of imports `from "../src/<dir>/..."`.

| Source directory | Tested? | Representative test files |
|---|---|---|
| `src/agent/` | yes | `agent.test.ts`, `agent-create.test.ts`, `shutdown.test.ts` |
| `src/runtime/` | yes | `platform-runtime.test.ts`, `platform-runtime-coverage.test.ts`, `execution.test.ts`, `execution-context*.test.ts`, `runtime-capabilities.test.ts`, `runtime-utils.test.ts`, `room-presence.test.ts`, `messages.test.ts`, `prompts.test.ts`, `preprocessor.test.ts`, `shutdown.test.ts`, `contact-event-handler.test.ts`, `conversation-prompt.test.ts` |
| `src/runtime/tools/` | yes | `agent-tools.test.ts`, `agent-tools-coverage.test.ts`, `custom-tools.test.ts`, `linear-tools.test.ts`, `fake-agent-tools.test.ts` |
| `src/runtime/preprocessing/` | yes | `preprocessor.test.ts` |
| `src/runtime/rooms/` | yes | `room-presence.test.ts` (RoomPresence), `platform-runtime*.test.ts` (AgentRuntime) |
| `src/platform/` | yes | `thenvoi-link.test.ts`, `phoenix-channels-transport.test.ts`, `payload-schemas.test.ts` |
| `src/platform/streaming/` | yes | `phoenix-channels-transport.test.ts`, `payload-schemas.test.ts` |
| `src/contracts/` | yes | `contracts-protocols.test.ts`, `parity-contract.test.ts` |
| `src/core/` | yes (most) | `logger.test.ts`, `lazy-async-value.test.ts`, `parity-contract.test.ts`; `isDirectExecution.ts`, `simpleAdapter.ts` are exercised indirectly through adapter tests |
| `src/config/` | yes | `config-loader.test.ts` |
| `src/client/rest/` | yes | `fern-rest-adapter-coverage.test.ts`, `fern-rest-adapter-contact-memory.test.ts`, `rest-facade-pagination.test.ts`, `agent-tools.test.ts` |
| `src/rest/` (barrel) | indirect | covered transitively via `client/rest` tests; no direct boundary test |
| `src/converters/` | yes | `converters.test.ts` plus adapter tests that exercise per-framework converters |
| `src/adapters/GenericAdapter.ts` | indirect | exercised via example tests (`examples-basic-agent.test.ts`) |
| `src/adapters/a2a/` | yes | `a2a-adapter.test.ts`, `a2a-auth.test.ts` |
| `src/adapters/a2a-gateway/` | yes | `a2a-gateway-adapter.test.ts`, `a2a-gateway-history.test.ts`, `a2a-gateway-server.test.ts`, `a2a-gateway-status-event.test.ts` |
| `src/adapters/acp/` | yes | `acp-client-adapter.test.ts`, `acp-client-subprocess.test.ts`, `acp-server-adapter.test.ts`, `acp-server.test.ts` |
| `src/adapters/anthropic/` | yes | `anthropic-adapter-sdk.test.ts` |
| `src/adapters/claude-sdk/` | yes | `claude-sdk-adapter.test.ts`, `claude-sdk-mcp.test.ts` |
| `src/adapters/codex/` | yes | `codex-adapter.test.ts`, `codex-app-server-client*.test.ts` |
| `src/adapters/gemini/` | yes | `gemini-adapter-sdk.test.ts` |
| `src/adapters/google-adk/` | yes | `google-adk-adapter.test.ts` |
| `src/adapters/langgraph/` | yes | `langgraph-adapter.test.ts` |
| `src/adapters/letta/` | yes | `letta-adapter.test.ts` |
| `src/adapters/openai/` | yes | `openai-adapter-sdk.test.ts` |
| `src/adapters/opencode/` | yes | `opencode-adapter.test.ts` |
| `src/adapters/parlant/` | yes | `parlant-adapter.test.ts`, `parlant-history.test.ts` |
| `src/adapters/tool-calling/` | yes | `tool-calling-adapter.test.ts`, `tool-calling-core.test.ts` |
| `src/adapters/vercel-ai-sdk/` | yes | `vercel-ai-sdk-adapter.test.ts` |
| `src/adapters/shared/` | yes | `adapters-shared-utils.test.ts` |
| `src/adapters/*` import boundary | yes | `adapters-import-boundary.test.ts`, `root-import-boundary.test.ts` |
| `src/mcp/backends.ts` | yes | `mcp-backends.test.ts` |
| `src/mcp/registrations.ts` | yes | `mcp-registrations.test.ts` |
| `src/mcp/server.ts` | yes (HTTP server) | `mcp-server.test.ts` |
| `src/mcp/sse.ts`, `src/mcp/stdio.ts` | **no direct tests** | only exercised via barrel boundary (`mcp-import-boundary.test.ts`) |
| `src/mcp/sdk.ts` (claude bridge) | yes | `claude-sdk-mcp.test.ts` |
| `src/integrations/linear/` | yes | `linear-activities.test.ts`, `linear-handles.test.ts`, `linear-tools.test.ts`, `linear-notification-handler.test.ts`, `linear-stale-session-guard.test.ts`, `linear-webhook-handler.test.ts`, `linear-bridge-room-strategy.test.ts`, `linear-bridge-store-sqlite.test.ts`, `linear-bridge-webhook-actions.test.ts` |
| `src/testing/` | indirect | `examples-basic-agent.test.ts`, `examples-standalone.test.ts` use `StubRestApi`; no test file dedicated to `FakeAgentTools`/`StubRestApi` boundary |

Gaps:
- `src/mcp/sse.ts` and `src/mcp/stdio.ts` have no direct behavioral tests (only barrel-import smoke).
- `src/testing/` is not directly unit-tested.
- `src/core/isDirectExecution.ts` has no direct test (used transitively in example tests).

## Findings

### Blockers

#### `npm install` fails with `ERESOLVE` on a `zod` peer conflict (SDK dev env and Claude-adapter consumers)
*Blocker · Effort: M · `packages/sdk/package.json:95, :101, :172`*

**Observation** — The SDK pins `zod@^3.24.2` in `dependencies` (line 95), but `@anthropic-ai/claude-agent-sdk@0.2.141` (the highest version satisfying the `devDependencies` range `^0.2.63`) declares `zod@^4.0.0` as a *peer*. So when the install resolver sees both `zod ^3.24.2` and the claude-agent-sdk peer requirement `zod ^4.0.0` in the same tree, the ranges don't overlap and npm 7+ refuses with `ERESOLVE`.

**Conditional breakage — depends on what's in the consumer's tree:**

| Scenario | Result |
| --- | --- |
| `npm install @thenvoi/sdk` in an empty folder | ✓ Works. Peers are marked `{ optional: true }` in `peerDependenciesMeta`, and `devDependencies` aren't installed for consumers. So `claude-agent-sdk` never enters the tree → no zod@^4 demand to conflict with. |
| Consumer wants to use the **Claude SDK adapter** and installs `@anthropic-ai/claude-agent-sdk` alongside | ✗ Fails. Both your `zod@^3` and claude-agent-sdk's `zod@^4` peer requirement are now in the tree. |
| SDK maintainer running `npm install` inside `packages/sdk/` | ✗ Fails. `claude-agent-sdk` is in `devDependencies`, so it gets installed locally; its peer-on-zod-4 activates and conflicts with the direct `zod@^3` dep. |
| Anyone running `pnpm install` | ✓ Works. pnpm warns rather than fails on peer mismatches; this is why the bug went undetected — the project is pnpm-first (`packageManager: "pnpm@10.22.0"`, `pnpm-lock.yaml`). |

**Why npm picks `0.2.141` specifically — a `0.x` semver gotcha:** the dev-dependency range `"^0.2.63"` resolves to `>=0.2.63 <0.3.0`. For pre-1.0 packages, `^` and `~` are equivalent — both cap at the next minor, not the next patch. So `^0.2.63` accepts *every* future 0.2.x patch. As of install time, the highest published 0.2.x of `claude-agent-sdk` was `0.2.141`, so npm picked it. Crucially, **semver convention allows maintainers of `0.x` packages to ship breaking changes as patches**, because 0.x is treated as "API not yet stable." That's exactly what happened here: somewhere between 0.2.63 and 0.2.141, the maintainers tightened the zod peer from `^3` to `^4` — a breaking change shipped as a patch. The `^0.2.63` range happily accepted it. To actually prevent a patch upgrade from breaking you in `0.x` you have to either pin exactly (`"0.2.63"` — but then you miss bug fixes) or use a manually-maintained bounded ceiling (`">=0.2.63 <0.2.142"`). `^` and `~` won't save you. This trap goes away once `claude-agent-sdk` releases `1.0.0`: then `^1.x.x` will actually constrain to non-breaking changes per semver, because a future zod-major bump would force the maintainers to publish `2.0.0`, which `^1.x.x` would refuse.

**A second contradiction in the SDK's own ranges:** the two declarations of `@anthropic-ai/claude-agent-sdk` in the SDK's `package.json` don't agree with each other — `peerDependencies` (line 101) is `">=0.2.63"` (open-ended, accepts any future major: 0.3.x, 1.x, etc.), while `devDependencies` (line 172) is `"^0.2.63"` (capped at `<0.3.0`). The peer range is broader than the dev range, which means a consumer could legally satisfy your peer requirement with a version you've never tested. Even if you bump zod to 4 (option 1 below), the peer range is still wrong — it should match the dev range.

**Impact** — Consumers using the Claude SDK adapter via npm are blocked. Consumers using *any other* adapter via npm are fine in an empty-tree install but will trip on the same conflict if anything else in their app brings claude-agent-sdk in transitively. Plus, the SDK's own development environment requires `pnpm` or `--legacy-peer-deps`, contradicting the implicit promise that this is "a regular npm package."

**Fix** — There is only one real path:

1. **Bump the SDK's `zod` to `^4.0.0`** and audit the code for zod 3 → 4 API differences (there are several breaking changes — `.parse()` error shape, `z.record()` signature, `.refine()`/`z.preprocess()` semantics, `z.string().email()` is now `z.email()`, error customization API, etc.). This is the only fix that unblocks every install path regardless of package manager and regardless of which adapter the consumer uses.
2. **Why "downgrade `claude-agent-sdk` to a pre-zod-4 version" is not viable:** querying npm for every published version of `@anthropic-ai/claude-agent-sdk` shows the `zod@^4.0.0` peer is present in *every release*, including the earliest published version (`0.2.39`). There has never been a zod-3-compatible version. The earlier-suggested ceiling like `">=0.2.63 <0.2.142"` simply doesn't contain any working version.
3. **Why upgrading to `claude-agent-sdk@0.3.x` doesn't help:** `0.3.159` (current latest) keeps the same `zod@^4.0.0` peer and *adds* two new peer constraints (`@anthropic-ai/sdk: ">=0.93.0"`, `@modelcontextprotocol/sdk: "^1.29.0"`). It doesn't fix this issue and introduces additional coordination headaches.
4. **`pnpm.overrides` zod pin** is a temporary workaround for the SDK's own dev environment, but **does not propagate to consumers** — the Claude-adapter consumer path remains broken on npm. Don't ship the SDK relying on it.
5. **Broader audit recommendation:** the peer-range style across the SDK leans on open-ended `">=X"` for several optional peers, which sets up future B5-style traps every time one of those peers cuts a major release with a peer-dep change. Audit every `peerDependencies` entry in `packages/sdk/package.json` — open-ended `>=` should be replaced with bounded ranges representing the versions you've actually tested. Also reconcile the contradiction between the peer range (`>=0.2.63`) and the dev range (`^0.2.63`) for `claude-agent-sdk`; they should match.

[↑ Summary in review.md B5](../review.md#b5-zod-3-vs-zod-4-peer-conflict-blocks-claude-adapter-consumers-and-the-sdks-own-dev-env)

### Major

#### Missing JSDoc on most public adapter classes and options interfaces
*Major · Effort: M · 5 adapter files (see Locations below)*

**Observation** — Adapter classes and their `*AdapterOptions` interfaces are exported from `@thenvoi/sdk` (the package's primary surface) but carry no JSDoc. Only `SimpleAdapter` (well-documented at `src/core/simpleAdapter.ts:10-18`) and `Agent.create` are documented; everything else relies on README prose. README examples won't survive into editor tooltips.

**Impact** — Developers integrating the SDK have no inline documentation for the most commonly used types; they must cross-reference the README or source code to understand adapter options.

**Fix** — Add a 1-2 line behavior-focused JSDoc to each adapter class describing what framework it wraps, what tools it forwards, and what the options control. Same for `*AdapterOptions` (or per-field docs for non-obvious fields like `openAIModel`, `clientFactory`).

**Locations:**
- `packages/sdk/src/adapters/openai/OpenAIAdapter.ts:8-37`
- `packages/sdk/src/adapters/anthropic/AnthropicAdapter.ts:8-17`
- `packages/sdk/src/adapters/gemini/GeminiAdapter.ts` (analogous)
- `packages/sdk/src/adapters/codex/CodexAdapter.ts:66-129`
- `packages/sdk/src/adapters/GenericAdapter.ts:5-17`
- Plus most other adapters under `src/adapters/*`

[↑ Summary in review.md M14](../review.md#m14-jsdoc-missing-on-public-api-surface)

#### Missing JSDoc on `Logger`, error classes, runtime config types
*Major · Effort: M · 5 core files (see Locations below)*

**Observation** — These are core types that integrators routinely reference. `CustomToolDef` is now exported from the root entrypoint (commit a9c046b, INT-334) but still has zero JSDoc on the interface itself; users currently must read implementation to learn that `name` is required and `schema` must be an object.

**Impact** — Exported types that are part of the public API surface provide no guidance to consumers; discoverability relies entirely on README prose that doesn't appear in editor tooltips.

**Fix** — Add short JSDoc describing each interface and its semantically important fields. Document when each `ThenvoiSdkError` subclass is thrown.

**Locations:**
- `packages/sdk/src/core/logger.ts:1-6` (`Logger` interface)
- `packages/sdk/src/core/logger.ts:13-51` (`NoopLogger`, `ConsoleLogger`)
- `packages/sdk/src/core/errors.ts:1-35` (all five error classes)
- `packages/sdk/src/runtime/types.ts:9-79` (`AgentConfig`, `SessionConfig`, `ContactEventConfig`, `HistoryProvider`, etc.)
- `packages/sdk/src/runtime/tools/customTools.ts:4-9` (`CustomToolDef`)

[↑ Summary in review.md M14](../review.md#m14-jsdoc-missing-on-public-api-surface)

#### Missing JSDoc on `contracts/protocols` public interfaces
*Major · Effort: M · `packages/sdk/src/contracts/protocols.ts:21-95`*

**Observation** — Only `FrameworkAdapter` and `AdapterToolsProtocol` have minimal one-line JSDoc. Tool surface interfaces (`HistoryConverter`, `PlatformMessageLike`, `HistoryLike`, `MessagingTools`, `RoomParticipantTools`, `PeerLookupTools`, `ToolSchemaProvider`, `ContactTools`, `MemoryTools`, `ToolExecutor`) are exported through `@thenvoi/sdk` and `@thenvoi/sdk/core` but undocumented. Custom adapter authors and ACP/A2A integrators need this.

**Impact** — Custom adapter authors and ACP/A2A integrators have no inline guidance on what each protocol interface represents or what its methods expect; this directly increases integration friction for the most advanced SDK use cases.

**Fix** — Add one line per interface describing what tool surface it represents, and per-method JSDoc for non-obvious methods (e.g. `sendMessage(content, mentions?)` — note the mentions-required behavior).

[↑ Summary in review.md M14](../review.md#m14-jsdoc-missing-on-public-api-surface)

#### Stale/duplicated `packages/sdk/CHANGELOG.md`
*Major · Effort: S · `packages/sdk/CHANGELOG.md:1-31`*

**Observation** — Versions 0.1.1, 0.1.2, and 0.1.3 all reference the same PR (#22) with the identical feature line — appears to be release-please re-running on the same change. The file then jumps to 0.1.4 (band-ai publish) on 2026-04-02 and stops, while >20 feature commits land between then and now (Linear bridge, Dependabot, INT-334 export, INT-355 docs, INT-293 system prompt context, etc.). No release-please-pending PR is visible from this snapshot.

**Impact** — Consumers checking the changelog cannot determine what changed between published versions; the duplicate entries create noise that undermines trust in the release history.

**Fix** — Verify release-please isn't generating duplicates (likely a config bug — possibly the release type / scope detection); collapse 0.1.1-0.1.3 if a new release is cut; ensure the next release captures the post-0.1.4 work.

[↑ Summary in review.md M15](../review.md#m15-documentation-drift)

#### Root `/CHANGELOG.md` is also out of date
*Major · Effort: S · `/CHANGELOG.md:1-60`*

**Observation** — Last entry is 0.1.2 on 2026-03-25. The SDK has since cut 0.1.3 and 0.1.4, and ~30 feature/bugfix commits have landed.

**Impact** — The root CHANGELOG diverges from the SDK CHANGELOG, leaving contributors and repository visitors with an inaccurate view of the project's release history.

**Fix** — Either remove the root CHANGELOG if `packages/sdk/CHANGELOG.md` is the canonical source, or sync it on each release.

[↑ Summary in review.md M15](../review.md#m15-documentation-drift)

#### `examples/README.md` references non-existent example
*Major · Effort: S · `packages/sdk/examples/README.md:19`*

**Observation** — `dog-landing-page/` does not exist in `packages/sdk/examples/`. The actual folders are: `a2a-bridge`, `a2a-gateway`, `anthropic`, `basic`, `claude-sdk`, `codex`, `custom-adapter`, `gemini`, `langgraph`, `letta`, `linear-thenvoi`, `openai`, `parlant`.

**Impact** — Developers following the examples README will encounter a dead reference, undermining confidence in the documentation.

**Fix** — Remove the `dog-landing-page/` bullet; add `letta/` to the list.

[↑ Summary in review.md M15](../review.md#m15-documentation-drift)

#### Root `README.md` Examples table omits `letta/`
*Major · Effort: S · `/README.md:323-336`*

**Observation** — The "Examples" table lists basic, openai, anthropic, gemini, claude-sdk, codex, langgraph, custom-adapter, parlant, a2a-bridge, a2a-gateway, linear-thenvoi — but `examples/letta/letta-agent.ts` exists and the AGENTS.md "Core Features" section lists Letta. No row, no mention of Letta anywhere in README.

**Impact** — The `letta/` example is invisible to users consulting the README, reducing discoverability of the Letta integration.

**Fix** — Add `examples/letta/ | Letta | Letta-managed agent state` row. Also add a short README section under "Adapters" for `LettaAdapter` (currently absent despite being exported from the root).

[↑ Summary in review.md M15](../review.md#m15-documentation-drift)

#### Root `README.md` "Subpath Exports" table omits `@thenvoi/sdk/converters`
*Major · Effort: S · `/README.md:303-318`*

**Observation** — The package ships an exports entry for `./converters` (`package.json:40-44`) backed by a real tsup entry (`tsup.config.ts:35`) and a populated barrel (`src/converters/index.ts`). The README's subpath table covers `adapters`, `mcp`, `mcp/claude`, `rest`, `linear`, `testing`, `config`, `core`, `runtime` but not `converters`. The internal `AGENTS.md` does list it.

**Impact** — Consumers are unaware the `@thenvoi/sdk/converters` subpath exists, causing them to either re-implement converters or import them via internal paths.

**Fix** — Add a row to the README table: `@thenvoi/sdk/converters | Per-framework history converters (ACP, A2A, Anthropic, Claude SDK, Codex, Gemini, Google ADK, LangChain, Opencode, Parlant, Vercel AI SDK)`.

[↑ Summary in review.md M15](../review.md#m15-documentation-drift)

#### `tsconfig.json` does not enable `noUncheckedIndexedAccess` or `noImplicitOverride`
*Major · Effort: M · `packages/sdk/tsconfig.json:2-17`*

**Observation** — `strict: true` is on but the two strict-adjacent flags most relevant for SDK code (array/Record access safety, override correctness) are off. Given the SDK has many `Record<string, unknown>` accesses, enabling `noUncheckedIndexedAccess` would catch real bugs.

**Impact** — Array and Record index accesses silently return `undefined` without a type error; class overrides are not verified, risking subtle behavioral divergence when base class signatures change.

**Fix** — Enable `noUncheckedIndexedAccess: true` and `noImplicitOverride: true`. Expect to fix a handful of access sites; worth the safety.

[↑ Summary in review.md M3](../review.md#m3-tsconfigjson-missing-several-strict-flags)

#### Test type-safety: 60+ `as never` or `as any` casts in tests
*Major · Effort: M · multiple test files (see Locations below)*

**Observation** — `eslint.config.js:36-39` explicitly disables `no-unsafe-*` in tests, but the repeated `as never` casts on mock runtimes/adapters indicate the test fakes could be expressed as small typed shapes. `tests/testUtils.ts` already shows the right pattern (`FakeTools implements AgentToolsProtocol`, `FakeRestApi implements RestApi`); the lighter unit tests fall back to inline `vi.fn() ... as never` casts. This is a code-quality drift, not a correctness issue.

**Impact** — Unsafe casts in tests bypass the type checker, meaning API signature changes may not surface as test failures; this weakens the suite's role as a type-level regression guard.

**Fix** — Extract typed mock builders (e.g., `createMockRuntime(overrides?)`, `createMockAdapter(overrides?)`) into `testUtils.ts` so individual tests stop reaching for `as never`.

**Locations:**
- `packages/sdk/tests/agent.test.ts:30,60`
- `packages/sdk/tests/shutdown.test.ts:25,42,59,60,81,...`
- `packages/sdk/tests/opencode-adapter.test.ts:174,223,286`
- `packages/sdk/tests/claude-sdk-adapter.test.ts:35,...`
- 63 total occurrences across the suite

### Minor

#### `vitest.config.ts` declares `types: ["vitest/globals"]` in tsconfig but tests use explicit imports
*Minor · Effort: S · `packages/sdk/tsconfig.json:15`*

**Observation** — Every test file does `import { describe, expect, it, vi } from "vitest";`. The `types: ["vitest/globals"]` line in tsconfig is dead weight (Vitest globals aren't enabled in `vitest.config.ts`).

**Impact** — Dead configuration entry creates confusion about whether globals are intended; the unused type reference may cause spurious type pollution if the global types conflict with explicit imports.

**Fix** — Remove `"vitest/globals"` from `tsconfig.json` `types`, or enable `test.globals: true` in `vitest.config.ts` if you actually want globals.

#### `vitest.config.ts` has no coverage thresholds
*Minor · Effort: S · `packages/sdk/vitest.config.ts:1-14`*

**Observation** — Coverage is configured but `thresholds` is not set, so `pnpm coverage` will print numbers without failing on regressions. Reporter is `text`-only; CI consumers would benefit from `lcov` or `json-summary` too.

**Impact** — Coverage regressions go undetected in CI; without threshold enforcement there is no automated safety net against coverage drops.

**Fix** — Add `thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 }` (calibrate to current coverage), and add `reporter: ["text", "lcov", "json-summary"]`.

#### Engine-version mismatch between root and SDK
*Minor · Effort: S · 2 manifest files (see Locations below)*

**Observation** — Root requires a newer Node than the SDK. Probably both should agree; `node:sqlite` is the load-bearing dependency and is GA in 22.5+, so `>=22.14.0` is fine for both.

**Impact** — Consumers may install the SDK on a Node version that satisfies the SDK constraint but not the root, causing subtle incompatibilities in monorepo workflows.

**Fix** — Align both to `>=22.14.0` (or whichever the team picks).

**Locations:**
- `/package.json:11-13` (`>=22.14.0`)
- `packages/sdk/package.json:87-89` (`>=22.12`)

#### `packages/sdk/CHANGELOG.md` duplicate version entries
*Minor · Effort: S · `packages/sdk/CHANGELOG.md:11-23`*

**Observation** — 0.1.1, 0.1.2, 0.1.3 all link to PR #22 with identical "add @band-ai dual-publish support" text. Likely a release-please loop on the same merge.

**Impact** — Consumers reading the changelog cannot determine what changed between 0.1.1 and 0.1.3; the repetition signals a broken release pipeline.

**Fix** — Investigate release-please config to prevent re-publishing on no-op changes; collapse the duplicates manually on the next release.

#### Examples use repo-relative imports inconsistent with README claims
*Minor · Effort: S · multiple example files (see Locations below)*

**Observation** — The README quick-start uses `import { ... } from "@thenvoi/sdk"`, but every example file imports from `../../src/index`. A developer copying an example folder out per the `examples/README.md` rationale ("each subfolder is intentionally standalone so you can copy a single folder out and hack on it") will have broken imports until they rewrite them.

**Impact** — Copied examples will fail to run without modification, contradicting the stated standalone promise; this creates a poor first-run experience.

**Fix** — Either (a) switch examples to `@thenvoi/sdk` imports (requires linking the package in the workspace, which pnpm already supports), or (b) add a sentence at the top of `examples/README.md` clarifying that imports use the in-repo path and instructing copiers to replace `../../src` with `@thenvoi/sdk`.

**Locations:**
- `packages/sdk/examples/basic/basic-agent.ts:1`
- Every other `examples/*/*-agent.ts`
- `packages/sdk/examples/linear-thenvoi/linear-thenvoi-bridge-server.ts:4-23`

#### `agent_config.yaml.example` lists more agents than used by examples
*Minor · Effort: S · `packages/sdk/agent_config.yaml.example:1-72`*

**Observation** — `letta_agent` is referenced by `examples/letta/letta-agent.ts:43` but missing from the file. Four keys are present but never referenced by any example or test in the public examples folder: `planner_agent`, `reviewer_agent`, `linear_thenvoi_transport`, `a2a_bridge_auth_agent`.

**Impact** — The missing `letta_agent` key causes a runtime config error when running the letta example; spurious keys mislead developers about which examples exist.

**Fix** — Add `letta_agent`. Drop unused keys (or move them under a `# Internal:` comment header).

#### No package-level `README.md`
*Minor · Effort: S · `packages/sdk/`*

**Observation** — `packages/sdk/package.json` lists `"README.md"` in `files`, but there is no `packages/sdk/README.md` — only the root `README.md`. When publishing, pnpm/npm will pick up *no* README inside the tarball unless a build step copies the root one. The `dist/` directory will go but no docs.

**Impact** — The published npm package ships without a README, so the package page on npmjs.com shows no documentation; consumers installing the package have no offline reference.

**Fix** — Either symlink/copy the root `README.md` into `packages/sdk/README.md` at build time, or add a build script that does so, or write a thin package-level README pointing at the GitHub repo.

#### No coverage rollup configuration in vitest
*Minor · Effort: S · `packages/sdk/vitest.config.ts:1-14`*

**Observation** — `include: ["src/**/*.ts"]` is correct; `exclude` only filters `.d.ts`. The example test files under `tests/examples-*.test.ts` exercise example code under `examples/` which is *not* in coverage — fine. But `src/testing/` (test helpers shipped to consumers) is included in coverage and probably shouldn't be (it's intentionally trivial).

**Impact** — Coverage metrics are artificially skewed by intentionally trivial test-helper code; low coverage on `src/testing/` may trigger false threshold failures if thresholds are added.

**Fix** — Add `"src/testing/**/*.ts"` to the coverage exclude list to avoid coverage punishing intentionally simple stubs.

#### `mcp/sse.ts` and `mcp/stdio.ts` lack direct tests
*Minor · Effort: S · 2 mcp files (see Locations below)*

**Observation** — Both servers are exported from `src/mcp/index.ts` and listed in the README as part of the MCP subpath, but `tests/` has no dedicated file beyond `mcp-import-boundary.test.ts` which only checks the barrel. `mcp-server.test.ts` only covers the HTTP variant.

**Impact** — Behavioral regressions in `ThenvoiMcpSseServer` and `ThenvoiMcpStdioServer` will not be caught by the test suite; these are public API exports with no behavioral coverage.

**Fix** — Add lightweight construction / lifecycle tests for `ThenvoiMcpSseServer` and `ThenvoiMcpStdioServer` even if they only assert wiring (start/stop, registration delegation).

**Locations:**
- `packages/sdk/src/mcp/sse.ts`
- `packages/sdk/src/mcp/stdio.ts`

#### `src/testing/` (FakeAgentTools, StubRestApi) has no direct tests
*Minor · Effort: S · 2 testing files (see Locations below)*

**Observation** — `examples-basic-agent.test.ts` smoke-tests `StubRestApi.getAgentMe`, but nothing exercises `FakeAgentTools` boundary semantics (capture buffers, capabilities flagging). Since this module is part of the public API (`@thenvoi/sdk/testing`), the public surface deserves at least one dedicated test file.

**Impact** — Bugs in `FakeAgentTools` or `StubRestApi` go undetected until they break consumer tests; there is no regression guard for the testing utilities themselves.

**Fix** — Add `tests/testing-fake-agent-tools.test.ts` (or fold into `fake-agent-tools.test.ts` — that file currently tests a different `FakeTools` in `tests/testUtils.ts`).

**Locations:**
- `packages/sdk/src/testing/FakeAgentTools.ts`
- `packages/sdk/src/testing/StubRestApi.ts`

#### Architecture documentation is hidden under `AGENTS.md`
*Minor · Effort: S · `AGENTS.md`, `README.md`, no `docs/` folder*

**Observation** — The repo has substantial architecture documentation: `AGENTS.md` is 446 lines covering Core Features, Subpath Exports, Platform Tools (Chat / Contact / Memory), REST patterns, Phoenix channel topology, contact event handling, A2A / ACP / MCP integration, Linear integration, and a Code Structure section. But the filename signals AI-agent instructions, not human onboarding. A new contributor reads `README.md` first; `README.md` doesn't link to `AGENTS.md`; and there is no `docs/` folder or `ARCHITECTURE.md` to land on. The architecture content is also entirely prose — no Mermaid/drawio diagrams for the load-bearing flows (platform → runtime → adapter dependency direction, Phoenix channel topology, contact-event hub flow).

**Impact** — New human contributors face a higher onboarding cost than the documentation merits, because the documentation is hidden behind a misleading filename. The "AI agents" framing also subtly discourages contributors from treating it as the human-readable source of truth, so it can drift unmaintained.

**Fix** — Three small steps; doing all three is ideal but each helps on its own:
- **Add an "Architecture" link near the top of `README.md`** pointing to the architecture doc, so it is discoverable from the canonical entry point.
- **Either rename `AGENTS.md` → `ARCHITECTURE.md` (with `AGENTS.md` becoming a thin pointer)**, or split: keep AI-agent-specific instructions in `AGENTS.md` and move the architecture content to `ARCHITECTURE.md`.
- **Add 2–3 Mermaid diagrams** for the highest-traffic flows: platform/runtime/adapter dependency direction, Phoenix channel topology (`agent`, `agent_contacts`, `agent_rooms`, per-room channels), and the contact-event hub flow. Diagrams cut a paragraph of prose to a glance.

### Nits

#### `tsup.config.ts` external list could be derived from package.json
*Nit · Effort: S · `packages/sdk/tsup.config.ts:3-26`*

**Observation** — The 23-entry `EXTERNAL` list duplicates the `peerDependencies` keys (plus a handful of subpath entries like `@a2a-js/sdk/client`). If a new peer is added to `package.json` and forgotten here, tsup will try to bundle it. Could be derived from `package.json`.

**Impact** — Adding a new peer dependency without updating the external list causes tsup to bundle the peer, producing an oversized artifact.

**Fix** — Generate `external` from `Object.keys(pkg.peerDependencies)` plus the explicit subpath suffixes so the two lists stay in sync automatically. M18 already shows the kind of drift this prevents (4 peer roots currently missing from the list).

#### `eslint.config.js` ignores `*.config.*` but the file itself is `.js` not `.ts`
*Nit · Effort: S · `packages/sdk/eslint.config.js:45`*

**Observation** — `ignores: [..., "*.config.*", ...]` skips `vitest.config.ts` and `tsup.config.ts` which are pure TypeScript and could be linted with the relaxed ruleset.

**Impact** — Config files silently bypass lint rules; type errors in `vitest.config.ts` or `tsup.config.ts` go undetected.

**Fix** — Remove `*.config.*` from the ignore list and let the relaxed-rules block cover them via a glob. Not urgent.

## Strengths worth keeping

- **tsup ↔ exports map alignment is correct.** Every `package.json` `exports` entry has a matching tsup entry and vice versa. Both ESM + CJS are emitted with sourcemap and `.d.ts` per format.
- **Optional peer dependencies are correctly flagged.** All 17 peer dependencies have `optional: true` in `peerDependenciesMeta` (`packages/sdk/package.json:117-169`), so consumers don't get warnings for adapters they don't use. Versions are lower-bound `>=` only, appropriate for an SDK.
- **ESLint config is sound.** `recommended-type-checked` rules on `src/**` with explicit `no-explicit-any: error` and the `no-unsafe-*` family enabled. Relaxed but still typed config for tests and examples.
- **Test breadth is excellent.** 86 test files mapping 1:1 to source modules; nearly every adapter, integration, and runtime piece has a dedicated test. Behavior-focused tests with descriptive names ("waits for startup to finish before honoring a stop request", "gates peers endpoint when disabled", "validates send_message requires mentions").
- **`tests/testUtils.ts` is the right pattern.** Typed `FakeTools implements AgentToolsProtocol`, typed `FakeRestApi implements RestApi` — fakes are type-safe and constrain the API contract.
- **Examples are real and runnable.** `linear-thenvoi-bridge-server.ts` is a production-shape server with retry, rate-limiting, and graceful shutdown. The `pnpm dev:linear` script wires it up. (Caveat: at 713 LOC the file is now hard to follow as an *example*, and the dual production/demo role is itself a structural concern — see [verticals.md](./verticals.md#linear-thenvoi-bridge-serverts-is-713-loc-and-doubles-as-production-code).)
- **AGENTS.md is comprehensive and accurate.** Subpath table, REST patterns, channel topology, contact event strategies — all aligned with the source. Better than the user-facing README in coverage. (Caveat: hidden behind a filename suggesting it's for AI agents only — see [the discoverability finding](#architecture-documentation-is-hidden-under-agentsmd).)
- **Node-22-only features are used consistently with the declared engine.** `node:sqlite` is lazy-imported with a clear error in `src/integrations/linear/store.ts:287-289` and gated on Node 22.
- **Graceful shutdown + signal handling is documented and tested.** `Agent.run({ signals: false })` is supported (see README architecture section) and `shutdown.test.ts` covers the lifecycle.
- **`SimpleAdapter` and `Agent.create` are well-JSDoc'd** — they're the public extension points and serve as the model for what the other adapters should look like.

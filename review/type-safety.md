[← Back to top-level review](../review.md)

# Type Safety Review (Cross-cutting)

Scope: `packages/sdk/src/` — entire tree (~30,300 LOC, 152 `.ts` files).

## Summary

Type hygiene at usage sites is unusually disciplined for a codebase that integrates ~14 optional AI-framework SDKs. The systemic weaknesses are not in the source — they're in the ambient module declarations and tsconfig strictness gaps that force everything else to compensate.

**What's good:**

- `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`: **0** in `src/`.
- `: any` / `as any` / `Promise<any>` / `Array<any>`: **5 total**, all eslint-disabled with rationale, all in `src/mcp/`.
- `: Function`: **0**.
- ~25 user-defined type predicates; `import type` / `export type` used in ~72% of import/export statements.
- Disciplined typed-catch behavior — errors typed `unknown` by default and narrowed via `instanceof Error`.

**What's not** (each linked to its full finding):

- Ambient `declare module` erases types from 12 peer modules → 34 `*Like` shims and 55 `as Record<string, unknown>` casts — [ambient `declare module` erases all upstream types](#ambient-declare-module-erases-all-upstream-types-for-8-peer-sdks), [`*Like` duck-typed shims drift](#like-duck-typed-shims-drift-from-upstream-sdk-shapes).
- tsconfig is missing 5 strict flags the sibling package enables — [`tsconfig.json` strict-mode flags inconsistent](#tsconfigjson-strict-mode-flags-inconsistent-with-sibling-package).
- `: object` type in private REST methods — [`: object` type used in private REST facade methods](#-object-type-used-in-private-rest-facade-methods).
- `src/types/` doesn't hold shared types — [directory contents do not match its declared purpose](#srctypes-directory-contents-do-not-match-its-declared-purpose).
- `as unknown as` double-casts in Linear webhook handler — [payload-laundering in Linear webhook handler](#as-unknown-as-payload-laundering-in-linear-webhook-handler).
- Plain `string` IDs across ~277 sites for 7 distinct domain concepts — [No branded ID types](#no-branded-id-types).

## Census tables

### `: any` / `as any` / `<any>` / `Promise<any>` etc.

| Directory | Count | Locations |
| --- | --- | --- |
| `src/mcp/` | 5 | Two groups, all eslint-disabled with rationale. **2× `SdkMcpToolDefinition<any>`** as generic parameter (`sdk.ts:60`, `sdk.ts:349`) — matches the upstream signature from `@anthropic-ai/claude-agent-sdk`. **3× `Promise<any>` return** on MCP handler functions (`server.ts:301`, `sse.ts:223`, `stdio.ts:95`) — MCP SDK handler shape is complex; the SDK's `McpToolResult` is compatible. |
| (rest of `src/`) | 0 | — |

All 5 occurrences are eslint-disabled with a one-line justification. No `as any` anywhere. No `Array<any>` / `Record<string, any>` anywhere.

### `as <Type>` assertions — top 10 directories

| Location | Count |
| --- | --- |
| `src/integrations/linear/` | 25 |
| `src/runtime/tools/` | 22 |
| `src/adapters/a2a-gateway/` | 16 |
| `src/client/rest/` | 8 |
| `src/adapters/codex/` | 9 |
| `src/adapters/acp/` | 7 |
| `src/platform/ThenvoiLink.ts` | 5 |
| `src/adapters/openai/` | 5 |
| `src/adapters/vercel-ai-sdk/` | 4 |
| `src/runtime/rooms/` | 3 |
| everything else | ≤2 each |

Breakdown of `as` flavors:

- **`as Record<string, unknown>` after `typeof v === "object" && v !== null` narrowing**: 55 occurrences — legitimate, but most could be replaced by a single shared `isRecord(value): value is Record<string, unknown>` guard (already defined twice — see "Duplicated type guards" finding).
- **`Set.has(value as MemberType)` enum-narrowing**: ~10 occurrences in `src/runtime/tools/AgentTools.ts`, `src/integrations/linear/store.ts`. Legitimate — TS doesn't have `Set<T>.has(unknown)`.
- **`as unknown as <Specific>`**: 15 occurrences — 8 are Node/DOM stream interop (`Writable.toWeb(...) as unknown as WritableStream`), 5 are payload narrowing in `src/integrations/linear/webhook.ts`, 2 are dubious (see findings).
- **Module-loader downcasts** (`import("…") as Promise<Record<string, unknown>>` then `.X as RuntimeFoo["X"]`): 13 in `src/adapters/a2a-gateway/server.ts` alone — direct consequence of ambient-`declare module` erasure.

### `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`

| Location | Count |
| --- | --- |
| `src/` (all) | **0** |

### `object` and `Function` types

| File:LN | Type used |
| --- | --- |
| `src/client/rest/RestFacade.ts:396` | `metadata?: object` (private method) |
| `src/client/rest/RestFacade.ts:411` | `metadata?: object` (private method) |

Both are private; both are immediately cast (`metadata as Record<string, unknown>` on line 413). Should be `Record<string, unknown>` directly.

## Findings

### Blockers

(none)

### Major

#### Ambient `declare module` erases all upstream types for 8 peer SDKs
*Major · Effort: L · `packages/sdk/src/optional-deps.d.ts`, `packages/sdk/src/types/google-adk.d.ts`*

**Observation** — Each `declare module "@foo/bar"` with no body makes the module's exports implicitly `any` at every import site. This propagates everywhere those libraries are touched. The codebase has compensated by defining 34 `*Like` interfaces (e.g. `OpenAIClientLike`, `AnthropicClientLike`, `GeminiClientLike`, `LettaClientLike`, `ParlantClientLike`, `OpencodeClientLike`, `A2AClientLike`) that re-declare the relevant slice of each SDK's public shape.

The visible costs:

- **`as Record<string, unknown>` narrowings** — 55 of the 133 `as` assertions narrow values from these typeless modules.
- **Dynamic-import retypes** — 13 `as` assertions in `src/adapters/a2a-gateway/server.ts` exclusively retype dynamically-imported modules.
- **Reimplemented wire-format narrowing** — the parsing logic in `src/adapters/openai/model.ts`, `src/adapters/anthropic/model.ts`, `src/adapters/gemini/model.ts` reimplements wire-format narrowing that the upstream SDKs already type (e.g. `Anthropic.ContentBlock`, `OpenAI.Chat.ChatCompletionMessage`).

The hidden cost: if `@anthropic-ai/sdk` changes its response shape, nothing here breaks at compile time — bugs surface only at runtime.

**Impact** — Type erasure across 8 peer SDKs forces hand-rolled `*Like` shims throughout the codebase and silently allows breaking upstream changes to go undetected until runtime.

**Fix** — Add the missing peers to `devDependencies` in `packages/sdk/package.json` (keeping the `peerDependencies` entries — those stay so consumer install behavior is unchanged). Then delete the ambient declarations and let adapter code `import type` directly against the real upstream types. `CodexAdapter` already does this correctly with `@openai/codex-sdk` (which is in *both* `devDependencies` and `peerDependencies`). An interim alternative is to replace the body-less declarations with `import type` namespaces (e.g. `declare module "@anthropic-ai/sdk" { export * from "@anthropic-ai/sdk/index"; }`), only if upstream packaging supports it. Once the ambient declarations are gone, the `*Like` interfaces become `Pick<Anthropic.Messages.MessageCreateParams, "model" | "messages">` and the `as Record<string, unknown>` narrowings disappear at adapter parse sites.

[↑ Summary in review.md M2](../review.md#m2-srcoptional-depsdts-erases-peer-sdk-types-at-build-time)

#### `tsconfig.json` strict-mode flags inconsistent with sibling package
*Major · Effort: S · `packages/sdk/tsconfig.json`*

**Observation** — The SDK enables `strict: true` and `verbatimModuleSyntax: true` (good) but is missing 5 strict flags that the sibling `packages/openclaw/tsconfig.json` enables. `noImplicitOverride` is missing in both, but the SDK uses inheritance (`SimpleAdapter` subclasses, the `Agent` extending `PlatformRuntime` patterns) where it would catch real bugs.

What each missing flag catches:

| Flag | What it catches | Why it matters |
| --- | --- | --- |
| `noUncheckedIndexedAccess` | `arr[i]` and `obj[key]` now type as `T \| undefined` instead of `T` | Forces handling of out-of-bounds / missing-key cases. Catches real runtime crashes. |
| `noImplicitOverride` | Requires the `override` keyword on subclass methods that override a parent | If the parent method is renamed or removed, the subclass "override" silently becomes a brand-new method — the compiler refuses to compile until you fix the inheritance. |
| `noUnusedLocals` | Errors on declared variables never read inside their scope | Catches dead code and refactor leftovers. Noisy mid-work; many teams enable only in CI. |
| `noUnusedParameters` | Same as above but for function parameters | Opt out per-parameter with an underscore prefix (`_event`) to signal "intentionally unused". |
| `noImplicitReturns` | Errors when some paths return a value and others fall through to the end | Catches the classic "forgot `return` inside an `if`" bug that silently returns `undefined`. |
| `noFallthroughCasesInSwitch` | Errors on a `switch case` with code but no `break` / `return` / `throw` | C-style fallthrough is occasionally intentional but usually a bug; this flag forces marking the intentional ones explicitly. |

**Impact** — Missing strict flags allow entire classes of bugs — undetected unused variables, unsafe array index access, and missing override annotations — to slip through compile-time checks.

**Fix** — Mirror the flags from `packages/openclaw/tsconfig.json` and add `noImplicitOverride`. Expect new errors at array/object index sites (e.g. `tokens[index]` in `src/adapters/codex/CodexAdapter.ts:1195`); these are real correctness wins.

[↑ Summary in review.md M3](../review.md#m3-tsconfigjson-missing-several-strict-flags)

#### `*Like` duck-typed shims drift from upstream SDK shapes
*Major · Effort: M · 7 adapter files (see Locations below)*

**Observation** — `OpenAIClientLike` redeclares a fragment of `openai`'s `OpenAI` class; `AnthropicMessageResponseLike` redeclares a fragment of `Anthropic.Messages.Message`; `LettaResponseMessage`, `LettaResponse`, `LettaAgentCreateParams`, `LettaToolReturn` redeclare `@letta-ai/letta-client` DTOs. The reason these exist (per the ambient finding above) is that `optional-deps.d.ts` erases the real types. Once that root cause is fixed, these shims should be deleted or reduced to `Pick<>` of the real types.

**Impact** — Hand-rolled shims silently diverge from upstream SDK shapes when those SDKs release breaking changes, producing runtime failures with no compile-time warning.

**Fix** — After removing the ambient `declare module` block, audit each `*Like` interface and either delete it or replace with `Pick<RealType, "fields-we-actually-use">`. Keep `*Like` only for genuinely-not-yet-exported upstream types (e.g. `@google/adk` has no public type story).

**Locations:**
- `packages/sdk/src/adapters/openai/model.ts:15-30`
- `packages/sdk/src/adapters/anthropic/model.ts:16-24`
- `packages/sdk/src/adapters/gemini/model.ts:39-52`
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:17-110`
- `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:16-…`
- `packages/sdk/src/adapters/a2a/A2AAdapter.ts:38-92`
- `packages/sdk/src/adapters/google-adk/GoogleADKAdapter.ts:27-57`

34 `*Like` interfaces total across these files.

[↑ Summary in review.md M10](../review.md#m10-phoenixdts-ambient-is-too-narrow)

#### `: object` type used in private REST facade methods
*Major · Effort: S · `packages/sdk/src/client/rest/RestFacade.ts:396, :411`*

**Observation** — Both `callOptional` and `forward` declare `metadata?: object`, and `forward` immediately re-casts it to `Record<string, unknown>` on line 413 to pass to `logger.debug`. The wider type provides no benefit and forces the cast.

**Impact** — Using `object` instead of `Record<string, unknown>` is a well-known anti-pattern that widens the type unnecessarily and forces a downstream cast that should be avoidable.

**Fix** — Change the parameter type to `Record<string, unknown> | undefined` and delete the `as Record<string, unknown>` cast on line 413.

[↑ Summary in review.md M20](../review.md#m20-object-type-used-in-restfacadets)



#### `src/types/` directory contents do not match its declared purpose
*Major · Effort: S · `packages/sdk/src/types/google-adk.d.ts`, `packages/sdk/src/types/ws.d.ts`*

**Observation** — `src/types/` contains exactly two `.d.ts` files, both ambient module shims (`@google/adk` body-less, `ws` re-exporting a global). There is no `index.ts`, and the directory contains no shared type definitions. Meanwhile, the real shared types live in `src/contracts/dtos.ts` and `src/contracts/protocols.ts`. The directory either should be deleted (and the `.d.ts` files moved next to `optional-deps.d.ts`) or repurposed to actually host shared types from `src/contracts/`.

**Impact** — The misleading directory name makes it harder to locate actual shared type definitions and signals poor type organisation to contributors.

**Fix** — Move `google-adk.d.ts` to live next to `src/optional-deps.d.ts` (or consolidate into it), move `ws.d.ts` similarly, and delete `src/types/`. Alternatively, if `types/` is preserved, move `src/contracts/dtos.ts` content into it with a proper `index.ts` of pure re-exports.

### Minor

#### Two redundant `isRecord` type guards
*Minor · Effort: S · `src/adapters/a2a/A2AAdapter.ts:611`, `src/adapters/opencode/client.ts:385`*

**Observation** — Both declare `function isRecord(value: unknown): value is Record<string, unknown>` with effectively identical bodies. This pattern is replicated at 55 sites as inline `value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null`. A single shared helper (e.g. `src/adapters/shared/coercion.ts` already exports `asNonEmptyString` and `asErrorMessage` — add `asRecord` / `isRecord` there) would eliminate dozens of `as` casts and the duplicated guard.

**Impact** — Duplicated guards create maintenance burden and divergence risk — if the check logic needs to change, it must be updated in multiple places.

**Fix** — Add `export function isRecord(value: unknown): value is Record<string, unknown>` to `src/adapters/shared/coercion.ts` and replace all duplicated checks and inline casts.

#### `as unknown as` payload-laundering in Linear webhook handler
*Minor · Effort: S · `packages/sdk/src/integrations/linear/webhook.ts:328, :355, :387`*

**Observation** — Three uses of `parsed as unknown as <PayloadType>`. The double-cast `as unknown as X` is a hard escape from type checking. Here it is used after a discriminating string check (`if (parsed.type === "PermissionChange") { ... action === "teamaccesschanged" }`), so a proper user-defined type guard (`function isTeamAccessChangedPayload(p: { type?: string }): p is AppUserTeamAccessChangedWebhookPayload`) would express the same intent without the double cast. The Linear webhook payload is parsed by `LinearWebhookClient.parseData` which returns `{ type?: string }` — a real type guard pulls weight here.

**Impact** — Double-casts bypass the type checker entirely, meaning shape changes in webhook payloads will not be caught at compile time.

**Fix** — Define narrow type-guard functions in this file (or in `src/integrations/linear/webhook-guards.ts`) and replace the three `as unknown as` casts with `if (isTeamAccessChangedPayload(parsed)) { ... }`.

#### `SimpleAdapter` generic `H` returned via cast when no converter is configured
*Minor · Effort: S · `packages/sdk/src/core/simpleAdapter.ts:66`*

**Observation** — `SimpleAdapter<H, TTools = AdapterToolsProtocol>` has no constraint on `H`. When `historyConverter` is unset, `convertHistory` returns the `HistoryLike` instance cast to `H` (`return provider as H;`). Subclasses (e.g. `OpenAIAdapter` with `H = OpenAIMessages = ToolModelMessage[]`) will receive a `HistoryLike` (which has `.raw`, `.convert`, `.length` — not an array) but be typed as their array type. If a subclass forgets to set `historyConverter`, the cast is unsound and will produce runtime errors on `.map`/`.filter`.

**Impact** — An unsound cast produces a plausible-looking compile-time type that will crash at runtime when a subclass omits `historyConverter`.

**Fix** — Either constrain `H extends HistoryLike` so the default branch is sound, or refactor `onMessage` to receive the raw `HistoryLike` and require subclasses to convert explicitly. Alternatively, throw if `historyConverter` is unset.

#### `as AdapterToolsProtocol & { ... }` duck-typing in `mcp/sdk.ts`
*Minor · Effort: S · `packages/sdk/src/mcp/sdk.ts:225, :252`*

**Observation** — Two functions duck-type into `AdapterToolsProtocol` looking for `getAgentIdentity` and `rest.listChats`. The current cast is `tools as AdapterToolsProtocol & { getAgentIdentity?: …; rest?: { getAgentMe?: … } }`. A comment on line 222 even calls this out as "duck-type two known extension points". This pattern would be cleaner with a separate `AdapterToolsWithIdentity` interface or an optional method on `AdapterToolsProtocol`. Marked minor because the casts are contained and explained.

**Impact** — Inline intersection casts are fragile — renaming or restructuring `AdapterToolsProtocol` won't trigger a compiler error at these cast sites.

**Fix** — Add `getAgentIdentity?(): Promise<AgentIdentity>` as an optional method on `AdapterToolsProtocol`, then the cast becomes unnecessary. For `rest.listChats`, the right abstraction is a `RoomLookupTools` interface that `AdapterToolsProtocol` extends via `Partial<>`.

#### `as Promise<Record<string, unknown>>` on every dynamic import in a2a-gateway
*Minor · Effort: S · `packages/sdk/src/adapters/a2a-gateway/server.ts:322-325, :339-348`*

**Observation** — 4× `import("…") as Promise<Record<string, unknown>>` followed by 6× `.X as RuntimeA2AServerModules["X"]`. The full `RuntimeA2AServerModules` interface (lines 43-90) is laboriously hand-rolled because `@a2a-js/sdk` is declared as a type-less module in `optional-deps.d.ts`. Resolving that root cause removes this whole block.

**Impact** — The hand-rolled `RuntimeA2AServerModules` interface will silently drift from the real `@a2a-js/sdk` shape as the upstream package evolves.

**Fix** — After the ambient declaration is replaced (see "Ambient `declare module`" major finding), use `await import("@a2a-js/sdk/server")` directly — TS will keep the precise types.

### Nits

#### No branded ID types
*Nit · Effort: L · ~277 occurrences across `src/contracts/`, `src/integrations/linear/`, `src/runtime/rooms/` (see Locations below)*

**Observation** — The bridge layer (Linear integration) deals with both Thenvoi room IDs and Linear session IDs and issue IDs simultaneously. In `src/integrations/linear/bridge/handler.ts` and `src/integrations/linear/store.ts` these IDs are passed around as plain `string`. There is no compile-time protection against passing a `thenvoiRoomId` where a `linearSessionId` is expected.

**Impact** — Plain `string` IDs for seven distinct domain concepts can be silently mixed up at call sites, producing hard-to-diagnose runtime bugs.

**Fix** — Introduce branded aliases in `src/contracts/dtos.ts`:
```ts
export type RoomId = string & { readonly __brand: "RoomId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type LinearSessionId = string & { readonly __brand: "LinearSessionId" };
export type LinearIssueId = string & { readonly __brand: "LinearIssueId" };
```
…with constructor helpers in `src/adapters/shared/coercion.ts`. Highest payoff in the Linear bridge.

**Locations:** affects ~277 occurrences of `roomId: string`, `agentId: string`, `sessionId: string`, `messageId: string`, `linearSessionId: string`, `linearIssueId: string`, `thenvoiRoomId: string` across `src/contracts/protocols.ts`, `src/contracts/dtos.ts`, `src/integrations/linear/store.ts`, `src/runtime/rooms/AgentRuntime.ts`, etc.

## Strengths worth keeping

- **Zero `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`** in the entire `src/` tree. Most codebases of this size carry at least a handful.
- **`any` reduced to 5 carefully-justified occurrences**, every one eslint-disabled with a rationale comment matching the upstream SDK signature.
- **No `as any` anywhere.** Even legacy interop sites use `as unknown as <Specific>` and document why.
- **No `Function` type usage** and only 2 isolated `object` type usages.
- **Catch parameters are `unknown` by default** under strict mode. Five explicit `catch (error: unknown)` annotations exist and the rest rely on the default; either way, errors are narrowed via `error instanceof Error`. No `catch (e: any)` anywhere.
- **Heavy use of `unknown`** at parse/wire boundaries (291 occurrences) with explicit `typeof === "object"` narrowing before any cast.
- **User-defined type predicates** (`value is Y`) are used in 19 places where they matter most: webhook payload narrowing, ACP option filtering, Codex thread-item discrimination, Letta approval-message detection.
- **Discriminated unions** for `RemoveContactArgs` (`{ target: "handle" } | { target: "contactId" }`) and `RespondContactRequestArgs` — exactly per "Type Safety Best Practices".
- **`import type` / `export type` discipline** — ~72% of imports/exports are explicitly type-only. With `verbatimModuleSyntax: true` enabled, this is enforced by the compiler.
- **`as const satisfies readonly X[]`** used correctly for the four enum-like constant arrays (`CODEX_REASONING_EFFORTS`, `CODEX_REASONING_SUMMARIES`, `CODEX_WEB_SEARCH_MODES`, `REQUIRED_ADAPTER_TOOL_METHODS`).
- **Generic constraints are present and meaningful** (`fetchPaginated<T extends MetadataMap>`, `BaseEvent<TType extends string, TPayload>`, `callOptional<Op extends OptionalRestOperation, Result>`). No unreadable nested-generic offenders observed.
- **`index.ts` barrels contain only re-exports** — no type definitions hidden in barrel files (verified across 13 `index.ts` files).
- **Public API in `src/index.ts` is fully typed** — no `any` leaks through any exported function signature.
- **Strict mode IS on** (`strict: true`, `verbatimModuleSyntax: true`). The findings above are about *which additional* flags to enable, not about strict being off.
- **Consistent interface/type usage** across ~346 `export interface` / `export type` declarations — no file mixes `interface Foo` and `type Foo` for the same concept; `interface` is used for object shapes, `type` for unions/intersections/aliases.

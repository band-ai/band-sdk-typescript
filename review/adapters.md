[← Back to top-level review](../review.md)

# Adapters Layer Review

## Summary

The adapter layer is the largest part of the SDK — **15 framework adapters** behind a thin shared contract. Hygiene at the boundaries is strong; the weaknesses are inside, in the form of duplicated cross-cutting patterns and a misleading abstraction story.

**What's good:**

- Peer-dep discipline — every runtime import is dynamic, wrapped in `LazyAsyncValue` with `UnsupportedFeatureError`.
- Zero `any` / `@ts-ignore` / `@ts-expect-error` across `src/adapters`, `src/converters`, `src/contracts`, `src/integrations`.
- Import-boundary test (`tests/adapters-import-boundary.test.ts`) asserts the `./adapters` entrypoint doesn't eagerly import optional peers.
- `tsup.config.ts` externalises every optional peer; `optional-deps.d.ts` fills declarations for peers behind dynamic imports.

**What's not** (each linked to its full finding):

- The three "base" patterns (`SimpleAdapter`, `ToolCallingAdapter`, `GenericAdapter`) don't have the relationship the names suggest — see [GenericAdapter does not generalise the other 15 adapters](#genericadapter-does-not-generalise-the-other-15-adapters).
- Same cross-cutting patterns reinvented per adapter — [per-room session bookkeeping](#per-room-session-bookkeeping-is-reimplemented-in-six-adapters), [`selectCompleteExchanges`](#verbatim-duplication-between-letta-and-parlant), [`*Like` shadow interfaces](#like-shadow-interfaces-for-external-sdks-duplicate-upstream-types), [`load*ClientFactory` boilerplate](#loadxclientfactory-is-reinvented-per-adapter).
- `converters/` re-exports from `adapters/` — [wrong-way boundary leak](#convertersindexts-re-exports-from-adapters-a-wrong-way-boundary).
- The root cause behind most `*Like` interfaces: [`optional-deps.d.ts` empty module declarations widen types](#optional-depsdts-empty-module-declarations-silently-widen-types).

**Highest-leverage refactors:**

1. A shared **per-room session manager** (replaces 5 adapter-local reinventions).
2. **Consolidate the optional-peer-loader pattern** (replaces ~10 near-identical `load*` helpers).

**Import-boundary note:** no static imports of optional peers in `src/adapters/`; `@linear/sdk` is imported as a value in `src/integrations/linear/*` but that's a separate bundle so the rule still holds.

## Findings

### Blockers

(None — no static imports of optional peers from adapter modules, no missing
cleanup that would orphan resources on common paths, and the abstraction
mismatch is design-level, not runtime-broken.)

### Major

#### `GenericAdapter` does not generalise the other 15 adapters
*Major · Effort: S · `src/adapters/GenericAdapter.ts:17`*

**Observation** — `GenericAdapter` is sold by name as the base abstraction, but it is a one-class shim that hands a callback the same arguments `SimpleAdapter.onMessage` already receives, plus `agentName` / `agentDescription`. None of the 15 framework adapters extend it:

```
SimpleAdapter (direct):    ClaudeSDK, Codex, Opencode, GoogleADK, LangGraph,
                           Letta, Parlant, both ACP, both A2A adapters
ToolCallingAdapter:        Anthropic, OpenAI, Gemini, VercelAISDK
GenericAdapter:            packages/sdk/examples/basic/basic-agent.ts (consumer)
```

The real contract is `FrameworkAdapter` in `contracts/protocols.ts:219`, which `SimpleAdapter` implements.

**Impact** — Three different "base classes" coexist (`SimpleAdapter`, `ToolCallingAdapter`, `GenericAdapter`) and the one named `Generic` is the most specific. A consumer writing a custom adapter is likely to reach for `GenericAdapter` first because of the name, even though `SimpleAdapter` is the actual generalisation point. The intended public contract `FrameworkAdapter` is undocumented as such.

**Fix** — Either rename `GenericAdapter` to `HandlerAdapter` / `CallbackAdapter` so users understand it as one option among many, or remove it and document `extends SimpleAdapter` as the way to build a custom adapter. Document `FrameworkAdapter` as the contract.

[↑ Summary in review.md M13](../review.md#m13-adaptersshared-and-converters-boundary-leaks-both-ways)

#### Per-room session bookkeeping is reimplemented in six adapters
*Major · Effort: M · 6 adapter files (see Locations below)*

**Observation** — Every long-lived adapter independently maintains `Map<roomId, sessionId>`, an `*InitPromises` map to guard concurrent bootstrap, and a per-room cleanup. The pattern is repeated almost verbatim across six adapters (Letta, Parlant, Claude SDK, Codex, Opencode, ACP), including the "remove the promise from the map only if it still matches" idiom (see Letta line 540-544, Parlant line 317-321, Codex line 577-580, Claude SDK line 234-236).

**Impact** — Maintenance burden — future fixes to the init-promise lifecycle or cleanup correctness must be applied to every adapter independently, and any deviation between them is a latent behavioural bug.

**Fix** — Extract a generic `RoomSessionRegistry<TSession>` with `get(roomId)`, `getOrCreate(roomId, () => Promise<TSession>)`, and `cleanup(roomId)` that owns the init-promise lifecycle, then let adapters hold one of these instead of six maps. Cleanup correctness today depends on every author remembering the same "if (promises.get(roomId) === initPromise) promises.delete(roomId)" dance; that's exactly the kind of thing that belongs in shared infrastructure.

**Locations:**
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:261-270` (six maps + lock map)
- `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:108-112` (four maps)
- `packages/sdk/src/adapters/claude-sdk/ClaudeSDKAdapter.ts:171-173` (three maps)
- `packages/sdk/src/adapters/codex/CodexAdapter.ts:141-143` (three maps)
- `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:179-180` + `RoomState` (huge)
- `packages/sdk/src/adapters/acp/ThenvoiACPServerAdapter.ts:48-54` (seven maps)

#### Verbatim duplication between Letta and Parlant
*Major · Effort: S · 2 adapter pairs (see Locations below)*

**Observation** — The Letta version of `selectCompleteExchanges` is more careful (it merges consecutive same-role entries before pairing user→assistant turns; the Parlant version silently drops them — see Letta lines 996-1005 vs Parlant lines 552-573), so the divergence is also a behavioural bug between two adapters that ought to be doing the same thing. Side-by-side:

```ts
// adapters/letta/LettaAdapter.ts (~993): merge consecutive same-role
for (const msg of history) {
  if (!msg.content) continue;
  const prev = merged[merged.length - 1];
  if (prev && prev.role === msg.role) prev.content += `\n${msg.content}`;
  else merged.push({ ...msg });
}

// adapters/parlant/ParlantAdapter.ts (~549): require a user→assistant pair
while (index < history.length) {
  const current = history[index];
  if (current.role === "user" && current.content) {
    const next = history[index + 1];
    if (next && next.role === "assistant" && next.content) {
      complete.push(current); complete.push(next); index += 2; continue;
    }
    index += 1; continue;   // ← unpaired user message silently dropped
  }
  index += 1;
}
```

**Impact** — Maintenance burden — any fix to `selectCompleteExchanges` or the shared message type must be applied twice, and the two implementations have already diverged in behaviour.

**Fix** — Move both message types to `adapters/shared/types.ts` as a single `ChatTurn` (or whatever), and move `selectCompleteExchanges` / `mergeConsecutiveSameRole` to `adapters/shared/history.ts` next to `findLatestTaskMetadata`. Use the merging variant unconditionally.

**Locations:**
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:993-1037` vs `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:549-574` — both export `selectCompleteExchanges`.
- `packages/sdk/src/adapters/letta/types.ts:1-63` vs `packages/sdk/src/adapters/parlant/types.ts:1-63` — `LettaMessage` and `ParlantMessage` are byte-for-byte identical except for the type name; their `HistoryConverter` implementations are identical except for the class name.

**See also:** [ParlantAdapter's selectCompleteExchanges silently drops consecutive same-role messages](#parlantadapters-selectcompleteexchanges-silently-drops-consecutive-same-role-messages) — the user-visible behavioural consequence of this duplication.

[↑ Summary in review.md M6](../review.md#m6-coercion-and-error-extraction-helpers-duplicated-across-the-tree)

#### `ParlantAdapter`'s `selectCompleteExchanges` silently drops consecutive same-role messages
*Major · Effort: S · `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:549-574`*

**Observation** — `selectCompleteExchanges` looks for strict user→assistant pairs and silently drops every other shape. In a multi-participant Thenvoi room where several users speak before the agent replies, every user message except the last one in the pair will be invisible to Parlant. Letta's version (`LettaAdapter.ts:993`) merges consecutive same-role entries before pairing; Parlant never got that step.

**Impact** — Silent data loss in multi-participant rooms — user messages disappear from the conversation history sent to Parlant, with no log, no error, and no caller-visible signal. The agent responds to truncated context, and there is no way to detect this happened from outside the adapter.

**Fix** — Replace Parlant's `selectCompleteExchanges` with Letta's merging variant; the two functions should share a single implementation (see the "Verbatim duplication" finding above for the deduplication path). As a minimum patch before deduplication, port the merge-consecutive-same-role step (`LettaAdapter.ts:996-1005`) into Parlant.

**See also:** [Verbatim duplication between Letta and Parlant](#verbatim-duplication-between-letta-and-parlant) — the duplication is what enabled this divergence to happen unnoticed.

#### `*Like` shadow interfaces for external SDKs duplicate upstream types
*Major · Effort: M · 6 adapter files (see Locations below)*

**Observation** — Every model adapter declares its own minimal interface for the SDK it wraps. This decouples runtime loading from compile-time types, but it also lies to the type checker: if Anthropic's `messages.create` signature changes, nothing in `anthropic/model.ts` will catch it because `AnthropicClientLike` is hand-rolled with `Record<string, unknown>` params. Codex shows the correct pattern: it does `import type { ModelReasoningEffort, WebSearchMode } from "@openai/codex-sdk"` (`CodexAdapter.ts:1`) — types come from the upstream package, only the runtime import is dynamic.

**Impact** — Upstream SDK signature changes will not be caught at compile time; the hand-rolled interfaces are effectively untyped stubs that mask breaking changes from peer SDK upgrades.

**Fix** — Use `import type { X } from "<peer>"` for the surface of every dynamically-loaded peer SDK. `optional-deps.d.ts` (line 5, 6, 10, 11, 12) currently declares these modules as empty `declare module "..."` which is *why* the SDK needs `*Like` interfaces — fix the d.ts to import the real types, or drop those entries entirely (the peers are listed in `devDependencies`, so their types are installed). Keep `*Like` only as a test seam, exposed via `clientFactory`.

**Locations:**
- `packages/sdk/src/adapters/anthropic/model.ts:20-24` (`AnthropicClientLike`)
- `packages/sdk/src/adapters/openai/model.ts:24-30` (`OpenAIClientLike`)
- `packages/sdk/src/adapters/gemini/model.ts:48-52` (`GeminiClientLike`)
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:79-94` (`LettaClientLike`)
- `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:16-66` (`ParlantClientLike`)
- `packages/sdk/src/adapters/google-adk/GoogleADKAdapter.ts:57-78` (`GoogleAdkSdkLike`)

#### `converters/index.ts` re-exports from `adapters/`, a wrong-way boundary
*Major · Effort: S · `packages/sdk/src/converters/index.ts:17-22, :31-34, :36-40`*

**Observation** — `converters/index.ts` re-exports `A2AHistoryConverter` and `A2AAuth` from `../adapters/a2a`, `GatewayHistoryConverter` from `../adapters/a2a-gateway`, and `ParlantHistoryConverter` from `../adapters/parlant`. Meanwhile, `Anthropic` / `Gemini` / `LangChain` / `Vercel AI SDK` / `Codex` / `Claude SDK` / `Google ADK` / `Opencode` converters live in `converters/`. Two adapters (`Letta`, `Parlant`) put their `HistoryConverter` next to the adapter *and* there's nothing in `converters/letta.ts`. `Codex` and `Claude SDK` have converters in `converters/` but their `HistoryConverter` is only used via the `extractClaudeSessionId` / `extractCodexSessionId` helpers.

**Impact** — The boundary between `converters/` and `adapters/` is circular in one direction, making the module graph harder to reason about and blocking future extraction of `converters/` into its own package.

**Fix** — Either move every `HistoryConverter` into `converters/` (so the converters package owns conversion) or every one into the adapter folder (so each adapter owns its own conversion). The current half-and-half makes barrel exports go back across the boundary and breaks "feature-based organisation". The latter is probably the cleaner choice given how tightly each converter couples with its adapter.

[↑ Summary in review.md M13](../review.md#m13-adaptersshared-and-converters-boundary-leaks-both-ways)

#### `loadXClientFactory` is reinvented per adapter
*Major · Effort: M · 8 adapter files (see Locations below)*

**Observation** — Each of these functions does the same three things: (a) `await import("<peer>").catch(...)` and rethrow as `UnsupportedFeatureError`, (b) pluck a named export (and sometimes fall back to `default`), (c) return a factory. Differences are cosmetic (different error message wording, different fallback export names).

**Impact** — Maintenance burden — ~120 lines of near-identical boilerplate spread across 8 files; any change to error format or retry behaviour must be replicated in every adapter.

**Fix** — Add a small helper in `adapters/shared/optionalPeer.ts`:
```ts
export async function loadOptionalPeer<T>(
  moduleName: string,
  label: string,
  extract: (mod: Record<string, unknown>) => T | undefined,
): Promise<T> { ... }
```
and let each adapter call `loadOptionalPeer("@anthropic-ai/sdk", "AnthropicAdapter", (m) => m.default ?? m.Anthropic)`. Removes ~120 lines of boilerplate and centralises the error message format.

**Locations:**
- `packages/sdk/src/adapters/anthropic/model.ts:180-198`
- `packages/sdk/src/adapters/openai/model.ts:246-264`
- `packages/sdk/src/adapters/gemini/model.ts:296-312`
- `packages/sdk/src/adapters/vercel-ai-sdk/model.ts:195-215`
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:1078-1111`
- `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:596-623`
- `packages/sdk/src/adapters/claude-sdk/ClaudeSDKAdapter.ts:361-375`
- `packages/sdk/src/adapters/google-adk/GoogleADKAdapter.ts:125-169`

[↑ Summary in review.md M6](../review.md#m6-coercion-and-error-extraction-helpers-duplicated-across-the-tree)

#### `optional-deps.d.ts` empty module declarations silently widen types
*Major · Effort: M · `packages/sdk/src/optional-deps.d.ts:1-12`*

**Observation** — Every entry in this file is `declare module "<peer>";` with no body. That makes the module `any`-shaped at the type level, which is why downstream code is forced into `*Like` shadow interfaces and casts like `module as { default?: new (...) => AnthropicClientLike }` (every `loadXClientFactory`). It also means that within `adapters/`, an `import type { Anthropic } from "@anthropic-ai/sdk"` would silently bind to `any` even though the peer is in `devDependencies`. This is the root cause of the previous finding.

**Impact** — All optional-peer imports resolve to `any`, bypassing TypeScript's type checker for the entire surface of each wrapped SDK and masking every upstream API change.

**Fix** — Delete `optional-deps.d.ts` entirely. Every peer it declares is listed in `devDependencies` (`@a2a-js/sdk` is the lone exception — keep that one). With the d.ts gone, `import type` will resolve to the real package types, the `*Like` interfaces shrink to test seams, and there is no more `as any`-shaped widening at the dynamic-import boundary.

[↑ Summary in review.md M2](../review.md#m2-srcoptional-depsdts-erases-peer-sdk-types-at-build-time)

#### `LazyAsyncValue` retry behaviour can mask init failures forever
*Major · Effort: S · `packages/sdk/src/adapters/shared/lazyAsyncValue.ts:27-54`*

**Observation** — On failure, `lastFailureAt` is set and the next `get()` within `retryBackoffMs` throws a *generic* `"LazyAsyncValue load failed recently; retrying after Xms backoff."` — the original error is gone, with no `cause`. Adapters that gate on `clientLoader.current` (Parlant line 525, Letta line 945-947) will paper over the real failure with this opaque retry message and the caller will never see why the peer failed to initialise.

**Impact** — When peer initialisation fails, the root cause is silently discarded after the first attempt; all subsequent errors report only a generic backoff message, making failures very hard to diagnose.

**Fix** — Wrap with `new Error(..., { cause: lastError })`, store `lastError` alongside `lastFailureAt`. Better still, throw a custom `LazyAsyncValueRetryError` so adapters can differentiate "still-in-backoff" from a fresh `UnsupportedFeatureError`.

#### Anthropic merges `system` role into `user` content silently
*Major · Effort: S · `packages/sdk/src/adapters/anthropic/model.ts:112-131`*

**Observation** — `toAnthropicMessageWithSystemAsUser` rewrites any `system`-roled history entry as a `user` message with `[System]: ...` prefix. Anthropic's API does accept a single top-level `system: ...` field (which `complete()` uses for `request.systemPrompt`), but historical system entries within the message stream get folded into user turns and become indistinguishable from real user input. This is intentional, but undocumented, and asymmetric with `OpenAIToolCallingModel` which preserves system role. The OpenAI version supports an arbitrary number of system messages mid-stream; Anthropic version collapses them all to user-prefixed turns.

**Impact** — Undocumented behaviour that leaks system-role history into the conversation as user turns; callers relying on role semantics for Anthropic will get silent wrong results with no indication anything is amiss.

**Fix** — Document the behaviour in a JSDoc on `toAnthropicMessageWithSystemAsUser` (and on `AnthropicToolCallingModel.complete`), noting that Anthropic only honours the top-level `system` field. Consider buffering historical system messages and prepending them to the top-level `system` instead of inlining as user turns; today they leak into the conversation pretending to be user input.

#### Custom MCP backend bridge factory wires through a static-typed `LazyAsyncValue` of a function
*Major · Effort: S · `packages/sdk/src/adapters/claude-sdk/ClaudeSDKAdapter.ts:99-156`*

**Observation** — The module-level `thenvoiMcpBridgeFactory` is a `LazyAsyncValue<ThenvoiMcpBridgeFactory>` whose `load()` reads `@anthropic-ai/claude-agent-sdk` and returns a function that closes over the bridge runtime, but the function it returns is shared across every `ClaudeSDKAdapter` instance because the `LazyAsyncValue` lives in module scope (line 99). Multiple `ClaudeSDKAdapter` instances will share the same cached `tool` factory. That's accidental, fragile, and undocumented.

**Impact** — Multiple `ClaudeSDKAdapter` instances silently share a single cached factory; any state held in the factory closure is unintentionally shared across instances, which is a latent correctness bug.

**Fix** — Move the loader inside the class (instance property), or document why a process-wide cache is correct. Today the comment on line 99 is silent.

### Minor

#### `SimpleAdapter` types the tools generic but `GenericAdapter` ignores it
*Minor · Effort: S · `src/adapters/GenericAdapter.ts:17-44`, `src/core/simpleAdapter.ts:19`*

**Observation** — `SimpleAdapter<H, TTools = AdapterToolsProtocol>`, but `GenericAdapter extends SimpleAdapter<HistoryProvider>` hard-codes `AdapterToolsProtocol`. The handler signature on line 7 forces `AdapterToolsProtocol`. There is no way to compose `GenericAdapter` with a narrower tool set. Compare with `ParlantAdapter extends SimpleAdapter<ParlantMessages, MessagingTools>` (line 90) which legitimately narrows.

**Impact** — Consumers extending `GenericAdapter` always receive the full `AdapterToolsProtocol` and cannot narrow it, reducing type safety for adapters that only need a subset of tools.

**Fix** — Either thread the `TTools` generic through `GenericAdapter` or document that this base class always exposes the full protocol.

#### `AdapterToolsProtocol` declares partials of `ContactTools` / `MemoryTools` / `PeerLookupTools` — every consumer must null-check
*Minor · Effort: S · `packages/sdk/src/contracts/protocols.ts:166-177`*

**Observation** — The protocol composes `Partial<ContactTools>`, `Partial<MemoryTools>`, `Partial<PeerLookupTools>` and adds a `capabilities` field, but `AdapterToolsProtocol` also extends `RoomParticipantTools` (which extends `RoomParticipantTools`, not `PeerLookupTools`). So `lookupPeers` is `Partial`-optional via two paths (line 163 makes `ParticipantTools extends RoomParticipantTools, PeerLookupTools`, line 172 makes it `Partial<PeerLookupTools>`). Pick one; adapters use `tools.capabilities.peers` (good) but the type would let you call `lookupPeers()` without checking.

**Impact** — The duplicate optionality paths allow `tools.lookupPeers` to appear required to TypeScript while being absent at runtime, causing potential unchecked call-site errors.

**Fix** — Drop the `extends RoomParticipantTools, PeerLookupTools` unification on `ParticipantTools` line 163, or align so the only optional path is via `Partial`. The current shape lets TypeScript infer `tools.lookupPeers` is required when really it's runtime-conditional.

#### `assertCapability` exists but few adapters call it
*Minor · Effort: S · `packages/sdk/src/contracts/capabilities.ts:12-19`*

**Observation** — `assertCapability` is exported but never called from any adapter (grep finds zero usages outside the contracts file itself). Tools exposed via `getToolSchemas({ includeMemory })` rely on the schema layer to silently omit memory tools when capabilities don't allow it, but the adapters that take an `enableMemoryTools` config option (Letta, Parlant, Claude SDK, Codex, ACP, Opencode, Google ADK, LangGraph) never cross-validate against `tools.capabilities.memory`.

**Impact** — An adapter configured with `enableMemoryTools: true` against a runtime where `memory: false` silently produces best-effort behaviour instead of failing loudly, making misconfiguration invisible.

**Fix** — Either delete `assertCapability` if it's dead, or wire it into adapter init (call it once per onStarted/onMessage based on config). If an adapter is configured with `enableMemoryTools: true` but the runtime capability is `memory: false`, today the user gets silent best-effort behaviour; an assertion would fail loudly.

#### Two dead imports flagged by `npm run lint`
*Minor · Effort: S · `src/adapters/acp/ThenvoiACPServerAdapter.ts:21`, `src/adapters/google-adk/GoogleADKAdapter.ts:9`*

**Observation** — Surfaced by `npm run lint`. Both are stale imports left from refactors. `asJsonSafe` (ACP server) and `HistoryProvider` (Google ADK) — neither symbol is referenced anywhere in the importing file.

**Impact** — Minor cognitive noise; signals refactor hygiene gap. Lint flags them but the project's ESLint config treats them as warnings (not errors), so they survive CI.

**Fix** — Delete both `import` lines. Consider escalating `no-unused-vars` from `warn` to `error` in the lint config to prevent these from recurring.

#### `GoogleADKAdapter` keeps an unused `roomSessions` map
*Minor · Effort: S · `packages/sdk/src/adapters/google-adk/GoogleADKAdapter.ts:184, :240-241, :299`*

**Observation** — `roomSessions = new Map<string, string>()` is written to on line 241 (`this.roomSessions.set(context.roomId, sessionId)`) and cleared on line 299, but it's never *read*. The session id is always a fresh `randomUUID()` per message and the Runner is recreated per message (line 236), so the map is dead.

**Impact** — Dead state adds cognitive overhead when reading the adapter and implies session continuity that does not actually exist.

**Fix** — Remove the field.

#### Codex `extractLocalCommand` searches the first 5 tokens with a case-insensitive `/` check
*Minor · Effort: S · `packages/sdk/src/adapters/codex/CodexAdapter.ts:1177-1212`*

**Observation** — `command = token.slice(1).toLowerCase()` (line 1200) and `searchLimit = Math.min(tokens.length, 5)` (line 1193) — local commands like `/model`, `/status` can appear up to position 5 in the prompt and are matched case-insensitively. The case-insensitive match is undocumented and not consistent with the rest of the codebase (most regexes are case-sensitive). The "up to 5 tokens deep" lookahead is also undocumented.

**Impact** — Undocumented case-insensitive matching and positional lookahead make the command-detection logic surprising and inconsistent with the rest of the codebase.

**Fix** — Either match commands at position 0 only (the usual convention for slash commands) or document why the prefix search and the case-insensitive comparison are needed.

#### Many adapters log to `error` for *expected* runtime states
*Minor · Effort: S · `parlant/ParlantAdapter.ts:137`, `letta/LettaAdapter.ts:307`, `codex/CodexAdapter.ts:475`*

**Observation** — Client-initialisation failures are logged at `error` from inside `onRejected` of `LazyAsyncValue`, which fires once per failed attempt. Combined with the retry-backoff path (`lazyAsyncValue.ts:33`), a peer that's misconfigured produces an `error` log every time the SDK touches the loader. Parlant additionally tracks `lastInitFailure` *outside* the loader and produces a separate cooldown error (line 532). The intent is fine but the log noise is heavy for expected configuration issues.

**Impact** — A misconfigured peer produces repeated `error`-level log entries on every retry hit, making it hard to distinguish genuine errors from expected backoff noise.

**Fix** — Log first-failure at `error`, subsequent backoff hits at `warn` or `debug`. Or move the "I tried, here's why" log to the catch path in the adapter, not `onRejected` on the loader.

#### `mergeConsecutiveSameRole` lives in `tool-calling/valueUtils.ts` but is also reimplemented in `gemini/model.ts`
*Minor · Effort: S · `tool-calling/valueUtils.ts:26-44`, `gemini/model.ts:19-37`*

**Observation** — The Gemini adapter has its own `mergeConsecutiveGeminiContents` because Gemini uses `parts: Array<...>` instead of `content: string`. The pattern is the same; the data is different. Could share a generic `mergeConsecutiveSameRole<T>(items, mergeContent)` helper.

**Impact** — Two implementations of the same algorithm diverge independently; a fix to merge logic must be applied in both places.

**Fix** — Generalise.

#### `Adapter` re-exports `OpencodeAdapter` but not `OpencodeAdapterOptions`
*Minor · Effort: S · `packages/sdk/src/adapters/index.ts:98-107`*

**Observation** — Index exports `type OpencodeAdapterConfig` but not the options interface accepted by the constructor (`OpencodeAdapterOptions` is declared `interface` in `OpencodeAdapter.ts:100` but never exported). Most other adapters expose both. Symmetry matters for callers using factory-style configuration.

**Impact** — Callers cannot reference `OpencodeAdapterOptions` by name without reaching into the adapter's internal file, breaking the public API contract.

**Fix** — Export `OpencodeAdapterOptions` (currently `interface OpencodeAdapterOptions` on line 100 of `OpencodeAdapter.ts` without `export`).

#### `extractThreadIdFromHistory` lives in `CodexAdapter.ts` alongside `extractCodexSessionId` in `converters/codex.ts` — same logic, two homes
*Minor · Effort: S · `codex/CodexAdapter.ts:1214-1223`, `converters/codex.ts:36-43`*

**Observation** — Identical implementation (both call `findLatestTaskMetadata` looking at `codex_thread_id`). Same for `extractClaudeSessionId` (only defined in `converters/claude-sdk.ts`, but used directly by `ClaudeSDKAdapter.ts:11`). Codex chose to inline a second copy; Claude SDK chose to import. Pick one pattern.

**Impact** — The inlined duplicate in CodexAdapter will silently diverge from the canonical version in `converters/` if either is changed independently.

**Fix** — Delete the inline copy in CodexAdapter, import `extractCodexSessionId`.

### Nits

#### Some adapters use `String(value ?? "")`, others use `asNonEmptyString`
*Nit · Effort: S · `langgraph/LangGraphAdapter.ts:225`, `a2a-gateway/A2AGatewayAdapter.ts:649`, `google-adk/GoogleADKAdapter.ts:438`*

**Observation** — `String(entry.sender_type ?? "")` is the older idiom; `asNonEmptyString(value)` from `shared/coercion.ts` is the newer one. Both styles appear within the same file (Codex uses both, LangGraph uses both, ACP uses both). Pick one.

**Impact** — Inconsistent string-coercion idioms add friction when reading the codebase and risk subtle semantic differences if the two approaches ever diverge.

**Fix** — Codify in a comment in `coercion.ts` and migrate.

#### `A2AAdapter` type guards: clean up as part of M2, not before
*Nit · Effort: S · `packages/sdk/src/adapters/a2a/A2AAdapter.ts:611-708`*

**Observation** — The internal `isRecord` + `isOptionalString` + `isMessagePart` + `isMessageLike` + `isStatusLike` + ... chain re-declares almost everything `@a2a-js/sdk` already exports. These are proper type guards (no `as any`) — the duplication exists *because* `optional-deps.d.ts` erases the peer's types (see M2). They will silently drift from upstream as the SDK evolves.

**Impact** — These guards look like a standalone cleanup target but aren't — fixing them independently of M2 just rewrites the same wheel against the same erased types. The duplication eliminates itself as a side-effect of the M2 cleanup.

**Fix** — Resolve as part of the M2 cleanup: once `optional-deps.d.ts` is removed and `@a2a-js/sdk` types are reachable, rewrite these guards using the SDK's own types (or delete the guards that the SDK already provides equivalent narrowing for). Listed here so it's not missed during M2 follow-up.

#### `ParlantAdapter`'s `asNumber` is private to that file but identical to a candidate utility
*Nit · Effort: S · `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:674-680`*

**Observation** — Could live in `shared/coercion.ts`.

**Impact** — Minor — a useful utility is hidden inside an adapter file and unavailable to other adapters that may need the same coercion.

**Fix** — Move to `shared/coercion.ts` and import from there.

#### `Letta`'s `MAX_HISTORY_CHARS` is a magic number with a comment instead of a config option
*Nit · Effort: S · `packages/sdk/src/adapters/letta/LettaAdapter.ts:233`*

**Observation** — 32 000 chars budget is documented as ≈8 000 tokens. Other adapters expose `maxHistoryMessages` as a configurable option; this one is hard-coded.

**Impact** — Users cannot tune the history character budget without forking the adapter; the hard-coded value may be wrong for different model deployments.

**Fix** — Expose `maxHistoryChars` as an optional constructor parameter with the current value as the default.

#### `GenericAdapter`'s exported callback type is named `GenericAdapterHandler`, breaking the `On{Action}Callback` convention
*Nit · Effort: S · `packages/sdk/src/adapters/GenericAdapter.ts:5`*

**Observation** — Should be `OnMessageCallback` or `GenericAdapterOnMessageCallback`.

**Impact** — Inconsistent naming makes the type harder to discover and signals to consumers that the naming convention is not enforced.

**Fix** — Rename to `OnMessageCallback` or `GenericAdapterOnMessageCallback` and update all references.

#### Static imports of `@agentclientprotocol/sdk` in ACP files are type-only but visually mix with runtime imports
*Nit · Effort: S · 5 ACP files (see Locations below)*

**Observation** — Consistent now (all `import type`), but the boundary test (`adapters-import-boundary.test.ts`) is the only enforcement. Adding an ESLint rule `no-restricted-syntax` to forbid non-`type` imports from those peers would be cheaper than a runtime mock test.

**Impact** — Without a lint-level guard, a future contributor could accidentally introduce a non-`type` import of the ACP peer and only discover the problem at runtime.

**Fix** — Add an ESLint `no-restricted-syntax` rule (or `no-restricted-imports`) to forbid value imports of the optional peers, making the boundary mechanically enforced.

**Locations:**
- `packages/sdk/src/adapters/acp/ACPClientAdapter.ts:4`
- `packages/sdk/src/adapters/acp/ACPServer.ts:3`
- `packages/sdk/src/adapters/acp/ThenvoiACPServerAdapter.ts:3`
- `packages/sdk/src/adapters/acp/client.ts:1`
- `packages/sdk/src/adapters/acp/types.ts:1`

## Adapter consistency matrix

|         Adapter         |    Uses contract base   |  Optional peer import strategy  | Has `onCleanup` | Has `onRuntimeStop` |  Typed errors  | Has tests |
|-------------------------|-------------------------|---------------------------------|-----------------|---------------------|----------------|-----------|
| GenericAdapter          | extends SimpleAdapter   | N/A                             | inherits no-op  | no                  | no             | no        |
| AnthropicAdapter        | extends ToolCallingAdapter | dynamic via LazyAsyncValue   | inherits no-op  | no                  | UnsupportedFeatureError | yes (anthropic-adapter-sdk.test) |
| OpenAIAdapter           | extends ToolCallingAdapter | dynamic via LazyAsyncValue   | inherits no-op  | no                  | UnsupportedFeatureError | yes (openai-adapter-sdk.test) |
| GeminiAdapter           | extends ToolCallingAdapter | dynamic via LazyAsyncValue   | inherits no-op  | no                  | UnsupportedFeatureError | yes (gemini-adapter-sdk.test) |
| VercelAISDKAdapter      | extends ToolCallingAdapter | dynamic via LazyAsyncValue   | inherits no-op  | no                  | UnsupportedFeatureError | yes (vercel-ai-sdk-adapter.test) |
| ClaudeSDKAdapter        | extends SimpleAdapter   | dynamic via LazyAsyncValue + ad-hoc | yes (room maps)  | no                  | UnsupportedFeatureError | yes (claude-sdk-adapter.test) |
| CodexAdapter            | extends SimpleAdapter   | dynamic via inline import (no Lazy wrapper) | yes (room maps) | yes              | CodexJsonRpcError | yes (codex-adapter.test) |
| OpencodeAdapter         | extends SimpleAdapter   | dynamic via cachedSdkPromise (not Lazy) | yes (RoomState) | yes              | HttpStatusError  | yes (opencode-adapter.test) |
| GoogleADKAdapter        | extends SimpleAdapter   | dynamic via LazyAsyncValue   | yes (room maps) | no                  | plain Error    | yes (google-adk-adapter.test) |
| LangGraphAdapter        | extends SimpleAdapter   | dynamic via LazyAsyncValue + Promise.all | yes (bootstrap set) | no              | UnsupportedFeatureError + ValidationError + RuntimeStateError | yes (langgraph-adapter.test) |
| LettaAdapter            | extends SimpleAdapter   | dynamic via LazyAsyncValue   | yes (room maps + abort controllers) | no    | UnsupportedFeatureError + RuntimeStateError | yes (letta-adapter.test) |
| ParlantAdapter          | extends SimpleAdapter   | dynamic via LazyAsyncValue   | yes (room maps) | no                  | UnsupportedFeatureError | yes (parlant-adapter.test) |
| A2AAdapter              | extends SimpleAdapter   | dynamic via ad-hoc try/catch | yes (room maps) | no                  | UnsupportedFeatureError + ValidationError | yes (a2a-adapter.test) |
| A2AGatewayAdapter       | extends SimpleAdapter   | N/A (server, not client of peer) | yes (room maps + queues) | yes      | UnsupportedFeatureError + ValidationError | yes (a2a-gateway-adapter.test) |
| ACPClientAdapter        | extends SimpleAdapter   | dynamic via LazyAsyncValue (loader.ts) | yes (room + backend) | yes        | plain Error    | yes (acp-client-adapter.test) |
| ThenvoiACPServerAdapter | extends SimpleAdapter   | dynamic via LazyAsyncValue (loader.ts) | yes (room maps + pending) | yes  | plain Error    | yes (acp-server-adapter.test) |

Inconsistencies the matrix highlights:

- **Peer-loading style:** 9 of 15 use `LazyAsyncValue`, but Codex uses an
  ad-hoc state machine (`client`/`clientPromise`/`lastInitFailure`,
  CodexAdapter.ts:138-141, 439-485), Opencode uses a module-level
  `cachedSdkPromise` (client.ts:102), A2A uses a `try/catch` around `await
  import` (A2AAdapter.ts:710-734), and Anthropic/OpenAI/Gemini/Vercel all use
  `LazyAsyncValue` but with their own boilerplate around it. There is no
  single "this is how the SDK loads an optional peer" pattern.
- **`onRuntimeStop`:** 5 of 15 implement it (Codex, Opencode, A2A-gateway,
  ACPClient, ACPServer). The rest don't. `FrameworkAdapter.onRuntimeStop`
  (contracts/protocols.ts:223) is optional, so this is technically fine, but
  it means model adapters (Anthropic/OpenAI/Gemini/Vercel) hold no
  reset-on-shutdown semantics for their `LazyAsyncValue` client — at runtime
  shutdown the cached client still leaks.
- **Typed errors:** Mixed — the four model adapters and most of the agent
  adapters throw `UnsupportedFeatureError`; Codex defines its own
  `CodexJsonRpcError`; Opencode defines its own `HttpStatusError`; Google ADK
  and both ACP adapters throw plain `Error`. There is no `AdapterError` base
  class, so a consumer wrapping multiple adapters can't catch "any adapter
  failure" without enumerating types.

## Strengths worth keeping

- **No `any`, no `@ts-ignore`, no `@ts-expect-error`** anywhere under
  `src/adapters`, `src/converters`, `src/contracts`, or `src/integrations`.
  This is rare for a 14-adapter interop layer and worth keeping.
- **Import-boundary test** (`tests/adapters-import-boundary.test.ts`) is
  exactly the right shape: it mocks the optional peers to throw and asserts
  the adapters entrypoint still resolves. Suggests adding it for every peer
  group (Google ADK, Letta, Parlant, etc.) — today it only covers ACP and
  Claude SDK.
- **Every adapter that holds long-lived state implements `onCleanup`** —
  Letta's cleanup is particularly thoughtful (lines 421-471 of LettaAdapter)
  with `cleaningUpRooms`, abort controllers, and `Promise.allSettled` on
  pending operations to avoid orphans. Worth promoting to the documented
  pattern in "Resource Cleanup Patterns".
- **`runSingleToolRound`** (tool-calling/ToolCallingAdapter.ts:261) wraps
  model errors with `{ cause: error }` properly. The pattern should propagate.
- **`isToolExecutorError` / `toLegacyToolExecutorErrorMessage`** in
  contracts/protocols.ts:135-161 is a clean, typed runtime type guard +
  back-compat shim. Exactly the kind of thing "Runtime Type Checking
  Patterns" asks for.
- **Codex's use of `import type` from `@openai/codex-sdk`** at line 1 of
  CodexAdapter.ts is the right approach to optional-peer types and a good
  template for the other adapters once `optional-deps.d.ts` is cleaned up.
- **`tsup.config.ts` `EXTERNAL` array** correctly externalises every
  optional peer plus their subpaths (`@a2a-js/sdk/client`,
  `@opencode-ai/sdk/v2/client`, etc.). The bundle therefore can't accidentally
  inline a peer it shouldn't.
- **The `FrameworkAdapter` interface in contracts/protocols.ts:219-224** is
  small and focused (`onEvent`, `onCleanup`, `onStarted`, optional
  `onRuntimeStop`). The fact that 15 adapters implement it transitively
  through `SimpleAdapter` is good — the only refactoring opportunity is
  making `GenericAdapter`'s role honest (see major finding).

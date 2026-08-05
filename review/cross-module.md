[← Back to top-level review](../review.md)

# Cross-module Consistency and Architecture Review

## Summary

The SDK is broadly well-layered (`platform` <- `runtime` <- `agent` at the core, with `adapters/`, `converters/`, `mcp/`, `integrations/linear/` as vertical slices). Module dependency direction is mostly acyclic and `core/`, `contracts/`, `platform/`, `runtime/` stay vertical-agnostic — verticals never leak into the core.

**What's good:**

- `contracts/protocols.ts` is the single source of truth for protocols; no other module redefines these.
- `core/errors.ts` and `core/logger.ts` are tight, focused, and dependency-injected everywhere.
- `runtime/rooms/subscriptions.ts` is an exemplary pure-utility module.
- Module dependency direction is acyclic: verticals always point inward to `runtime`/`platform`/`contracts`/`core`.
- The `package.json` `exports` field is granular and matches the directory structure.

**What's not** — the Major findings, in rough priority order. Each link jumps to the full finding under Findings → Major. Smaller items live in Findings → Minor and → Nits below.

- [Coercion and error-message helpers are duplicated across modules](#coercion-and-error-message-helpers-are-duplicated-across-modules).
- [`adapters/shared/` is used by non-adapter modules and is named misleadingly](#adaptersshared-is-used-by-non-adapter-modules-and-is-named-misleadingly).
- [Boundary between `converters/` and `adapters/` is fuzzy](#boundary-between-converters-and-adapters-is-fuzzy).
- [Public sub-entrypoint barrels live next to implementation directories with the same name](#public-sub-entrypoint-barrels-live-next-to-the-implementation-directories-with-the-same-name).
- [Five god-files (>1000 LOC) that mix many concerns](#five-god-files-1000-loc-that-mix-many-concerns).
- [Inline event-dispatch switches that should be handler maps](#inline-event-dispatch-switches-that-should-be-handler-maps).
- [`RoomPresence` reimplements AgentRuntime's room-event loop and is unused internally](#roompresence-reimplements-agentruntimes-room-event-loop-and-is-unused-internally).
- [`On{Action}Callback` naming convention not followed for callback types](#onactioncallback-naming-convention-not-followed-for-callback-types).

## Architecture overview

Dependency direction (consumers point to providers):

```
agent/Agent
   |
   v
runtime/PlatformRuntime --> runtime/ContactEventHandler
   |                            |
   v                            v
runtime/rooms/AgentRuntime --> runtime/{Execution, ExecutionContext, formatters, prompts, tools/*}
   |
   v
platform/ThenvoiLink + platform/streaming/*
   |
   v
client/rest/* (RestFacade, FernRestAdapter, types, pagination, requestOptions)
   |
   v
contracts/{dtos, protocols, capabilities, chatEvents}, core/{errors, logger, simpleAdapter}
```

Verticals (each pulls from `contracts`, `core`, `runtime`, `platform`, sometimes `mcp`):

- `adapters/*`: per-framework `FrameworkAdapter` implementations, plus `adapters/shared/` and `adapters/tool-calling/`. Internally heterogeneous (each adapter folder organizes its own way).
- `converters/`: stateless `HistoryConverter` implementations + `converters/shared.ts` parse helpers.
- `mcp/`: standalone server stacks (HTTP, SSE, stdio, claude-sdk). `mcp/registrations.ts` is the central tool-schema builder consumed by `adapters/acp`, `adapters/claude-sdk`, `adapters/opencode`.
- `integrations/linear/`: the Linear ⇄ Thenvoi bridge. Self-contained vertical.

Public sub-entrypoints (per `package.json` `exports`): `.`, `./adapters`, `./config`, `./converters`, `./core`, `./linear`, `./mcp`, `./mcp/claude`, `./rest`, `./runtime`, `./testing`. Two of those (`linear` and `rest`) are paper-thin barrels that re-export from `integrations/linear` and `client/rest`. That two-tier directory layout is what gives the tree the apparent "duplicate folder" feel.

What feels clean:
- `contracts/` is the single source of protocol/DTO truth; no other module forks these types.
- `core/{errors,logger}` is small, no vertical leaks in.
- `runtime/index.ts` is a real curated public surface and disciplined.
- `runtime/rooms/subscriptions.ts` is a good example of pure utility (dependency-injected `link` + `trackedRooms`).
- `mcp/registrations.ts` is a focused factory module.

What feels messy:
- Coercion / error-message extraction — see Major findings.
- `adapters/shared/` has become an unofficial general-purpose utils folder for non-adapter code (`converters/` imports from it; `mcp/` reimplements the same helpers).
- `runtime/index.ts` re-exports `CHAT_EVENT_TYPES` etc. from `runtime/messages.ts`, which in turn just re-exports from `contracts/chatEvents.ts` — a pure pass-through file (see Minor findings).
- `adapters/*` is the most heterogeneous module: each vendor folder picks its own internal layout (some have a `types.ts`, some don't; some have a `model.ts`, some don't; ACP has nine implementation files).

## Findings

### Blockers

_None — no module dependency cycles, no vertical leakage into `core/`/`runtime/`, no foundational rewrite required._

### Major

#### Coercion and error-message helpers are duplicated across modules
*Major · Effort: M · 7 locations (see Locations below)*

**Observation** — `adapters/shared/coercion.ts` already exports `asNonEmptyString`, `asRecord`, `asString`, `asNullableString`, `toWireString`, `asErrorMessage`. But because its folder name implies "adapter-only", `converters/`, `mcp/`, `integrations/linear/`, and `client/rest/` each re-implement subsets of the same helpers. `serializeValue` in `mcp/registrations.ts:184` is the same algorithm as `toWireString` in `adapters/shared/coercion.ts:63`.

**Impact** — Every new module that needs coercion or error-message extraction re-invents the wheel, and fixes to edge cases in one copy are not reflected in the others.

**Fix** — Move `coercion.ts` (and `history.ts`'s `findLatestTaskMetadata`) out of `adapters/shared/` into a top-level `utils/` (or `core/utils/`). Replace the inline `instanceof Error ? error.message : String(error)` sites with `asErrorMessage`. Remove the local `asNonEmptyString` in `mcp/registrations.ts` and the per-file forks in `integrations/linear/store.ts`.

**Locations:**
- `packages/sdk/src/adapters/shared/coercion.ts`
- `packages/sdk/src/converters/shared.ts:14`
- `packages/sdk/src/mcp/registrations.ts:160` (`asNonEmptyString`) and `:184` (`serializeValue`)
- `packages/sdk/src/integrations/linear/store.ts:403,419,423` (`asRecord`, `asString`, `asNullableString`)
- `packages/sdk/src/client/rest/FernRestAdapter.ts:182` (`asRecordArray`)
- `packages/sdk/src/adapters/acp/ACPClientAdapter.ts:581` (`toErrorMessage`)
- Plus 33 inline `error instanceof Error ? error.message : String(error)` sites across `integrations/linear/*`, `adapters/*`, `mcp/sdk.ts`

[↑ Summary in review.md M6](../review.md#m6-coercion-and-error-extraction-helpers-duplicated-across-the-tree)

#### `adapters/shared/` is used by non-adapter modules and is named misleadingly
*Major · Effort: S · `packages/sdk/src/adapters/shared/`*

**Observation** — `adapters/shared/coercion.ts` and `adapters/shared/history.ts` are not adapter-specific — `converters/` already imports them (see `packages/sdk/src/converters/codex.ts:2`, `packages/sdk/src/converters/claude-sdk.ts:2`, `packages/sdk/src/converters/opencode.ts:1`, `packages/sdk/src/converters/google-adk.ts:1`). The folder name signals scoping that the code does not respect.

**Impact** — Developers working in `converters/`, `mcp/`, or `integrations/linear/` don't discover the shared utilities and re-implement them instead.

**Fix** — Move general-purpose helpers (`coercion.ts`, `history.ts`, `lazyAsyncValue.ts`) to a top-level `utils/` directory. Keep only adapter-specific helpers (e.g., `conversationPrompt.ts`, which depends on `runtime/types`) under `adapters/shared/`. Rename `adapters/shared/` to something like `adapters/common/` if anything stays.

[↑ Summary in review.md M13](../review.md#m13-adaptersshared-and-converters-boundary-leaks-both-ways)

#### Boundary between `converters/` and `adapters/` is fuzzy
*Major · Effort: M · `packages/sdk/src/converters/index.ts:17-40`*

**Observation** — `converters/index.ts:17-40` re-exports `A2AHistoryConverter`, `GatewayHistoryConverter`, `ParlantHistoryConverter` from `../adapters/a2a`, `../adapters/a2a-gateway`, `../adapters/parlant`. Meanwhile `converters/anthropic.ts`, `converters/google-adk.ts`, `converters/claude-sdk.ts`, etc. live under `converters/` directly. And `converters/codex.ts:2` and three other files reach back into `adapters/shared/history.ts`. Some history converters are inside their adapter folder; others are inside the parallel `converters/` folder. Reaching from `converters/` into `adapters/` and vice-versa creates an implicit cycle on the directory level even though the file-level graph is acyclic.

**Impact** — The intended boundary between "history converter (pure)" and "framework adapter (stateful)" is not enforced; contributors adding a new adapter must decide which convention to follow with no clear guidance.

**Fix** — Pick one home. Either (a) move every converter into its own adapter folder (then `converters/index.ts` becomes a pure barrel that pulls from `adapters/*`), or (b) move `A2AHistoryConverter`, `GatewayHistoryConverter`, `ParlantHistoryConverter` into `converters/` so the directory is the single source of truth for history-conversion logic.

[↑ Summary in review.md M13](../review.md#m13-adaptersshared-and-converters-boundary-leaks-both-ways)

#### Public sub-entrypoint barrels live next to the implementation directories with the same name
*Major · Effort: S · 2 barrel files (see Locations below)*

**Observation** — `src/linear` and `src/integrations/linear` exist side by side. Same for `src/rest` and `src/client/rest`. Both are intentional — the top-level dirs are the `@thenvoi/sdk/linear` and `@thenvoi/sdk/rest` package entrypoints — but for anyone navigating the tree this looks like a duplicate or a circular re-export. Worsened by the fact that `src/linear/index.ts` lists every export name explicitly (~50 lines) instead of `export *`.

**Impact** — New contributors waste time discovering which directory holds the actual implementation, and manually enumerated re-exports fall out of sync (already missing `getAgentSessionEventKey`).

**Fix** — Either co-locate the entrypoint barrel inside the implementation directory (e.g., `integrations/linear/public.ts` with `package.json` exports pointing at it), or rename the entrypoint dirs to make their role explicit (`src/entrypoints/linear/`). At minimum switch `src/linear/index.ts` and `src/rest/index.ts` to `export *` per "Module and Import Patterns".

**Locations:**
- `packages/sdk/src/linear/index.ts` (re-export from `../integrations/linear`)
- `packages/sdk/src/rest/index.ts` (re-export from `../client/rest/*`)

#### Five god-files (>1000 LOC) that mix many concerns
*Major · Effort: L · 5 source files (see Locations below)*

**Observation** — Each of these files mixes class state, RPC/event handling, helper functions, and adapter-specific types. CodexAdapter mixes the `ToolLikeItem`/`ThoughtLikeItem` union types, the class, and tool-call dispatching. AgentTools mixes the giant `TOOL_MODELS`-driven `toolHandlers` map with per-tool argument validators and adapter wiring.

**Impact** — Files this large are difficult to review, test in isolation, and extend — a change to one concern risks breaking another in the same file.

**Fix** — For each, extract (a) constants/types into a sibling `*.types.ts`, (b) per-tool handler bodies into a sibling `handlers.ts`/`events.ts` keyed by tool name, and (c) any factory functions (`createXxx`) into their own file. The linear bridge handler especially needs a per-action breakdown (`actions/created.ts`, `actions/updated.ts`, etc.).

**Locations:**
- `packages/sdk/src/adapters/codex/CodexAdapter.ts` (1477)
- `packages/sdk/src/integrations/linear/bridge/handler.ts` (1326)
- `packages/sdk/src/runtime/tools/AgentTools.ts` (1176)
- `packages/sdk/src/adapters/letta/LettaAdapter.ts` (1111)
- `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts` (1092)

[↑ Summary in review.md M5](../review.md#m5-god-files-and-god-classes)

#### Inline event-dispatch switches that should be handler maps
*Major · Effort: M · 4 runtime files (see Locations below)*

**Observation** — Several of these switches dispatch on a discriminated-union `event.type` and are exhaustive (with `assertNever`). The `ContactCallbackTools.executeToolCall` switch is the worst offender — 16 cases all wrapping `toolArgs` and forwarding to a method.

**Impact** — Adding a new event type or tool requires editing multiple large switch blocks spread across different files.

**Fix** — Convert each to a typed handler map (`Record<EventType, (event) => Promise<void>>`). For `ContactCallbackTools.executeToolCall`, mirror the `toolHandlers` pattern already used in `AgentTools.buildToolHandlers`.

**Locations:**
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:221` (`handleEvent` switch over event.type)
- `packages/sdk/src/runtime/ContactEventHandler.ts:264,295` (two parallel switches over the same ContactEvent type)
- `packages/sdk/src/runtime/rooms/RoomPresence.ts:98`
- `packages/sdk/src/runtime/tools/ContactCallbackTools.ts:269` (`executeToolCall` switch over toolName with 16 cases)

#### `assertNever` is duplicated as a private helper in three runtime files
*Major · Effort: S · 3 runtime files (see Locations below)*

**Observation** — The first one in `PlatformRuntime.ts:335` is dead code (never called — `PlatformRuntime` doesn't use exhaustive switches).

**Impact** — Any change to the `assertNever` signature or error message must be applied in three places; the dead copy in `PlatformRuntime` adds noise.

**Fix** — Move a single `assertNever` to `core/errors.ts` (or `core/exhaustive.ts`) and delete the duplicates. Remove the dead one in PlatformRuntime.

**Locations:**
- `packages/sdk/src/runtime/PlatformRuntime.ts:335`
- `packages/sdk/src/runtime/ContactEventHandler.ts:454`
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:436`

#### `RoomPresence` reimplements AgentRuntime's room-event loop and is unused internally
*Major · Effort: M · `packages/sdk/src/runtime/rooms/RoomPresence.ts`*

**Observation** — `RoomPresence` is used only in `tests/parity-contract.test.ts` and `tests/room-presence.test.ts`. `AgentRuntime` reimplements the same `subscribeAgentRooms` + `subscribeExistingRooms` + `handleRoomAdded` + `handleRoomRemoved` flow inline. The two classes have the same lifecycle (start subscribes, stop leaves rooms) and the same event dispatch but `AgentRuntime` carries `Execution`/`ExecutionContext` orchestration on top. Today neither composes the other, so changes to the subscription logic must be made twice.

**Impact** — Subscription logic must be kept in sync between two independent implementations; `RoomPresence` is only exercised by tests, not production code paths.

**Fix** — Either have `AgentRuntime` compose a `RoomPresence` instance internally (preferred — turns RoomPresence into a real shared utility), or delete `RoomPresence` if it has no real consumers.

[↑ Summary in review.md M19](../review.md#m19-participanttracker-and-roompresence-are-unused-parallel-implementations)

#### `On{Action}Callback` naming convention not followed for callback types
*Major · Effort: M · 4 options interfaces (see Locations below)*

**Observation** — `runtime/` defines 8 named callback/handler types (`ContactEventCallback`, `MessageHandler`, `ExecutionHandler`, 4× `RoomPresence*Handler`, `ToolHandler`) — **none** use the `On{Action}Callback` convention. On top of that, `AgentRuntimeOptions` callbacks (lines 17-22) and the corresponding class fields (`:35-40`) inline near-verbatim function shapes instead of referencing named types at all. Named types would both follow the convention and deduplicate the contract.

**Impact** — The same function signature is written out multiple times in options interfaces and class fields; callers cannot reference the callback type by name for documentation or wrapping purposes.

**Fix** — Introduce `OnRoomJoinedCallback`, `OnRoomLeftCallback`, `OnParticipantAddedCallback`, `OnParticipantRemovedCallback`, `OnRuntimeErrorCallback`, etc. in `runtime/types.ts` (or a dedicated `runtime/callbacks.ts`), and reuse them in the options interfaces and class fields.

**Locations:**
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:15-22` (`AgentRuntimeOptions.onExecute/onSessionCleanup/onRoomJoined/onRoomLeft/onContactEvent/onParticipantAdded/onParticipantRemoved/onError`)
- `packages/sdk/src/runtime/PlatformRuntime.ts:28-31` (`PlatformRuntimeOptions.onParticipantAdded/onParticipantRemoved/contextFactory/roomFilter`)
- `packages/sdk/src/runtime/ContactEventHandler.ts:63-65` (`ContactEventHandlerOptions.onBroadcast/onHubEvent/onHubInit`)
- `packages/sdk/src/integrations/linear/webhook.ts:40` (`PermissionChangeCallbacks.onTeamAccessChanged/onOAuthAppRevoked`)

[↑ Summary in review.md M12](../review.md#m12-callback-type-naming-convention-not-followed)

### Minor

#### `runtime/messages.ts` is a pass-through that adds no value
*Minor · Effort: S · `packages/sdk/src/runtime/messages.ts`*

**Observation** — `runtime/index.ts` re-exports through `messages.ts` ➜ `contracts/chatEvents.ts`. The middle file does nothing.

**Impact** — One extra indirection with no value; contributors must trace through an extra file to find where the symbols are defined.

**Fix** — Replace `runtime/messages.ts` with a direct re-export in `runtime/index.ts` (or `export * from "../contracts/chatEvents"`).

#### Inconsistent `Config` vs `Options` suffix for similar concepts in adapters
*Minor · Effort: S · 2 adapter files (see Locations below)*

**Observation** — Codex/Opencode public option types are called `Config` while the (private) constructor-argument type is called `Options`. The other 10 adapters use `Options` for the public option type.

**Impact** — Inconsistent naming makes the public API harder to discover and learn — consumers looking for the Codex constructor options by analogy with other adapters will look for `CodexAdapterOptions` and not find it.

**Fix** — Rename `CodexAdapterConfig` → `CodexAdapterOptions` (and similarly for Opencode). If a `Config` distinction is intentional (e.g., runtime-tunable subset), document it once in `contracts/`.

**Locations:**
- `packages/sdk/src/adapters/codex/CodexAdapter.ts:66` (`CodexAdapterConfig` + private `CodexAdapterOptions`)
- `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:42,100` (`OpencodeAdapterConfig` + private `OpencodeAdapterOptions`)

#### File-name casing is mixed without a clear rule
*Minor · Effort: S · multiple files across `packages/sdk/src/`*

**Observation** — Both `simpleAdapter.ts`, `appServerClient.ts`, `appServerProtocol.ts`, `eventConverter.ts`, `pushHandler.ts`, `cursorExtensions.ts`, `payloadSchemas.ts` (camelCase) and `Agent.ts`, `Execution.ts`, `AgentRuntime.ts`, `ThenvoiLink.ts`, `*Adapter.ts`, `*Tools.ts` (PascalCase) coexist. ACP folder mixes both heavily. The implicit convention is "PascalCase when the file primarily defines a class" but `simpleAdapter.ts` (class `SimpleAdapter`) is camelCase, `payloadSchemas.ts` (zod schemas + types) is camelCase, while `RoomPresence.ts` and `Execution.ts` are PascalCase. Module barrel files always use lowercase (`index.ts`, `claude.ts`, `sse.ts`).

**Impact** — No clear rule means contributors pick arbitrarily, making the inconsistency grow over time.

**Fix** — Enforce the convention with an ESLint rule (e.g. `unicorn/filename-case` or `check-file/filename-naming-convention`) configured to allow `camelCase` and `PascalCase`, with the implicit rule "PascalCase when the file's primary export is a class, camelCase otherwise". The rule catches future drift on PR without relying on contributors remembering it. As a one-time cleanup, audit each camelCase file in the observation above and rename the class-primary ones (e.g., `simpleAdapter.ts` → `SimpleAdapter.ts`; check `appServerClient.ts`, `pushHandler.ts`, etc. case by case). Document the convention in CLAUDE.md as well, so contributors hit it before the linter does.

#### Adapter internal layouts diverge — no consistent shape
*Minor · Effort: M · multiple adapter folders (see Locations below)*

**Observation** — Each vendor adapter folder reinvents its own internal layout. New contributors must learn each one.

**Impact** — Onboarding friction — there is no canonical template to follow when adding a new adapter.

**Fix** — Document a canonical adapter folder shape (e.g., `{Vendor}Adapter.ts`, `types.ts`, `model.ts` if it has a `ToolCallingModel`, `index.ts`) and refactor the divergent ones toward it. Not all adapters need every file.

**Locations:**
- `packages/sdk/src/adapters/{anthropic,gemini,openai,vercel-ai-sdk}` each have `index.ts` + `{Vendor}Adapter.ts` + `model.ts`
- `packages/sdk/src/adapters/{letta,a2a,a2a-gateway,parlant}` have `types.ts` instead
- `packages/sdk/src/adapters/{google-adk,langgraph,claude-sdk}` have neither (everything in `*Adapter.ts`)
- `packages/sdk/src/adapters/acp` has 11 files

#### `linear/index.ts` and `rest/index.ts` list exports instead of `export *`
*Minor · Effort: S · 2 barrel files (see Locations below)*

**Observation** — Each name added to `integrations/linear/index.ts` must also be added to `linear/index.ts`, which is busywork that already missed `getAgentSessionEventKey` (exported from `integrations/linear/bridge/index.ts` but not re-exported by the public `linear` entrypoint).

**Impact** — Manual re-export lists fall out of sync; a missing export silently breaks consumers of the public entrypoint.

**Fix** — Replace both with `export * from "../integrations/linear"` (resp. `../client/rest/*` files).

**Locations:**
- `packages/sdk/src/linear/index.ts` (58 lines, 30+ names)
- `packages/sdk/src/rest/index.ts` (13 lines but enumerated)

#### `MessageHandler` and `messageHandler`-style types are exported but unused
*Minor · Effort: S · `packages/sdk/src/runtime/types.ts:44`*

**Observation** — `export type MessageHandler` is searched repo-wide; only `runtime/index.ts` and `index.ts` re-export it; no implementation uses it. Exposes API surface that the SDK itself never depends on.

**Impact** — Dead exports inflate the public API surface, creating maintenance obligations and confusing consumers.

**Fix** — Remove `MessageHandler` (and audit similar exports — e.g. `HUB_ROOM_SYSTEM_PROMPT` is consumed by tests so the original `export const` is justified, but its re-export from `runtime/index.ts:19` is unused and can be dropped).

#### `normalizeHandle` reimplemented 3+ times with subtly different semantics
*Minor · Effort: S · 4 source files (see Locations below)*

**Observation** — Three functions named `normalizeHandle`/`ensureHandlePrefix` doing closely related but not-identical work. The "@unknown" fallback in one of them is an implicit semantic that callers won't notice.

**Impact** — Subtle behavioral differences between copies are easy to miss; a bug fixed in one copy will not be fixed in the others.

**Fix** — Consolidate into a single `utils/handles.ts` exporting `ensureHandlePrefix(value): string | null` and `stripHandlePrefix(value): string`. Delete the per-file copies.

**Locations:**
- `packages/sdk/src/runtime/ContactEventHandler.ts:458` (returns `"@unknown"` when missing, prepends `@`)
- `packages/sdk/src/mcp/sdk.ts:344` (returns null when blank, no `@` prefix)
- `packages/sdk/src/runtime/types.ts:74` (`ensureHandlePrefix` — prepends `@`, returns null when missing)
- `packages/sdk/src/integrations/linear/handles.ts:1` (`stripHandlePrefix` — opposite direction)

#### `mcp/registrations.ts` redefines local `asNonEmptyString` and `serializeValue`
*Minor · Effort: S · `packages/sdk/src/mcp/registrations.ts:160`*

**Observation** — Identical to `adapters/shared/coercion.ts` `asNonEmptyString` and `toWireString` (see also `:184` for `serializeValue`).

**Impact** — Two additional copies of coercion logic that diverge silently over time.

**Fix** — Import from the consolidated `utils/` module (see Major #1).

#### `integrations/linear/bridge/index.ts` re-exports across the bridge boundary
*Minor · Effort: S · `packages/sdk/src/integrations/linear/bridge/index.ts:8-13`*

**Observation** — `integrations/linear/bridge/index.ts:8-13` re-exports `StaleSessionGuard`, `isSessionStale`, `sendRecoveryActivityIfStale`, `type StaleSessionGuardOptions` from `../stale-session-guard` (one level up). The "bridge" subfolder should own bridge concerns; `stale-session-guard.ts` lives at the linear-integration root. Re-exporting from a child barrel back through the parent's neighbor file is structurally confusing.

**Impact** — The bridge barrel becomes a misleading source of truth for symbols that live outside it, making it hard to understand the module boundary.

**Fix** — Either move `stale-session-guard.ts` inside `bridge/`, or have `integrations/linear/index.ts` (the only consumer) import directly from `./stale-session-guard` and drop the indirection in `bridge/index.ts`.

#### Mixed inline `Promise<void> | void` callbacks vs `async` callbacks
*Minor · Effort: S · 4 runtime files (see Locations below)*

**Observation** — Some callbacks tolerate sync handlers (`Promise<void> | void`) and others require `Promise<void>`. The inconsistency is not driven by anything visible in the call sites — all are `await`ed regardless.

**Impact** — Callers supplying a sync callback to a `Promise<void>`-only field get a silent type error; the inconsistency invites mistakes.

**Fix** — Standardize on `Promise<void> | void` for all option-level user-supplied callbacks (it's the more permissive surface) and document why in a `runtime/callbacks.ts`.

**Locations:**
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:17-22` (mix of `Promise<void>` and `Promise<void> | void`)
- `packages/sdk/src/runtime/rooms/subscriptions.ts:30` (`onError?: Promise<void> | void`)
- `packages/sdk/src/runtime/PlatformRuntime.ts:28-29` (`Promise<void> | void`)
- `packages/sdk/src/integrations/linear/webhook.ts:35` (`Promise<void> | void`)

#### `executeToolCall` switch in `ContactCallbackTools` mirrors `AgentTools.toolHandlers` map by hand
*Minor · Effort: M · `packages/sdk/src/runtime/tools/ContactCallbackTools.ts:268-336`*

**Observation** — `AgentTools` already exposes a `toolHandlers` map keyed by tool name. `ContactCallbackTools.executeToolCall` reproduces the same dispatch logic with a 16-arm switch and inline arg coercion.

**Impact** — A new tool added to `AgentTools` must also be added to the switch in `ContactCallbackTools`, doubling the maintenance cost.

**Fix** — Extract a shared `buildToolHandlerDispatch(tools: AdapterToolsProtocol): Record<string, ToolHandler>` helper in `runtime/tools/` so both classes share the switch.

#### `runtime/tools/customTools.ts` defines exported helpers that look like they belong in a utility module
*Minor · Effort: S · `packages/sdk/src/runtime/tools/customTools.ts`*

**Observation** — `customToolToOpenAISchema`, `customToolToAnthropicSchema`, `customToolsToSchemas`, `findCustomTool`, `findCustomToolInIndex`, `buildCustomToolIndex`, `executeCustomTool`, `getCustomToolName` — all eight are stateless helpers operating on `CustomToolDef`. They live in the same file as the public interface and the three error classes. The mix makes the file hard to scan.

**Impact** — The file blends type definitions, error classes, and utility functions, making it hard to navigate and test the helpers in isolation.

**Fix** — Split into `customTools.types.ts` (interface + error classes) and `customTools.ts` (helpers) — or keep one file but reorganize per "File Structure" "imports → constants → utilities → public API".

### Nits

#### `assertNever` in `PlatformRuntime.ts` is unreachable
*Nit · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:335`*

**Observation** — `PlatformRuntime` has no exhaustive switch; the function is never called.

**Impact** — Dead code adds noise and may confuse readers into thinking an exhaustive switch exists somewhere in the file.

**Fix** — Remove.

#### `interface PaginationMetadata extends PaginationMetadataLike {}` and `interface PaginatedResponse<T> extends PaginatedList<T> {}` add no value
*Nit · Effort: S · `packages/sdk/src/client/rest/types.ts:44-46`*

**Observation** — Empty interfaces extending other interfaces are just aliases that survive structural compatibility but hurt navigability.

**Impact** — Consumers and tooling show two names for the same type; navigating to definition takes one extra hop.

**Fix** — Replace with `export type PaginationMetadata = PaginationMetadataLike; export type PaginatedResponse<T = MetadataMap> = PaginatedList<T>;` or drop entirely and import the base names.

#### `interface RestApi extends ThenvoiLinkRestApi {}` is an empty alias
*Nit · Effort: S · `packages/sdk/src/client/rest/types.ts:220`*

**Observation** — Same anti-pattern as above.

**Impact** — Unnecessary indirection with no added value.

**Fix** — `export type RestApi = ThenvoiLinkRestApi;` or just standardize on one name.

#### `forEach` over `for...of` in `OpencodeAdapter`
*Nit · Effort: S · `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:1062`*

**Observation** — `questions.forEach((question, index) => …)` — the rest of the SDK uses `for...of` consistently; one outlier.

**Impact** — Minor inconsistency; makes the file slightly harder to scan for someone familiar with the SDK's conventions.

**Fix** — Convert to `for (const [index, question] of questions.entries())`.

#### `LinearSessionStatus = SessionStatus` is a re-aliased type that adds nothing
*Nit · Effort: S · `packages/sdk/src/integrations/linear/types.ts:87-88`*

**Observation** — `LinearSessionStatus` is a direct alias for `SessionStatus` with no transformation.

**Impact** — Two names for the same type pollute the public API surface.

**Fix** — Drop the alias, export `SessionStatus` under both names if required for backward compat, or just keep one name.

#### `WireXxx` + `export type XxxRecord = WireXxxRecord` pairs duplicate type names
*Nit · Effort: S · `packages/sdk/src/contracts/dtos.ts:50-86,128-167`*

**Observation** — Every wire DTO is declared twice: an interface and a type alias with no transformation between them. The alias adds no value.

**Impact** — Double the type names to keep in sync; contributors adding a new DTO must remember to add both forms.

**Fix** — Pick one name (drop the `Wire` prefix when there's no domain version), or actually layer a transform so the public name and the wire name diverge.

## Strengths worth keeping

- `contracts/protocols.ts` is the canonical place for the SDK's abstract protocols (`FrameworkAdapter`, `MessagingTools`, `AdapterToolsProtocol`, …) — no other module redefines these.
- `core/errors.ts` is a tight, focused error hierarchy used consistently across the tree.
- `core/logger.ts` is dependency-injected everywhere (no global logger); `NoopLogger` default removes the "is this safe" anxiety.
- `runtime/rooms/subscriptions.ts` is an exemplary pure-utility module: dependency-injected `link`, `trackedRooms`, callbacks; no state of its own.
- `mcp/backends.ts` is a clean factory that hides four MCP server implementations behind one interface.
- `runtime/tools/AgentTools.ts` already uses a `toolHandlers` handler map for tool dispatch (the convention exists — it just needs to be propagated to `ContactCallbackTools`).
- The `package.json` `exports` field is granular and matches the directory structure — consumers can import `@thenvoi/sdk/linear` without pulling the whole SDK graph.
- Tests directory (`packages/sdk/tests/`) is rich (40+ files), giving real coverage to refactor against — including a `parity-contract.test.ts` that pins the public surface.
- Module dependency direction is acyclic: verticals (`adapters/`, `converters/`, `integrations/linear/`, `mcp/`) all depend on `runtime`/`platform`/`contracts`/`core`, never the other way around.

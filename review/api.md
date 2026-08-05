[← Back to top-level review](../review.md)

# Public API and Exports Review

## Summary

The SDK's exports map is internally consistent (11 entries in both `tsup.config.ts` and `package.json`, types/import/require triples in correct order), every entry source file exists, and named exports are used throughout — no default exports anywhere. The big problems are a runtime class exported as a type from the root entry, and a fan-out of public-facing protocol/DTO types that are not actually exported from any sub-entry.

**What's good:**

- No default exports anywhere in `src/` — fully tree-shake-friendly named exports.
- `package.json` `exports` map matches `tsup.config.ts` `entry` keys exactly (11 each); `types`/`import`/`require` triples are in the correct order.
- `peerDependenciesMeta` correctly marks every framework SDK as optional, so installs stay lean.
- The `mcp-claude` build target name (`./dist/mcp-claude.*`) and the public path (`./mcp/claude`) are correctly bridged in `package.json:70-74`.
- Consistent use of `export type` for type-only re-exports throughout (except the `HistoryProvider` blocker).
- Adapter sub-entry (`./adapters/index.ts`) is well-organized.
- `tsconfig.json` enables `verbatimModuleSyntax`, `strict`, `forceConsistentCasingInFileNames`, and `declarationMap`.
- The `files` array (`["dist", "README.md"]`) correctly excludes `examples/` and `tests/` from the published package.

**What's not** (each linked to its full finding):

- A runtime class is exported as a type from root, so `new HistoryProvider(...)` crashes at runtime — [`HistoryProvider` class exported as type from root entry](#historyprovider-class-exported-as-type-from-root-entry).
- Core protocol/DTO types referenced by exported public types are themselves not exported — [Core DTO types are referenced by public protocols but not exported anywhere](#core-dto-types-are-referenced-by-public-protocols-but-not-exported-anywhere), [`AgentToolsCapabilities` not exported](#agenttoolscapabilities-not-exported-despite-being-on-the-public-protocol), [Protocol-internal types referenced by exported types are themselves not exported](#protocol-internal-types-referenced-by-exported-types-are-themselves-not-exported).
- `src/mcp/claude.ts` is stale duplicate code — [`src/mcp/claude.ts` is dead code](#srcmcpclaudets-is-dead-code).
- Callback type naming convention is not followed — [`ContactEventCallback` violates callback naming convention](#contacteventcallback-violates-callback-naming-convention).
- tsup `external` list misses optional peers — [Optional peer dependencies not all externalized in tsup config](#optional-peer-dependencies-not-all-externalized-in-tsup-config).
- `Logger`, error classes, `ThenvoiLinkOptions`, and `Captured*` shapes are referenced by public surface but not exported from root or relevant sub-entries — [`Logger` type not exported from root](#logger-type-not-exported-from-root-despite-being-on-platformruntimeoptions), [Error classes only available from `./core`](#error-classes-only-available-from-core), [`ThenvoiLinkOptions` not exported](#thenvoilinkoptions-not-exported), [`./mcp` entry does not re-export `ThenvoiSdkMcpServer`](#mcp-entry-does-not-re-export-thenvoisdkmcpserver), [`FakeAgentTools` exposes `Captured*` shapes](#fakeagenttools-exposes-captured-shapes-on-public-fields-without-exporting-the-types), [Root `index.ts` does not surface several types relevant to extension authors](#root-indexts-does-not-surface-several-types-relevant-to-extension-authors).

## Findings

### Blockers

#### `HistoryProvider` class exported as type from root entry
*Blocker · Effort: S · `packages/sdk/src/index.ts:12-23`*

**Observation** — `HistoryProvider` is a class declared with `export class HistoryProvider` (`packages/sdk/src/runtime/types.ts:49`). In the root `index.ts` it appears inside `export type { AgentConfig, AgentInput, ContactEventConfig, ContactEventStrategy, ContactEventCallback, ConversationContext, HistoryProvider, MessageHandler, PlatformMessage, SessionConfig } from "./runtime/types";`. With `verbatimModuleSyntax` (`packages/sdk/tsconfig.json:14`), that block produces only `.d.ts` re-exports — there is no runtime binding. Users who do `import { HistoryProvider } from "@thenvoi/sdk"` and call `new HistoryProvider([])` will get a runtime `HistoryProvider is not a constructor` (or `undefined`) error. The `./runtime` sub-entry's `index.ts:11-17` exports it correctly as a value, so the bug is isolated to the root entry but still affects every user reading the root `index.ts` as the canonical API.

**Impact** — Any consumer importing `HistoryProvider` from the root entry will receive a runtime crash (`HistoryProvider is not a constructor`) despite the type declarations appearing correct.

**Fix** — Move `HistoryProvider` out of the `export type {}` block into the value re-export block (alongside the other value-only re-exports). For example, add `export { HistoryProvider } from "./runtime/types";` and keep only the actual types in the `export type {}` block.

[↑ Summary in review.md B1](../review.md#b1-root-indexts-exports-the-historyprovider-class-inside-an-export-type-block)

### Major

#### Core DTO types are referenced by public protocols but not exported anywhere
*Major · Effort: S · `packages/sdk/src/contracts/dtos.ts`*

**Observation** — `AdapterToolsProtocol` is the central type users see when implementing a `FrameworkAdapter`. Its method signatures expose `MentionInput`, `MetadataMap`, `ToolOperationResult`, `ParticipantRecord`, `PaginatedList<PeerRecord>`, `ContactRecord`, `MemoryRecord`, `ToolSchemaRecord`, plus the contact/memory arg types (`AddContactArgs`, `StoreMemoryArgs`, etc.). None of these are re-exported from `./`, `./core`, `./runtime`, `./rest`, or `./testing`. Users writing a custom adapter or implementing `FrameworkAdapter.onEvent({ tools })` cannot name the type of a `tools.sendMessage(...)` argument, the awaited result, or `tools.getParticipants()` return values without reaching into `src/contracts/dtos` (a non-public path).

**Impact** — Consumers implementing a custom adapter cannot reference DTO types by name without importing from an internal non-public path, which breaks when paths change.

**Fix** — Either add a dedicated `contracts` or `dtos` sub-entry exporting the shared types, or surface them from `./core` (which is the natural home — it already exports the protocol types that depend on them). At minimum: `MetadataMap`, `MentionInput`, `MentionReference`, `ToolOperationResult`, `PaginatedList`, `PaginationMetadataLike`, `ParticipantRecord`, `PeerRecord`, `ContactRecord`, `MemoryRecord`, `ToolSchemaRecord`, `ListContactsArgs`, `AddContactArgs`, `RemoveContactArgs`, `ListContactRequestsArgs`, `RespondContactRequestArgs`, `ContactRequestsResult`, `ListMemoriesArgs`, `StoreMemoryArgs`.

[↑ Summary in review.md M4](../review.md#m4-public-api-dtoprotocol-types-not-re-exported-from-sub-entries)

#### `AgentToolsCapabilities` not exported despite being on the public protocol
*Major · Effort: S · `packages/sdk/src/contracts/protocols.ts:181-191`*

**Observation** — `AdapterToolsProtocol.capabilities: Readonly<AgentToolsCapabilities>` (line 176). `AgentToolsCapabilities` (line 181) and `DEFAULT_AGENT_TOOLS_CAPABILITIES` (line 187) are defined but never re-exported by any sub-entry. Users who want to read or test capability flags can't reference the type. The internal `FakeAgentTools` itself (`packages/sdk/src/testing/FakeAgentTools.ts:8`) imports `DEFAULT_AGENT_TOOLS_CAPABILITIES` from the internal path — there is no public way to do the same.

**Impact** — Users cannot reference `AgentToolsCapabilities` by name or use `DEFAULT_AGENT_TOOLS_CAPABILITIES` without importing from internal paths.

**Fix** — Add `AgentToolsCapabilities` (type) and `DEFAULT_AGENT_TOOLS_CAPABILITIES` (value) to `./core` exports, and reconsider whether they should also be re-exported from root.

[↑ Summary in review.md M4](../review.md#m4-public-api-dtoprotocol-types-not-re-exported-from-sub-entries)

#### Protocol-internal types referenced by exported types are themselves not exported
*Major · Effort: S · `packages/sdk/src/contracts/protocols.ts:25-41`, `:193-216`, `:226-239`*

**Observation** — The following types are referenced by exported public types but never re-exported:

- **`PlatformMessageLike`** (line 25) — referenced by `FrameworkAdapterInput.message`; root index uses `PlatformMessage` as an alias (`type PlatformMessage = PlatformMessageLike` in `runtime/types.ts:35`), so functionally OK, but the alias is one-way: code working at the contract level still sees `PlatformMessageLike`.
- **`HistoryLike`** (line 37) — referenced by `FrameworkAdapterInput.history`; users implementing `FrameworkAdapter.onEvent` cannot name the type.
- **`PreprocessorContext`** (line 203) — `Preprocessor` is exported, but its `process(context: PreprocessorContext, ...)` parameter type cannot be referenced by name.
- **`EventEnvelope`** (line 226) — generic parameter of `Preprocessor<TEvent extends EventEnvelope>`; users writing a custom preprocessor cannot reference the constraint.
- **Tool executor helpers** — `ToolExecutorError`, `createToolExecutorError`, `isToolExecutorError`, `toLegacyToolExecutorErrorMessage`, and `TOOL_EXECUTOR_ERROR_TYPES` (`protocols.ts:97-161`) are public-looking helpers but not re-exported from `./core`.

`FrameworkAdapterInput` is exported but exposes these non-exported supporting types in its members.

**Impact** — Users cannot reference supporting contract types by name, causing friction when implementing custom adapters or preprocessors and forcing use of internal import paths.

**Fix** — Add the missing types/functions to `./core/index.ts`. At minimum: `PlatformMessageLike`, `HistoryLike`, `PreprocessorContext`, `EventEnvelope`, `ToolExecutorError`, `ToolExecutorErrorType`, and the three helper functions.

[↑ Summary in review.md M4](../review.md#m4-public-api-dtoprotocol-types-not-re-exported-from-sub-entries)

#### `src/mcp/claude.ts` is dead code
*Major · Effort: S · `packages/sdk/src/mcp/claude.ts`*

**Observation** — `tsup.config.ts:41` builds the `mcp-claude` entry directly from `src/mcp/sdk.ts`. The file `src/mcp/claude.ts` re-exports a subset of `sdk.ts` (`createThenvoiSdkMcpServer`, `ThenvoiSdkMcpServer`, `CreateThenvoiSdkMcpServerOptions`, `GetSystemPromptContextResult`) but is never referenced by tsup or by any internal import (verified via `grep -rn "\"./claude\""`). The dead file is also incomplete: it omits `GetSystemPromptContextOptions` which is part of the public `ThenvoiSdkMcpServer` API and is built into the actual `./mcp/claude` entry.

**Impact** — The stale file misleads contributors into thinking it is the MCP Claude entry point, and its incomplete surface could cause confusion about the actual public API.

**Fix** — Two options. (a) Point the `tsup` `mcp-claude` entry at `src/mcp/claude.ts`, make `claude.ts` the authoritative re-export and complete its surface (add `GetSystemPromptContextOptions`), keep `sdk.ts` as the implementation. (b) Delete `src/mcp/claude.ts` entirely — `sdk.ts` is already what tsup builds, so removing the stale duplicate is the simpler fix.

[↑ Summary in review.md M16](../review.md#m16-dead-code-in-srcmcpclaudets)

#### `ContactEventCallback` violates callback naming convention
*Major · Effort: S · `packages/sdk/src/runtime/types.ts:23`*

**Observation** — `export type ContactEventCallback = (event, tools) => Promise<void>` is the only callback type on the public API and does not use the `On{Action}Callback` pattern. Renaming after release is a breaking change, so the longer this lives the more painful it gets. The handler types inside `RoomPresence.ts` (`RoomPresenceJoinHandler`, `RoomPresenceLeaveHandler`, etc.) follow `*Handler` instead but are internal/non-exported.

**Impact** — The name deviation from the code-style preferences guide's callback naming convention grows increasingly costly to fix the longer it remains in a released public API.

**Fix** — Rename to `OnContactEventCallback` and update the `ContactEventConfig.onEvent?: OnContactEventCallback` field and all internal usages. Re-export under both names temporarily if backward compatibility is desired, with a deprecation comment on the old name.

[↑ Summary in review.md M12](../review.md#m12-callback-type-naming-convention-not-followed)

#### Optional peer dependencies not all externalized in tsup config
*Major · Effort: S · `packages/sdk/tsup.config.ts:3-26`*

**Observation** — The `EXTERNAL` array is missing:

- **`@google/adk`** — used dynamically at `src/adapters/google-adk/GoogleADKAdapter.ts:128`.
- **`@letta-ai/letta-client`** — used at `src/adapters/letta/LettaAdapter.ts:1082`.
- **`@langchain/core`** — only the `/prebuilt` and `/tools` sub-paths are listed; the bare root is missing.
- **`@langchain/langgraph`** — same issue as `@langchain/core`: only sub-paths are listed.

All four are declared optional peer deps in `package.json:99-116`. Dynamic `await import()` happens to avoid bundling at runtime, but listing them explicitly is the documented contract and prevents future static imports from silently breaking. Note also `@modelcontextprotocol/sdk` subpaths used elsewhere are not enumerated.

**Impact** — If a future static import of any missing peer is introduced, it will be silently bundled rather than treated as external, causing unexpected bundle bloat or runtime errors.

**Fix** — Add the missing entries to `EXTERNAL`: `@google/adk`, `@letta-ai/letta-client`, `@langchain/core`, `@langchain/langgraph`. Consider switching to a regex (``new RegExp(`^(${peerNames.join('|')})($|/)`)``) sourced from `package.json` `peerDependencies` to keep the two lists in sync automatically.

[↑ Summary in review.md M18](../review.md#m18-tsupconfigts-external-misses-4-peer-deps)

### Minor

#### `Logger` type not exported from root despite being on `PlatformRuntimeOptions`
*Minor · Effort: S · `packages/sdk/src/index.ts`*

**Observation** — `PlatformRuntimeOptions` is exported from root (`src/index.ts:7`) and has `logger?: Logger`. The `Logger` interface and `ConsoleLogger`/`NoopLogger` classes are only exported from `./core`. A user importing only from root cannot type a custom logger they pass to `PlatformRuntime`/`Agent.create`.

**Impact** — Users importing only from root cannot type a custom logger without adding a second sub-path import.

**Fix** — Re-export `Logger` (type), `ConsoleLogger`, and `NoopLogger` from root.

#### Error classes only available from `./core`
*Minor · Effort: S · `packages/sdk/src/core/errors.ts`, `packages/sdk/src/index.ts`*

**Observation** — `ThenvoiSdkError`, `UnsupportedFeatureError`, `ValidationError`, `TransportError`, `RuntimeStateError` are exported from `./core` but not from root. `loadAgentConfig`/`loadAgentConfigFromEnv` throw `ValidationError`; users of root who want a typed catch must add a second sub-path import.

**Impact** — Users catching typed errors from root-exported functions must add a separate `./core` sub-path import just to reference the error class.

**Fix** — Re-export the error classes (or at least `ThenvoiSdkError` + `ValidationError`) from root.

#### `ThenvoiLinkOptions` not exported
*Minor · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:25`, `packages/sdk/src/index.ts:4`*

**Observation** — Root exports the `ThenvoiLink` class and `deriveDefaultRestUrl` helper but not `ThenvoiLinkOptions`. The constructor signature `new ThenvoiLink(options: ThenvoiLinkOptions)` is the main entrypoint to the class. Users instantiating it directly cannot name the options shape.

**Impact** — Users cannot type the options object for `ThenvoiLink` construction without reaching into an internal path.

**Fix** — Add `export type { ThenvoiLinkOptions } from "./platform/ThenvoiLink";` to root.

#### `./mcp` entry does not re-export `ThenvoiSdkMcpServer`
*Minor · Effort: S · `packages/sdk/src/mcp/index.ts`*

**Observation** — `./mcp` exports `getThenvoiSdkMcpServerConfig(backend)` whose return type is `ThenvoiSdkMcpServer["serverConfig"]` (`packages/sdk/src/mcp/backends.ts:129`). The `ThenvoiSdkMcpServer` interface (the source of the indexed access) is defined in `src/mcp/sdk.ts:56` but not re-exported from `./mcp` — a user importing `./mcp` who wants to type the returned config has to also reach into `./mcp/claude`.

**Impact** — Users of `./mcp` who need to type the return value of `getThenvoiSdkMcpServerConfig` must also import from `./mcp/claude`, which is an undocumented coupling.

**Fix** — Re-export `type ThenvoiSdkMcpServer` (and arguably `GetSystemPromptContextResult`, `GetSystemPromptContextOptions`, `CreateThenvoiSdkMcpServerOptions`) from `./mcp` for type-completeness, OR document clearly that `./mcp/claude` is the canonical SDK-MCP types entry.

#### `FakeAgentTools` exposes `Captured*` shapes on public fields without exporting the types
*Minor · Effort: S · `packages/sdk/src/testing/FakeAgentTools.ts:29-48`, `:66-70`*

**Observation** — `messagesSent`, `eventsSent`, `participantsAdded`, `toolCalls` are public fields with element types `CapturedMessage`, `CapturedEvent`, `CapturedParticipant`, `CapturedToolCall` — all declared as private (file-local) `interface`s. Test code reads `fake.messagesSent[0].content` fine via inference, but anyone who wants `const captured: CapturedMessage = fake.messagesSent[0]` or to write helper functions returning these shapes must redeclare them.

**Impact** — Consumers writing typed helpers over `FakeAgentTools` must redeclare the captured-item shapes, risking drift from the actual implementation.

**Fix** — `export interface CapturedMessage` (etc.) and re-export them from `./testing/index.ts`.

#### Root `index.ts` does not surface several types relevant to extension authors
*Minor · Effort: M · `packages/sdk/src/index.ts`*

**Observation** — Authors writing a custom adapter from root will quickly need types that live only in `./core` (`Logger`, error classes), `./runtime` (`Execution`, `ExecutionContext`, `ContactEventHandler`, the synthetic-sender constants `SYNTHETIC_CONTACT_EVENTS_SENDER_ID`, etc.), or `./rest` (`AgentIdentity`, `RestApi`, `ChatParticipant`, `PlatformChatMessage`). The root surface is therefore not self-sufficient for the most common extension scenarios — fragmenting the DX described as the headline in `AGENTS.md` "Multi-framework support".

**Impact** — The root entry is not self-sufficient for the most common extension scenarios, forcing consumers to discover and import from multiple sub-paths.

**Fix** — Decide whether root should be a *complete* surface or a *minimal* surface. If complete, fold the cross-cutting essentials (`Logger`, errors, `RestApi`/`AgentIdentity` types, capability constants) into the root re-exports. If intentionally minimal, document the rule in `AGENTS.md` and add JSDoc pointers from root to the sub-entries.

### Nits

#### `linear` sub-entry uses named-list re-exports instead of `export *`
*Nit · Effort: S · `packages/sdk/src/linear/index.ts`*

**Observation** — `src/linear/index.ts` re-exports a very long flat list from a single underlying barrel (`../integrations/linear`). The same shape would be expressible as `export * from "../integrations/linear";` (plus a small `export type *` follow-up if needed under `verbatimModuleSyntax`). The risk of accidental leakage from `integrations/linear/index.ts` is low because that barrel already curates its public surface.

**Impact** — Maintenance burden — any new export added to `integrations/linear` must be manually mirrored in `src/linear/index.ts`.

**Fix** — Either reduce `src/linear/index.ts` to a single `export * from "../integrations/linear";` (with `export type * from "../integrations/linear";` if `verbatimModuleSyntax` requires it), or accept the verbose form as deliberate. The same simplification applies less cleanly to `./rest` (it merges two underlying files) and `./converters` (multiple files, intentional curation).

#### Adapters cross-import `../../mcp/*` — slight coupling between sub-entries
*Nit · Effort: M · `packages/sdk/src/adapters/claude-sdk/ClaudeSDKAdapter.ts:15-16`, `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:17-19`, `packages/sdk/src/adapters/acp/ACPClientAdapter.ts:19-21`*

**Observation** — Three adapters (`ClaudeSDKAdapter`, `OpencodeAdapter`, `ACPClientAdapter`) cross-import from `../../mcp/`, collectively pulling in five modules: `registrations`, `server`, `sse`, `backends`, `zod`. Because tsup emits one bundle per entry and does not share chunks, the `adapters` build duplicates the `mcp` code that's already in the standalone `mcp` build. Functionally fine, but it inflates `dist/adapters.js`. No public API leak — none of these internal imports surface from `./adapters` — but it foreshadows future tree-shaking pain.

**Impact** — The `adapters` bundle duplicates MCP code, inflating bundle size and creating a latent maintenance risk if the two copies diverge.

**Fix** — Consider whether the MCP glue used by these adapters should be lifted to a shared `core`-level utility, or accept the duplication. (Possibly out of scope for this review.)

## Strengths worth keeping
- No default exports anywhere in `src/` — fully tree-shake-friendly named exports per "Module and Import Patterns".
- `package.json` `exports` map matches `tsup.config.ts` `entry` keys exactly (11 each). The `types`/`import`/`require` triples are in the correct order.
- `peerDependenciesMeta` correctly marks every framework SDK as optional, so installs stay lean.
- The `mcp-claude` build target name (`./dist/mcp-claude.*`) and the public path (`./mcp/claude`) are correctly bridged in `package.json:70-74` — a common footgun avoided.
- Consistent use of `export type` for type-only re-exports throughout (except the `HistoryProvider` blocker).
- Adapter sub-entry (`./adapters/index.ts`) is well-organized: each adapter group includes its class, model, options type, factory, and history converter together.
- `AGENTS.md` clearly documents each sub-path's intended contents and the optional-peer-dep model — discoverable.
- `tsconfig.json` enables `verbatimModuleSyntax`, `strict`, `forceConsistentCasingInFileNames`, and `declarationMap` — strong type-safety baseline.
- The `files` array (`["dist", "README.md"]`) correctly excludes `examples/` and `tests/` from the published package.
- `testing` sub-entry surface is small and focused (just `FakeAgentTools` + `StubRestApi`) — appropriate scope for a user-facing test helper.

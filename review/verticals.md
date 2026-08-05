[← Back to top-level review](../review.md)

# Verticals Review: MCP and Linear

## Summary

The Linear vertical is well isolated and MCP exposes a clean dispatch interface, but both verticals show the same pattern: a structurally sound public surface around duplicated or leaky internals.

**What's good:**

- Linear vertical is properly isolated — `core/`, `runtime/`, `agent/`, `contracts/` have zero Linear imports.
- `src/linear/index.ts` is a pure re-export barrel from `src/integrations/linear/`.
- No type duplication against `@linear/sdk` — types like `AgentSessionEventWebhookPayload` are consumed directly.
- `js-yaml` is loaded with `JSON_SCHEMA`, which is safe from `!!js/function` RCE.
- `UNSAFE_KEYS` filter in `loader.ts` prevents prototype pollution via `__proto__` / `constructor` / `prototype`.
- No Linear secrets are logged; `webhook.ts` validates the signature before reading the body.
- `mcp/backends.ts` is a clean dispatch with a small, consistent public surface.

**What's not** (each linked to its full finding):

- One generic adapter reads Linear-specific metadata — [CodexAdapter reads `linear_*` keys](#codexadapter-reads-linear-specific-metadata-keys).
- An arbitrary sub-entry whose file name doesn't match its content — [`mcp/claude` 7-line redirect](#mcpclaude-sub-entry-is-an-arbitrary-7-line-redirect).
- `registerTools()` reimplemented across 4 MCP backends — [3 near-identical, 1 analogous](#registertools-reimplemented-across-4-mcp-backends-3-near-identical-1-analogous).
- A 363-line `sdk.ts` mixes MCP plumbing with an unrelated system-prompt-context feature — [`sdk.ts` two responsibilities](#sdkts-mixes-mcp-plumbing-and-a-200-line-system-prompt-context-feature).
- Example config drift — [`agent_config.yaml.example` missing `letta_agent`](#agent_configyamlexample-is-out-of-sync-with-example-usage).
- Library code uses `console.warn` instead of the injected logger — [`console.warn` in library code](#consolewarn-used-in-library-code-instead-of-injected-logger).

## Findings

### Blockers

_None._ No Linear secrets are logged, the yaml loader is RCE-safe under `JSON_SCHEMA`, the example imports compile against the current `src/linear/` exports, and Linear types are not duplicated against `@linear/sdk`.

### Major

#### CodexAdapter reads Linear-specific metadata keys
*Major · Effort: M · `packages/sdk/src/adapters/codex/CodexAdapter.ts:189-191`, `:220`*

**Observation** — `CodexAdapter.onMessage` directly reads `message.metadata?.linear_session_id`, `message.metadata?.linear_issue_id`, and uses `message.metadata?.linear_reset_room_session !== true` to decide whether to reuse the Codex thread. This is a vertical-specific identifier leaking into a generic framework adapter. If any other vertical needs the same "reset thread" signal it has to pick the Linear key, and Linear can no longer be torn out cleanly. The Linear bridge sets these metadata values in `bridge/handler.ts` (`linear_reset_room_session`, `linear_session_id`, `linear_issue_id`).

**Impact** — Any vertical that needs the same "reset thread" signal must reuse the Linear metadata keys, and removing Linear from the project requires patching a generic adapter. This is a leaf-to-core inversion that increases coupling.

**Fix** — Either (a) generalize to a neutral metadata key the bridge writes (`bridge_session_id`, `reset_adapter_thread`), with Linear emitting the neutral key, or (b) move the "should I reset the thread?" decision into a shared helper that any bridge can call without the adapter touching foreign keys. The `metadataSessionId`/`metadataIssueId` debug fields can simply read whichever metadata is present.

[↑ Summary in review.md M7](../review.md#m7-vertical-leak-codexadapter-reads-linear-metadata-directly)

#### `mcp/claude` sub-entry is an arbitrary 7-line redirect
*Major · Effort: S · `packages/sdk/src/mcp/claude.ts:1-7`, `packages/sdk/package.json:70-74`*

**Observation** — `mcp/claude.ts` re-exports exactly `createThenvoiSdkMcpServer`, `ThenvoiSdkMcpServer`, `CreateThenvoiSdkMcpServerOptions`, and `GetSystemPromptContextResult` — every one of which is already exported by `mcp/index.ts` transitively via `sdk.ts`. The file name "claude" does not match the content (no Claude-specific code beyond an `@anthropic-ai/claude-agent-sdk` import in `sdk.ts`), and the actual class is named `ThenvoiSdkMcpServer`, not `ThenvoiClaudeMcpServer`. The package.json `./mcp/claude` export points consumers at a name that implies Claude-specificity, but they receive the same SDK server they could import from `./mcp`.

**Impact** — Consumers importing from `./mcp/claude` receive no additional symbols and may be confused by the naming mismatch; the sub-entry adds maintenance surface for no benefit.

**Fix** — Either (a) delete `mcp/claude.ts` and the `./mcp/claude` package.json export, since `./mcp` already exposes the same symbols, or (b) rename `sdk.ts` to `claude.ts` so the file name matches the entry name and the Claude Agent SDK dependency is explicit.

[↑ Summary in review.md M16](../review.md#m16-dead-code-in-srcmcpclaudets)

#### `registerTools()` reimplemented across 4 MCP backends (3 near-identical, 1 analogous)
*Major · Effort: M · 4 MCP backend files (see Locations below)*

**Observation** — `server.ts`, `sse.ts`, and `stdio.ts` run an essentially identical loop: for each `McpToolRegistration`, call `buildZodShape(z, reg.inputSchema.properties, new Set(reg.inputSchema.required))`, then `mcpServer.registerTool(name, { description, inputSchema: z.object(zodShape) }, async (args) => reg.execute(args))`. `sdk.ts` does the analogous mapping via `tool()` from `@anthropic-ai/claude-agent-sdk` — same shape, different SDK. Each carries the same `// eslint-disable-next-line @typescript-eslint/no-explicit-any` for the handler signature, a strong indicator that the helper should be centralized once. The three non-SDK backends additionally each maintain their own `findAvailablePort` / `checkPort` / `PORT_RANGE_*` constants (`server.ts:27-29`, `sse.ts:27-30`, with identical `checkPort` implementations).

**Impact** — Any bug or improvement to the non-SDK registration loop must be applied three times independently; the duplicated `eslint-disable` comments also mask the same type-safety gap in multiple files. The `sdk.ts` variant tracks separately because it targets a different SDK API.

**Fix** — Extract `registerToolsOnMcpServer(mcpServer, z, registrations)` into `zod.ts` (or a new `mcp/internal.ts`) and have `server.ts`, `sse.ts`, and `stdio.ts` call it. Move `findAvailablePort` + `checkPort` + the port-range constants to the same shared internal module. This collapses three copies of the same logic into one and removes three of the four `eslint-disable` comments.

**Locations:**
- `packages/sdk/src/mcp/server.ts:286-304`
- `packages/sdk/src/mcp/sse.ts:204-226`
- `packages/sdk/src/mcp/stdio.ts:80-98`
- `packages/sdk/src/mcp/sdk.ts:349-362`

#### `sdk.ts` mixes MCP plumbing and a 200-line "system prompt context" feature
*Major · Effort: M · `packages/sdk/src/mcp/sdk.ts:31-66`, `:83-148`, `:150-320`*

**Observation** — `sdk.ts` is 363 lines. About half is the actual MCP SDK adapter (`createThenvoiSdkMcpServer`, `toSdkToolDefinition`). The other half is an unrelated feature: `getSystemPromptContext`, with its own cache (`contextCache`, `MAX_CONTEXT_CACHE_ENTRIES`, `evictLeastRecentlyUsedContext`), agent-identity duck-typing (`resolveAgentIdentity`), and room-title pagination (`resolveRoomTitle`). The duck typing also bypasses `AdapterToolsProtocol` by casting to `tools as AdapterToolsProtocol & { getAgentIdentity?: ...; rest?: ... }`.

**Impact** — The file has two distinct responsibilities that are difficult to navigate and test independently; the duck-typed casts bypass the type system and can silently break when the underlying protocol shape changes.

**Fix** — Move `getOrBuildSystemPromptContext`, `buildSystemPromptContext`, `resolveAgentIdentity`, `resolveRoomTitle`, `buildUnavailableSystemPromptContext`, and `evictLeastRecentlyUsedContext` into a sibling file `mcp/systemPromptContext.ts`. The duck-typed identity resolution should be replaced by adding `getAgentIdentity()` as an optional method on `AdapterToolsProtocol` (or a new sibling interface) so callers expose it through the protocol instead of casts.

[↑ Summary in review.md M17](../review.md#m17-mcpsdkts-mixes-mcp-plumbing-with-a-200-line-getsystempromptcontext-feature)

### Minor

#### `linear_ask_user` and `linear_select` overlap
*Minor · Effort: S · `packages/sdk/src/integrations/linear/tools.ts:113-167`*

**Observation** — `linear_ask_user` already supports an optional `options` array (2–20 items) that routes to `postSelectElicitation`. `linear_select` is the same thing without the free-text fallback (and accepts 1–25 options). Two tools with overlapping intent forces agents to pick between them; the description for `linear_select` even concedes "Use this instead of linear_ask_user when…".

**Impact** — Agents must choose between two tools with overlapping semantics, increasing the chance of incorrect tool selection and complicating documentation.

**Fix** — Keep `linear_ask_user` as the single elicitation tool, drop `linear_select`, and adjust the count bounds (1–25) on `linear_ask_user.options`. If a clear "selection is required" semantic is needed, expose it as a `required_selection: boolean` flag rather than as a sibling tool.

#### `console.warn` used in library code instead of injected logger
*Minor · Effort: S · `packages/sdk/src/integrations/linear/activities.ts:214`, `packages/sdk/src/integrations/linear/store.ts:397`*

**Observation** — `activities.updatePlan` and `SqliteSessionRoomStore.parseMetadata` both fall back to `console.warn`. The rest of the Linear vertical accepts a `Logger` via `LinearThenvoiBridgeDeps.logger` / `StaleSessionGuardOptions.logger` and uses `logger.warn("linear_thenvoi_bridge.*", { ... })` with structured context.

**Impact** — These two sites bypass the structured logging pipeline, making it impossible to suppress or redirect their output in production environments.

**Fix** — Plumb an optional `Logger` through these two call sites. For `updatePlan`, add `logger?: Logger` to its options or accept a `LinearActivityClient & { logger?: Logger }`-style facade. For `SqliteSessionRoomStore`, accept a logger in `createSqliteSessionRoomStore(dbPath, options?: { logger?: Logger })` and replace the `console.warn`.

#### `agent_config.yaml.example` is out of sync with example usage
*Minor · Effort: S · `packages/sdk/agent_config.yaml.example:9-72`*

**Observation** — `examples/letta/letta-agent.ts:43` calls `loadAgentConfig("letta_agent")` but the example file has no `letta_agent:` block, so a fresh user copying the example will hit a validation error from `loader.ts:36-40`. Conversely, the example declares `planner_agent`, `reviewer_agent`, and `linear_thenvoi_transport` that are never consumed from the SDK's `examples/` directory — they appear only in `tests/integration/` and via env-var overrides (`LINEAR_THENVOI_BRIDGE_RUNTIME_CONFIG_KEY` defaulting to `linear_thenvoi_bridge`).

**Impact** — A new user following the Letta example will encounter a confusing validation error that is not mentioned in any documentation.

**Fix** — Add a `letta_agent:` block. Either remove `planner_agent` / `reviewer_agent` / `linear_thenvoi_transport` from the example, or add a comment above them explaining they exist for the test/integration runtime — without a comment, users have no signal these keys are not for the bridge example.

#### MCP `multiRoom` boolean is fragile in the SDK backend path
*Minor · Effort: M · `packages/sdk/src/mcp/backends.ts:63-69`, `packages/sdk/src/mcp/sdk.ts:77-79`, `packages/sdk/src/mcp/registrations.ts:206-214`*

**Observation** — In `backends.ts`, when `options.kind === "sdk"`, `multiRoom` is forwarded into `createThenvoiSdkMcpServer` (which internally checks `multiRoom === false`). For the non-SDK kinds, the same check happens locally in `backends.ts`. There is no shared discriminator, so a caller that passes `kind: "sdk"` and forgets `multiRoom` may get different defaulting behavior than the non-SDK branches. `resolveSingleRoomTools(getToolsForRoom)` is called with the sentinel `""` to retrieve the single tools instance — a comment documents this but the `roomId: string` parameter still flows through into `getToolsForRoom`, which is easy to misread.

**Impact** — Inconsistent defaulting behavior across backend kinds can silently produce single-room or multi-room behavior depending on which backend is chosen, making the bug hard to diagnose.

**Fix** — Replace `tools: AdapterToolsProtocol | ((roomId: string) => ...)` plus a separate `multiRoom?: boolean` with a discriminated union (`{ mode: "single"; tools: AdapterToolsProtocol } | { mode: "multi"; getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined }`). This removes the `""` sentinel entirely and makes the "single vs multi" choice unambiguous at the call site.

#### `zod.ts` JSON-Schema-to-Zod conversion is incomplete
*Minor · Effort: M · `packages/sdk/src/mcp/zod.ts:16-53`*

**Observation** — The hand-rolled converter handles `string` (with enum), `number`/`integer`, `boolean`, `array`, and `object`, but silently collapses unknown types to `z.unknown()` and ignores `description`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `format`, and nested object `properties`. For an `object` it returns `z.record(z.string(), z.unknown())` regardless of what `properties` the JSON Schema declared. The `additionalTools` API in `BuildRegistrationsOptions` lets callers supply arbitrary JSON Schemas, so these properties will be lost. This is also worth noting that `zod-to-json-schema` (an existing dependency) goes the other direction; there is no library doing this direction in the project today, but `json-schema-to-zod` exists and could replace the hand-rolled code.

**Impact** — Tool input schemas lose their constraints and nested property definitions when converted to Zod, causing agents to receive less precise schema information and potentially pass invalid arguments.

**Fix** — Either document the limited subset explicitly in `zod.ts` (with a JSDoc list of supported keywords), or replace with a library. If kept hand-rolled, at minimum handle nested `object.properties` recursively and honor `description` via `.describe()` so the agent sees the schema annotations.

#### Linear bridge `runtime` is a parameter-passed mutable map
*Minor · Effort: M · `packages/sdk/src/integrations/linear/bridge/handler.ts:48-60`, `packages/sdk/src/integrations/linear/webhook.ts:74-75`, `:122-123`, `:216-217`*

**Observation** — `LinearBridgeRuntime` is created in three places (`createInlineLinearBridgeDispatcher`, `createInProcessLinearBridgeDispatcher`, `createLinearWebhookHandler`) and threaded through `handleAgentSessionEvent(input, { runtime })`. The runtime holds three caches (`roomResolutionLocks`, `resolvedHostHandleCache`, `authenticatedHostHandleCache`); the WeakMaps key on the `RestApi` instance, so a process that creates multiple `RestApi`s receives multiple caches. The intent is good — explicit DI rather than module-level singletons — but the three "create runtime" call sites mean a webhook handler and an external `handleAgentSessionEvent()` user can each get a separate cache for the same `RestApi`, defeating the cache.

**Impact** — Multiple independent cache instances for the same `RestApi` result in redundant network calls and potentially inconsistent state between the dispatcher and webhook handler in the same process.

**Fix** — Either (a) make the runtime an explicit construct callers create once and pass into both the dispatcher and the webhook handler (currently each creates its own), or (b) since the caches all key on `RestApi`, hoist them into a module-level `WeakMap<RestApi, BridgeCaches>` so they share automatically. The current shape is the worst of both worlds: it's plumbed explicitly but constructed multiple times per process.

#### `linear-thenvoi-bridge-server.ts` is 713 LOC and doubles as production code
*Minor · Effort: M · `packages/sdk/examples/linear-thenvoi/linear-thenvoi-bridge-server.ts`*

**Observation** — The Linear bridge "example" is 713 lines — 3× the next-largest example file (`linear-thenvoi-rest-stub.ts` at 249 lines) and approaching the M5 god-file threshold. More notably, the file is dual-role: the build-tests-docs strengths section explicitly notes it "doubles as the production bridge." Production code shipping under `examples/` is structurally surprising — readers scanning the Examples table treat the folder as a demo gallery and won't expect one of its entries to be the bridge server the SDK actually runs. Together with `integrations/linear/bridge/handler.ts` (already in the M5 list at 1326 LOC), the Linear bridge surface is a ~2000-LOC pair split across `src/` and `examples/`.

**Impact** — Two costs: (a) the file is hard to follow as a learning resource (its stated purpose under `examples/`), and (b) the dual role obscures the real layering — half the bridge is in `src/`, half outside, and consumers can't tell from the directory layout which is the SDK's product and which is illustrative.

**Fix** — Two options:
- **Split it up while keeping the file in `examples/`** — extract the production wiring (HTTP server, event loop, signal handling, secret loading) into a sibling utility file, and leave a thin demo entry that imports it. The "example" then stays under ~200 LOC.
- **Relocate to `src/`** — move the bridge server into `src/integrations/linear/bridge/server.ts` (or similar), and leave a small ~30-line example under `examples/linear-thenvoi/` that constructs and starts it. This separates the SDK's product from its demos and lets the example shrink to the audience that needs it.

The second option is cleaner architecturally but requires deciding the public-API shape of the relocated server. The first is a strict subset of the work and a reasonable interim step.

### Nits

#### `console.warn` plus unused `lastSeenAt` / `createdAt` fields
*Nit · Effort: S · `packages/sdk/src/mcp/server.ts:33-38`, `:198-230`*

**Observation** — `SessionRecord.createdAt` is set but only `lastSeenAt` is read (in `closeIdleSessions`). The field is harmless but it implies a use that doesn't exist.

**Impact** — Dead fields add noise to the type and suggest functionality that isn't there.

**Fix** — Drop `createdAt` from `SessionRecord` and the constructor literal, or use it in a startup log line.

#### Inconsistent semicolon style between MCP files
*Nit · Effort: S · `packages/sdk/src/mcp/sse.ts:27-249` (no trailing semicolons) vs `packages/sdk/src/mcp/server.ts` and `stdio.ts` (semicolons everywhere)*

**Observation** — `sse.ts` omits trailing semicolons on every statement while its peer backends use them. ESLint may not flag this if `semi` is off, but it's visually jarring across the same directory.

**Impact** — Inconsistent style within the same directory increases cognitive overhead when reading across files.

**Fix** — Run `eslint --fix` after adding/enabling a `semi` rule, or apply Prettier across `mcp/`.

#### `mcp/registrations.ts` builds JSON Schema by hand, then `zod.ts` reverses it
*Nit · Effort: L · `packages/sdk/src/mcp/registrations.ts:108-142` (builds JSON Schema) → `packages/sdk/src/mcp/zod.ts:1-53` (converts JSON Schema → Zod) → `packages/sdk/src/mcp/sdk.ts:349-362` (Zod → SDK tool def)*

**Observation** — The pipeline is: `TOOL_MODELS` (built somewhere from Zod-ish properties) → JSON Schema → Zod shape → MCP SDK tool definition. Each conversion loses fidelity (see "`zod.ts` JSON-Schema-to-Zod conversion is incomplete" above). The same source data is reformatted three times.

**Impact** — Each conversion step is a potential source of fidelity loss; the pipeline is difficult to extend and the intermediate JSON Schema representation adds maintenance burden.

**Fix** — If `TOOL_MODELS` could be authored directly as Zod schemas, the JSON-Schema intermediate disappears and `buildZodShape` can be removed. This is a larger refactor than this review proposes; flagging for the record.

## Strengths worth keeping

- **Linear vertical is properly isolated.** `core/`, `runtime/`, `agent/`, and `contracts/` have zero imports from `linear/` or `integrations/linear/`. The single exception is `CodexAdapter` reading three `linear_*` metadata keys (flagged as major above).
- **`src/linear/index.ts` is a pure re-export barrel** from `src/integrations/linear/` — matches "Module and Import Patterns" guidance about barrels.
- **No type duplication against `@linear/sdk`.** `LinearActivityClient` deliberately defines a subset surface for testing; types like `AgentSessionEventWebhookPayload`, `AppUserNotificationWebhookPayloadWithNotification`, `OAuthAppWebhookPayload`, and `LinearDocument as L` are consumed from `@linear/sdk` directly. `Notification` and `NotificationByType<T>` in `notification.ts:7-11` use `Extract<T, { __typename?: T }>` against the library's union type — a strong type-derivation pattern.
- **`js-yaml` loaded with `JSON_SCHEMA`.** `config/loader.ts:100` calls `yaml.load(raw, { schema: yaml.JSON_SCHEMA })`, which disables `!!js/function` and other code-execution tags. Not as restrictive as `FAILSAFE_SCHEMA` (which would block all type conversion) but safe against RCE.
- **`UNSAFE_KEYS` filter in `loader.ts:20-21` and `:64-68`** prevents prototype pollution via `__proto__` / `constructor` / `prototype` in YAML.
- **No Linear secrets logged.** Searches for `apiKey`, `accessToken`, `linearAccessToken`, `linearWebhookSecret` in log statements turn up nothing. `webhook.ts` validates the signature before doing anything with the body.
- **`mcp/backends.ts` is a clean dispatch.** Despite the four similar server classes, the public surface (`createThenvoiMcpBackend`, `ThenvoiMcpBackend`, `ThenvoiMcpBackendKind`) is small and consistent.
- **Bidirectional initiation is sound.** `agentSessionCreateOnIssue`, `agentSessionCreateOnComment`, and `createIssue` are all guarded by `typeof client.foo === "function"` in `tools.ts:649-723`, so missing capabilities surface as tool-not-registered rather than runtime crashes. `persistSessionRoom` shares logic between the two session-creation tools.
- **Optional peer dependencies are dynamically imported** in `server.ts:90-97`, `sse.ts:77-82`, `stdio.ts:55-57`, and `sdk.ts` (static — which is fine since `@anthropic-ai/claude-agent-sdk` is the entry point's whole purpose). The dynamic imports include `express`, `@modelcontextprotocol/sdk/server/*`, and `zod`, so a consumer that doesn't install them only pays at `start()` time, not at module load.
- **Example imports match the SDK surface.** All 10 named imports in `examples/linear-thenvoi/linear-thenvoi-bridge-server.ts:12-22` and 5 in `linear-thenvoi-bridge-agent.ts:10-15` resolve against `src/linear/index.ts`. No drift.
- **Stale-session keepalive is well factored.** `StaleSessionGuard` + `isSessionStale` + `sendRecoveryActivityIfStale` (in `stale-session-guard.ts`) is a focused module with one responsibility, structured logging, and `unref()` on the timer so it doesn't block process exit (line 60-62).

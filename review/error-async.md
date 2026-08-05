[← Back to top-level review](../review.md)

# Error Handling, Async, Cleanup, and Logging Review

Scope: `packages/sdk/src/` (152 `.ts` files). Cross-cutting audit against the code-style preferences guide's "Error Handling", "Async/Promise Patterns", "Resource Cleanup Patterns", and "Logging" sections.

## Summary

Hygiene is solid at the edges — logger DI, no credential leakage, no empty catches, comprehensive cleanup in the runtime — but the typed-error story is half-applied and a long tail of small inconsistencies (silent catches, `Promise.all` for cleanup, duplicated helpers) drags on diagnosability.

**What's good:**

- Logger DI everywhere with `NoopLogger` default; sensitive-key redaction in `ConsoleLogger.sanitizeValue`; no credential leakage detected.
- No empty `catch (e) {}` blocks anywhere in the tree; no `console.log` debug leftovers.
- `AgentRuntime` / `RoomPresence` / `PhoenixChannelsTransport` / `Letta` cleanup is paired, centralised, and uses `AbortController` correctly.
- `PlatformRuntime.start`/`stop` use `AggregateError` to preserve both original and cleanup errors.
- `UnsupportedFeatureError` wraps every optional-peer load failure with a helpful install hint.
- `StaleSessionGuard` error logging is exemplary — first-attempt at `error`, retry/keepalive at `warn`, both with `sessionId` + serialized error.

**What's not** (each linked to its full finding):

- The `ThenvoiSdkError` hierarchy is bypassed wholesale — see [63 bare `throw new Error` sites](#central-error-utility-ignored-by-63-bare-throw-new-error-sites) and [six custom error classes that don't extend it](#custom-error-classes-dont-extend-thenvoisdkerror).
- Error-message extraction is reinvented everywhere — see [duplicated and inline-reinvented 33 times](#no-central-safe-message-extraction-util-duplicated-and-inline-reinvented-33-times) and [duplicate `serializeError`](#duplicate-serializeerror-helper).
- Silent catches hide production failures — see [silent catches in critical paths drop error context](#silent-catches-in-critical-paths-drop-error-context), [`mcp/sdk.ts` returns warning string](#mcpsdkts-returns-warning-string-instead-of-throwing-or-logging), and [`mcp/registrations.ts:155`](#mcpregistrationsts155-returns-error-result-without-logging).
- Cleanup fan-outs use `Promise.all` where one failure leaks the rest — see [`Promise.all` used for cleanup](#promiseall-used-for-cleanup-one-failure-leaks-the-rest).
- `AbortSignal` plumbing stops at the streaming boundary — see [`AbortSignal` not plumbed through `ThenvoiLink` or `RestApi`](#abortsignal-not-plumbed-through-thenvoilink-or-restapi).
- Two `console.warn` calls bypass the injected logger — see [`console.warn` used instead of the injected logger](#consolewarn-used-instead-of-the-injected-logger).
- Three identical `sleep(ms)` and three identical `assertNever` helpers — see [redundant `sleep(ms)` helpers](#redundant-sleepms-helpers-three-copies) and [`assertNever` should be a shared util](#assertnever-should-be-a-shared-util).

## Findings

### Blockers

(none — no resource leaks confirmed, no empty catches, no credential leakage. The Promise.all-in-stop issues below are major rather than blocker because httpServer.close is unaffected.)

### Major

#### Central error utility ignored by 63 bare `throw new Error` sites
*Major · Effort: M · 60+ locations (see Locations below)*

**Observation** — `core/errors.ts` exports `ThenvoiSdkError`, `ValidationError`, `UnsupportedFeatureError`, `TransportError`, `RuntimeStateError`. Adapters and integrations consistently bypass them:

- **Validation throws** (`linear_update_issue requires...`) should be `ValidationError`.
- **"client not initialized" / "not connected"** should be `RuntimeStateError`.
- **"command is empty" / "stdio not exposed"** should be `ValidationError` or a new `ConfigurationError`.
- **`assertNever` fallbacks** (`Unhandled platform event`, `Unhandled contact event`) should at minimum be `ThenvoiSdkError`.
- **`new Error(String(error))` rewrappings** lose the original error's `cause` chain.

**Impact** — SDK consumers cannot catch errors selectively by type — every `throw new Error` bypasses the typed hierarchy, making SDK boundaries harder to program against and future error-translation refactors multiplicatively more expensive.

**Fix** — Pass an audit replacing `throw new Error(msg)` with the closest existing typed class. For "feature not available on this Linear client" cases use `UnsupportedFeatureError` to match the `FernRestAdapter` style. Where rewrapping `unknown` errors, use `new ThenvoiSdkError(message, error)` instead of `new Error(String(error))` so the original error survives in `cause`.

**Locations:**
- `packages/sdk/src/integrations/linear/tools.ts:333,354,369,397,415,422,460,514,528,559,575,746,776`
- `packages/sdk/src/adapters/codex/CodexAdapter.ts:258,451,541,566,1231,1303`
- `packages/sdk/src/adapters/a2a-gateway/server.ts:327,360,502,563,579`
- `packages/sdk/src/adapters/acp/ACPClientAdapter.ts:90,135,233,355,370,536`
- `packages/sdk/src/adapters/acp/ThenvoiACPServerAdapter.ts:182,226`
- `packages/sdk/src/client/rest/FernRestAdapter.ts:106,122,147,176`
- `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:250,781,841`
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:908,981`
- `packages/sdk/src/adapters/parlant/ParlantAdapter.ts:496,532`
- `packages/sdk/src/adapters/a2a/A2AAdapter.ts:163`
- `packages/sdk/src/integrations/linear/bridge/handler.ts:650`
- `packages/sdk/src/adapters/codex/appServerClient.ts:103,238,395`
- `packages/sdk/src/adapters/shared/lazyAsyncValue.ts:34`
- `packages/sdk/src/mcp/backends.ts:133`
- `packages/sdk/src/mcp/registrations.ts:211`
- `packages/sdk/src/adapters/openai/model.ts:238`
- `packages/sdk/src/adapters/gemini/model.ts:173`
- `packages/sdk/src/adapters/google-adk/GoogleADKAdapter.ts:130,153`
- `packages/sdk/src/adapters/opencode/client.ts:269,278,301,418`
- `packages/sdk/src/runtime/PlatformRuntime.ts:336`
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:437`
- `packages/sdk/src/adapters/a2a/types.ts:37`
- plus several `new Error(String(error))` re-wrappings (`adapters/codex/appServerClient.ts:156`, `adapters/letta/LettaAdapter.ts:893`, `runtime/PlatformRuntime.ts:263`, `runtime/rooms/AgentRuntime.ts:180,197`)

[↑ Summary in review.md M8](../review.md#m8-error-handling-consistency)

#### Custom error classes don't extend `ThenvoiSdkError`
*Major · Effort: S · 6 locations (see Locations below)*

**Observation** — Six bespoke error classes all `extends Error`. A consumer who wants to discriminate "this is from the Thenvoi SDK" cannot use `instanceof ThenvoiSdkError`.

**Impact** — SDK consumers must catch each custom class individually; a single top-level `instanceof ThenvoiSdkError` guard — the expected pattern — silently misses all six.

**Fix** — Have each extend `ThenvoiSdkError` (e.g. `class HttpStatusError extends ThenvoiSdkError`). Existing `instanceof HttpStatusError` checks in `OpencodeAdapter.ts:793` keep working; consumers gain a single discriminator.

**Locations:**
- `packages/sdk/src/adapters/codex/appServerClient.ts:46` (`CodexJsonRpcError`)
- `packages/sdk/src/adapters/opencode/client.ts:104` (`HttpStatusError`)
- `packages/sdk/src/runtime/ContactEventHandler.ts:70` (`ContactEventHandlerError`)
- `packages/sdk/src/runtime/tools/customTools.ts:11` (`CustomToolDefinitionError`)
- `packages/sdk/src/runtime/tools/customTools.ts:18` (`CustomToolValidationError`)
- `packages/sdk/src/runtime/tools/customTools.ts:30` (`CustomToolExecutionError`)

[↑ Summary in review.md M8](../review.md#m8-error-handling-consistency)

#### No central safe-message extraction util, duplicated and inline-reinvented 33 times
*Major · Effort: M · 30+ locations (see Locations below)*

**Observation** — `asErrorMessage` exists but lives in `adapters/shared/coercion.ts`, so non-adapter code (runtime, integrations, MCP, core) reinvents it. ACP wrote its own (identical) `toErrorMessage`. There are also two copies of a richer `serializeError` (returns `{name, message, stack, ...}`).

**Impact** — Maintenance burden — any change to the extraction logic (e.g. adding `cause` traversal) must be applied 30+ times. The two `serializeError` copies have already diverged.

**Fix** — Move `asErrorMessage` (+ a new `serializeError`) into `core/errors.ts`, export from `core/index.ts`. Replace inline reinventions and delete `toErrorMessage` and one of the two `serializeError`s.

**Locations:**
- `packages/sdk/src/adapters/shared/coercion.ts:82` (canonical `asErrorMessage`)
- `packages/sdk/src/adapters/acp/ACPClientAdapter.ts:581` (duplicate `toErrorMessage`)
- Inline `error instanceof Error ? error.message : String(error)` at: `integrations/linear/bridge/handler.ts:155,175,198,238,651`; `integrations/linear/store.ts:289-291,396`; `integrations/linear/activities.ts:214` (uses console + inline); `integrations/linear/webhook.ts:632 serializeError`; `runtime/ContactEventHandler.ts:435 serializeError`; `runtime/Execution.ts:279`; `runtime/PlatformRuntime.ts:263,320`; `runtime/rooms/AgentRuntime.ts:180,197`; `runtime/tools/AgentTools.ts:356`; `adapters/anthropic/model.ts:183`; `adapters/openai/model.ts:248`; `adapters/gemini/model.ts:298`; `adapters/vercel-ai-sdk/model.ts:197`; `adapters/claude-sdk/ClaudeSDKAdapter.ts:101,362`; `adapters/parlant/ParlantAdapter.ts:600`; `adapters/letta/LettaAdapter.ts:1083`; `mcp/registrations.ts:156`; `mcp/sdk.ts:241,284`; `adapters/opencode/OpencodeAdapter.ts:165`

[↑ Summary in review.md M6](../review.md#m6-coercion-and-error-extraction-helpers-duplicated-across-the-tree)

#### Silent catches in critical paths drop error context
*Major · Effort: M · 13 locations (see Locations below)*

**Observation** — 13 catch sites across critical paths either capture no error variable or log a message without including the error object, making production failures impossible to diagnose from logs alone.

**Impact** — Production failures in MCP teardown, session cleanup, and runtime recovery are invisible to operators; root-cause investigation requires attaching a debugger rather than reading logs.

**Fix** — At minimum, include the captured `error` (and a stable operation name + room/session ID where available) in each warn log; replace `.catch(() => undefined)` with `.catch((error) => this.logger.warn("opencode.deregister_mcp_failed", { name, error }))`.

**Locations:**
- `packages/sdk/src/runtime/rooms/RoomPresence.ts:52-56` — `try { subscribeAgentRooms } catch { /* Best-effort */ }`. No log of the error.
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:102-104,121-123` — `catch { this.logger.warn("...continuing without it"); }`. Error variable not captured, no error included in payload.
- `packages/sdk/src/runtime/Execution.ts:178-183,355-360` — `catch { this.logger.warn("Failed to fetch stale processing messages, skipping recovery", { roomId }); }`. Error not logged.
- `packages/sdk/src/mcp/server.ts:133-137` — `catch (error) { if (!res.headersSent) sendMcpError(res, 500, "Internal server error"); }`. The actual `error` is never logged; debugging 500s server-side is impossible.
- `packages/sdk/src/mcp/sse.ts:109-111` — `transport.onerror = () => { this.sessions.delete(sessionId) }`. Drops the error argument the SDK passes.
- `packages/sdk/src/agent/Agent.ts:90-95` — `try { await this.startPromise } catch { return true; }`. Stop swallows start-failure.
- `packages/sdk/src/runtime/shutdown.ts:65-68` — `catch { process.exit(1); }`. Forced exit with no diagnostic.
- `packages/sdk/src/adapters/opencode/client.ts:213,227,228,253` — `.catch(() => undefined)` chains in `registerMcpServer`/`deregisterMcpServer`/`close`. Failures during MCP teardown are invisible.

[↑ Summary in review.md M8](../review.md#m8-error-handling-consistency)

#### `Promise.all` used for cleanup; one failure leaks the rest
*Major · Effort: S · 3 locations (see Locations below)*

**Observation** — All three iterate sessions and call `await session.transport.close()`. If session A's close rejects, sessions B…N never get closed.

**Impact** — A single transport close failure during shutdown leaves all remaining MCP sessions and transports open, resulting in resource leaks and potential port/handle retention.

**Fix** — Switch to `Promise.allSettled`, log any rejected results at `warn` with `sessionId`, then continue to close the HTTP server.

**Locations:**
- `packages/sdk/src/mcp/server.ts:170` (`stop`)
- `packages/sdk/src/mcp/server.ts:257` (`closeIdleSessions`)
- `packages/sdk/src/mcp/sse.ts:152` (`stop`)

[↑ Summary in review.md M11](../review.md#m11-cleanup-uses-promiseall-where-allsettled-is-needed)

#### `AbortSignal` not plumbed through `ThenvoiLink` or `RestApi`
*Major · Effort: M · 3 locations (see Locations below)*

**Observation** — `AgentRuntime.stop()` aborts its `stopController`, but in-flight REST calls (e.g. a 4-attempt rate-limit-retry on `getAgentMe()`, paginated `listAllChats`, `markProcessing`/`markProcessed`/`markFailed`, contact-handler `createChatEvent`) cannot be cancelled. The Letta adapter shows the right pattern (`raceTimeout` cancelling underlying HTTP via signal).

**Impact** — REST calls can't be cancelled. The rate-limit retry loop in `withRateLimitRetry` can `sleep` ~16s ignoring any caller signal. The streaming side has `AbortSignal` plumbing — the asymmetry is the surface bug.

**Fix** — Add `signal?: AbortSignal` to `RestRequestOptions` (it already merges into Fern options at line 32-37 of `FernRestAdapter.ts`; the underlying Fern client supports it), and to `ThenvoiLink.markProcessing/Processed/Failed`. Have `AgentRuntime.stop()` pass its signal to in-flight cleanup REST calls.

**Locations:**
- `packages/sdk/src/platform/ThenvoiLink.ts` (all REST-facing methods)
- `packages/sdk/src/client/rest/FernRestAdapter.ts:73-98` (`withRateLimitRetry` has no signal)
- `packages/sdk/src/client/rest/types.ts` (`RestApi` shape)

[↑ Summary in review.md M9](../review.md#m9-abortsignal-not-plumbed-through-rest)

#### Retry/backoff is rate-limit only; no retry on transient 5xx or network errors
*Major · Effort: S · `packages/sdk/src/client/rest/FernRestAdapter.ts:59-98`*

**Observation** — `isFernRateLimitError` only matches HTTP 429. ECONNRESET, ETIMEDOUT, 502/503/504, and similar one-off failures (common with WebSocket-proxy fronted REST) cause immediate user-visible errors even though the retry framework is already in place.

**Impact** — Transient network errors that would succeed on a second attempt surface as hard failures to callers, degrading reliability on flaky connections or behind WebSocket-proxy fronted REST endpoints.

**Fix** — Generalize `isFernRateLimitError` into `isRetryableError(error)` covering 429, 502, 503, 504 and connect-reset Node error codes. Keep the existing backoff & jitter math.

#### `console.warn` used instead of the injected logger
*Major · Effort: S · 2 locations (see Locations below)*

**Observation** — `SqliteSessionRoomStore.getMetadata` (store.ts:391-399) logs corrupt metadata via `console.warn`; `updateAgentSessionPlan` (activities.ts:210-215) logs the legacy-plan fallback via `console.warn`. Both modules already receive a `Logger` (or could plumb one in) — `console.warn` bypasses redaction in `ConsoleLogger.sanitizeValue` and skips noop/level filtering for downstream consumers.

**Impact** — Consumers using `NoopLogger` or a custom logger still see output on `console.warn`; sensitive metadata values bypass the logger's sanitization and redaction pipeline.

**Fix** — Accept `logger: Logger` (default `new NoopLogger()`) and call `logger.warn(...)`.

**Locations:**
- `packages/sdk/src/integrations/linear/store.ts:397`
- `packages/sdk/src/integrations/linear/activities.ts:214`

[↑ Summary in review.md M8](../review.md#m8-error-handling-consistency)

#### Custom timeout reject pattern instead of `Promise.race`
*Major · Effort: S · 4 locations (see Locations below)*

**Observation** — Four sites build the timer-then-`reject` pattern manually with `setTimeout`/`clearTimeout`/`settled` flags. `ThenvoiACPServerAdapter.ts` already shows the cleaner `Promise.race([pending.done, new Promise<never>((_, reject) => setTimeout(…))])` form.

**Impact** — Manual timer/settled-flag patterns are error-prone and add boilerplate; the `settled` guard is easy to miss, and timer cleanup on early resolution must be handled manually at each site.

**Fix** — Introduce a `withTimeout(promise, ms, label)` helper in `core/utils.ts`; replace the four sites.

**Locations:**
- `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:215-231` (`waitForConnection`)
- `packages/sdk/src/adapters/codex/appServerClient.ts:194-205` (`recvEvent`)
- `packages/sdk/src/runtime/Execution.ts:100-136` (`waitForIdle`)
- `packages/sdk/src/adapters/a2a-gateway/A2AGatewayAdapter.ts:561-577` (`AsyncQueue.dequeue`)
- `packages/sdk/src/adapters/acp/ThenvoiACPServerAdapter.ts:243-251` already uses `Promise.race` correctly — good model.

### Minor

#### `.then(...).catch(...)` chains instead of `async/await`
*Minor · Effort: S · 5 locations (see Locations below)*

**Observation** — Five production code paths use `.then().catch()` chains where `async/await` would be clearer.

**Impact** — `.then/.catch` chains obscure control flow and make error-handling intent harder to review, especially for cleanup-on-failure patterns like the one in `Agent.start`.

**Fix** — In `Agent.start` (Agent.ts:76) the `.then().catch` is hiding a cleanup-on-failure pattern; an `async` IIFE or extracted method makes the intent obvious. In `appServerClient.ts:154` the chain is required because the `sendJson` is fire-and-forget inside the `new Promise` — leaving a comment explaining why would be sufficient.

**Locations:**
- `packages/sdk/src/agent/Agent.ts:76-81`
- `packages/sdk/src/adapters/codex/appServerClient.ts:154-157`
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:880-895`
- `packages/sdk/src/adapters/opencode/OpencodeAdapter.ts:840`
- `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:88-99`

#### Redundant `sleep(ms)` helpers (three copies)
*Minor · Effort: S · 3 locations (see Locations below)*

**Observation** — Three identical one-liner `sleep(ms)` implementations exist in separate modules with no shared definition.

**Impact** — Maintenance burden — any change to the sleep implementation (e.g. adding signal support) must be applied three times.

**Fix** — Hoist into `core/utils.ts` as `export async function sleep(ms: number): Promise<void>`.

**Locations:**
- `packages/sdk/src/client/rest/FernRestAdapter.ts:63-65`
- `packages/sdk/src/integrations/linear/webhook.ts:628-630`
- `packages/sdk/src/integrations/linear/bridge/handler.ts:1317-1319`

#### Duplicate `serializeError` helper
*Minor · Effort: S · 2 locations (see Locations below)*

**Observation** — Two copies of a `serializeError` helper (returns `{name, message, stack, ...}`) exist in separate modules and will diverge over time.

**Impact** — Maintenance burden — the two copies have different calling contexts and may silently diverge in format, making log output inconsistent.

**Fix** — Combine into `core/errors.ts` alongside `asErrorMessage`.

**Locations:**
- `packages/sdk/src/runtime/ContactEventHandler.ts:435-451`
- `packages/sdk/src/integrations/linear/webhook.ts:632-642`

#### Info-level used for "unhandled" / unexpected payloads
*Minor · Effort: S · `packages/sdk/src/integrations/linear/notification.ts:65,81,123,135`*

**Observation** — Most of these are legitimately info (skipping is expected). `notification_unhandled` is borderline — it indicates an unknown notification shape; `warn` would help operators spot Linear schema drift earlier.

**Impact** — Unknown notification shapes logged at `info` are easy to overlook in log aggregators that filter by level; Linear schema drift may go undetected until it causes a downstream failure.

**Fix** — Promote `notification_unhandled` to `warn`.

#### `info`-level log on every "Phoenix socket closed"
*Minor · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:54-71`*

**Observation** — Open/close cycles can be frequent during network reconnect. `info` for the initial open is fine; reconnect chatter is better at `debug`.

**Impact** — High-frequency reconnect cycles flood `info` logs, making it harder to find meaningful state transitions in log aggregators.

**Fix** — Keep first open at `info`; demote subsequent reopen/close to `debug` (track a `hasLoggedOpen` flag).

#### `mcp/sdk.ts` returns warning string instead of throwing or logging
*Minor · Effort: S · 2 locations (see Locations below)*

**Observation** — `resolveAgentIdentity` and `resolveRoomTitle` silently return `{value: null, warning: "..."}`. The warning is bubbled up into MCP responses but never logged server-side, so debugging requires reading the MCP client output.

**Impact** — Server-side operators have no visibility into identity/room resolution failures; diagnosing MCP tool failures requires correlating client-side MCP responses with server logs that contain no corresponding entry.

**Fix** — Add `logger.warn("mcp.resolve_agent_identity_failed", { error })` (with the captured error) before returning.

**Locations:**
- `packages/sdk/src/mcp/sdk.ts:238-243`
- `packages/sdk/src/mcp/sdk.ts:281-287`

#### `mcp/registrations.ts:155` returns error result without logging
*Minor · Effort: S · `packages/sdk/src/mcp/registrations.ts:149-158`*

**Observation** — All MCP tool-execution failures are swallowed into the JSON response with no server-side log. For tools that crash unexpectedly (vs. business-rule errors), this loses operator visibility.

**Impact** — Unexpected tool execution crashes produce no server-side log entry; operators must rely on MCP clients reporting errors rather than being alerted by their own log monitoring.

**Fix** — Log non-`isToolExecutorError` failures at `warn` with `toolName` and `error`.

### Nits

#### `assertNever` should be a shared util
*Nit · Effort: S · 3 locations (see Locations below)*

**Observation** — Three identical `assertNever` implementations exist in separate runtime files.

**Impact** — Minor maintenance overhead — any change to the exhaustiveness check behavior must be applied three times.

**Fix** — Move to `core/utils.ts` and have all three callers import it.

**Locations:**
- `packages/sdk/src/runtime/PlatformRuntime.ts:335-337`
- `packages/sdk/src/runtime/ContactEventHandler.ts:454-456`
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:436-438`

#### `Linear bridge could not resolve…` throws bare `Error`
*Nit · Effort: S · `packages/sdk/src/integrations/linear/bridge/handler.ts:650-653`*

**Observation** — A bare `throw new Error(...)` is used where `ValidationError` would be consistent with `PlatformRuntime` constructor validation patterns.

**Impact** — Inconsistency — callers cannot distinguish this validation failure from other error types using `instanceof ValidationError`.

**Fix** — Use `ValidationError` (consistent with `PlatformRuntime` constructor validation).

#### `linear_thenvoi_bridge.acknowledgment_failed` logs `error.message` only, drops stack
*Nit · Effort: S · `packages/sdk/src/integrations/linear/bridge/handler.ts:152-157`*

**Observation** — Logger already serializes Errors with stack (via `sanitizeValue`); passing `error` directly is preferable to `error instanceof Error ? error.message : String(error)`. Same pattern appears at lines 175, 198, 238 of `bridge/handler.ts`.

**Impact** — Stack traces are lost in logs, making it harder to pinpoint the source of acknowledgment failures.

**Fix** — Pass the raw `error` (or `serializeError(error)`) to the logger; rely on `sanitizeValue` to format.

#### `Promise.reject(new Error("Operation aborted"))` in `LettaAdapter.raceTimeout`
*Nit · Effort: S · 2 locations (see Locations below)*

**Observation** — Should use the standard `AbortError` (DOMException with name "AbortError") for consistency with Web standards; callers can `instanceof DOMException` check.

**Impact** — Callers must string-match `"Operation aborted"` to detect timeout vs other rejections; the non-standard error type breaks ecosystem conventions for abort detection.

**Fix** — `new DOMException("Operation aborted", "AbortError")` (Node 17+).

**Locations:**
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:839`
- `packages/sdk/src/adapters/letta/LettaAdapter.ts:874-876`

#### `Codex returned an invalid …` messages are throw-and-stringify
*Nit · Effort: S · `packages/sdk/src/adapters/codex/CodexAdapter.ts:258,451,541,566`*

**Observation** — Four validation failure sites in `CodexAdapter` throw bare `Error` instead of `ValidationError`, making it impossible for callers to distinguish transport failures from validation failures.

**Impact** — Callers cannot distinguish transport vs. validation failures using typed `instanceof` checks.

**Fix** — Use `ValidationError` so SDK consumers can discriminate transport vs. validation failures.

## Strengths worth keeping

- **Logger architecture is solid** — `Logger` is an interface; `NoopLogger` is the default; `ConsoleLogger` sanitizes recursively, strips circular refs, redacts sensitive keys (`authorization|api[-_]?key|token|secret|password|cookie`), and serializes `Error` objects with `name/message/stack/cause`. No detected credential leakage anywhere. Logger is consistently DI'd via constructor options.
- **Phoenix channel cleanup is paired and centralized** — `PhoenixChannelsTransport.leave()` removes refs (`channel.off`) before `channel.leave()`, and `disconnect()` iterates over all topics. Error path in `doJoin` (lines 164-172) also cleans up refs before re-throwing.
- **AgentRuntime/RoomPresence cleanup is comprehensive** — `AgentRuntime.stop()` walks `executions` (line 153), `subscribedRooms` (161), `contexts` (165), `executionWatchers`, and `unsubscribeAgentContacts` before `link.disconnect`.
- **AbortController plumbed correctly in Letta** — `LettaAdapter.raceTimeout` (line 832) derives a child controller from a parent signal, removes listeners on both abort paths, uses `timer.unref()`, and propagates cancellation into the underlying HTTP call.
- **`AggregateError` used for compound cleanup failures** — `PlatformRuntime.start` (line 213) and `stop` (line 254) preserve both the original error and the cleanup error.
- **Rate-limit retry with exponential backoff + jitter** — `FernRestAdapter.withRateLimitRetry` (line 73) is the right shape; just needs generalizing to other transient errors.
- **No empty catch blocks** anywhere in the tree (`catch (e) {}` — 0 occurrences).
- **No `console.log` debug leftovers** in production code paths.
- **`Promise.allSettled` correctly used** for fan-out where individual failures are independent — `ThenvoiLink.disconnect` (line 130), `LettaAdapter.onCleanup` (line 439), `ParlantAdapter` (line 257), `webhook.ts` (line 133).
- **Typed errors at SDK construction boundaries** — `PlatformRuntime` constructor uses `ValidationError` (lines 70, 76); `RuntimeStateError` for "not initialized" / "not started" (lines 101, 272, 280, 288).
- **`UnsupportedFeatureError` for optional-dependency loading** — All `await import("...").catch` shims (Anthropic, OpenAI, Gemini, Vercel AI, LangGraph, Claude SDK, Parlant, Letta, OpenCode, ACP, node:sqlite) wrap missing-package errors in `UnsupportedFeatureError` with a helpful install hint.
- **`StaleSessionGuard` error logging is exemplary** — see packages/sdk/src/integrations/linear/stale-session-guard.ts:84-90 (`list_sessions_failed` at `error`) and :111-115 (`keepalive_failed` at `warn`); both include `sessionId` and serialized error.

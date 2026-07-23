[← Back to top-level review](../review.md)

# Core, Agent, and Runtime Review

## Summary

The core/agent/runtime slice is structurally reasonable — state is mostly owned by clear classes (`PlatformRuntime` → `AgentRuntime` → `Execution`/`ExecutionContext`), Phoenix channel join/leave is paired and centralized, and the error hierarchy is small and used consistently. The pervasive problem is lifecycle state expressed as 2–4 independent booleans across the major classes, producing fragile invariants and at least one unrecoverable failure mode.

**What's good:**

- Error hierarchy is small and used consistently — `ThenvoiSdkError` base with typed subclasses everywhere on the public surface.
- Logger is properly injected via constructor options; no singleton imports of a default instance.
- Phoenix channel setup/teardown is centralized in `PhoenixChannelsTransport` with paired join/leave bookkeeping.
- `runtime/rooms/subscriptions.ts` extracts pure utilities (`trackRoomJoin`, `trackRoomLeave`, `hydrateTrackedRooms`).
- `AgentRuntime.consumeLoop` uses `AbortSignal` for cancellation.
- Discriminated unions are used for `PlatformEvent` with exhaustive switching via `assertNever`.
- Type safety is high — no `any`, no `@ts-ignore`, ESLint enforces `no-explicit-any: error` in `src/`.
- `runtime/shutdown.ts` `GracefulShutdown` correctly handles SIGINT/SIGTERM/SIGHUP and double-signal force-exit.

**What's not** (each linked to its full finding):

- A failed stop leaves the runtime permanently stuck — [`PlatformRuntime.stop()` leaks `stopping=true`](#platformruntimestop-leaves-stoppingtrue-on-every-error-path).
- `AgentRuntime.start()` aborts a freshly-constructed controller on every entry — [stale aborted controller for consume loop](#agentruntimestart-re-entry-uses-a-stale-aborted-controller-for-the-consume-loop-signal).
- Lifecycle modelled as ad-hoc booleans across four classes — [discriminated unions needed](#lifecycle-expressed-as-2-4-independent-booleans-across-agentplatformruntimeagentruntimeexecution).
- `Agent.startPromise` is never cleared after success — [`stop()` then `start()` skips re-start](#agentstartpromise-is-never-cleared-after-success-stop-then-start-skips-re-start)
.
- Several god-classes mix 6–9 concerns — [`ContactEventHandler`](#contacteventhandler-is-a-god-class-mixing-6-concerns), [`ExecutionContext`](#executioncontext-mixes-context-management-hydrationcaching-participant-tracking-and-message-dedup), [`Execution`](#execution-mixes-queue-management-recovery-sync-retry-status-reporting-and-idle-waiters).
- `simpleAdapter.ts` lives in `core/` despite being an adapter base class — [misplaced file](#simpleadapterts-lives-in-core-despite-being-an-adapter-base-class).
- JSDoc absent on every class in `runtime/` — [public surface undocumented](#jsdoc-absent-across-runtime-public-surface).
- `ParticipantTracker` and `RoomPresence` are exported but unused parallel implementations — [`ParticipantTracker`](#participanttracker-is-exported-and-duplicates-executioncontexts-participant-logic), [`RoomPresence`](#roompresence-is-exported-but-appears-to-be-unused-parallel-implementation-of-agentruntimes-room-logic).

## Findings

### Blockers

#### `PlatformRuntime.stop()` leaves `stopping=true` on every error path
*Blocker · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:222-268`*

**Observation** — `stop()` sets `this.stopping = true` at line 233 but only resets it to `false` at line 266, *after* the success path. Both the `runtimeError` rethrow (line 263) and the adapter cleanup rethrow (line 259) skip the reset. After a failed stop, every subsequent `stop()` returns `true` immediately (line 224 guard) and `this.runtime`/`activeAdapter` are already cleared at line 234, so the next attempt is a silent no-op. This is an unrecoverable state and there's no way to retry shutdown.

**Impact** — The runtime becomes permanently stuck after a failed stop — subsequent `stop()` calls silently no-op, making recovery impossible.

**Fix** — Move the `this.stopping = false` reset into a `finally` block, or model the lifecycle as a discriminated union (`{ status: "stopped" | "running" | "stopping" | "stop_failed" }`) so retry semantics are explicit. At minimum, `finally { this.stopping = false; }`.

[↑ Summary in review.md B2](../review.md#b2-platformruntimestop-permanently-sets-thisstopping-to-true-on-error-paths)

#### `AgentRuntime.start()` re-entry uses a stale aborted controller for the consume loop signal
*Blocker · Effort: M · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:80-124`*

**Observation** — Lines 88-91 unconditionally `abort()` the existing controller, then immediately replace it. On the very first `start()` this aborts a freshly-constructed controller that nobody is listening on (harmless but confusing), but the comment in the constructor field initializer (line 52) implies the controller is created here just to satisfy the type-checker — the start logic resets it. The "abort then replace" pattern is brittle; combined with `handleStartFailure` also calling `abort()` on the old controller (line 129) plus `consumeLoop` already exited, it's easy to wire a future bug where the new consumeLoop accidentally observes the old signal.

**Impact** — A correctness landmine — the brittle state machine makes it easy to introduce bugs where the new consumeLoop accidentally observes a stale aborted signal.

**Fix** — Initialise `stopController` to `null` (or remove the field initializer entirely) and only construct it where the consumeLoop is launched. Make state transitions explicit (`status: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"`).

[↑ Summary in review.md B3](../review.md#b3-agentruntimestart-aborts-the-field-init-abortcontroller-on-every-entry)

### Major

#### `Agent.startPromise` is never cleared after success; `stop()` then `start()` skips re-start
*Major · Effort: M · `packages/sdk/src/agent/Agent.ts:71-104`*

**Observation** — `start()` (line 71) returns the existing `startPromise` if one is set, and only clears it on rejection (line 79). On success the resolved promise stays in the field. When `stop()` is later called and the agent *is* started (line 86 condition fails), the success path goes through the `try/finally` at lines 98-103, which *does* clear `startPromise`. So far OK. BUT consider: `stop(timeoutMs)` fails internally — `platformRuntime.stop()` throws (see blocker above), the `finally` still runs, `started=false` and `startPromise=null`. Now `runtime` is destroyed but `PlatformRuntime.stopping=true`. Subsequent `start()` constructs a new `startPromise` calling `platformRuntime.start(adapter)`. `PlatformRuntime.start()` calls `initialize()` which is guarded by `initPromise` — already resolved, so it skips. Then it sets `this.activeAdapter = adapter` and tries to `new AgentRuntime(...)`. But the previous `AgentRuntime.stop()` may have thrown leaving link in a bad state, and `PlatformRuntime` has no way to tell. This compounds the blocker above.

**Impact** — A failed `stop()` followed by `start()` can silently construct a new `AgentRuntime` against a link left in a bad state, leading to undefined behavior.

**Fix** — Track explicit lifecycle states with a discriminated union and clear all related state atomically in one place.

#### Lifecycle expressed as 2-4 independent booleans across `Agent`/`PlatformRuntime`/`AgentRuntime`/`Execution`
*Major · Effort: M · 4 lifecycle classes (see Locations below)*

**Observation** — Each class invents its own ad-hoc state machine. This produces several latent bugs (the blocker above, and `Execution.running` being mutated from three different methods — `stop()`, `executeEvent()` on failure, and never set to true after construction). It also makes the relationship between e.g. `AgentRuntime.running=false` and `AgentRuntime.stopping=true` unclear: in `stop()` both are set, in `handleStartFailure()` only `running=false`, in `failRuntime()` only `running=false`. `ExecutionContext` does this correctly via `ExecutionState = "starting" | "idle" | "processing"` (file line 11); that pattern should be used everywhere.

**Impact** — Independent booleans admit impossible state combinations, directly causing B2 and B3 and producing a class of latent lifecycle bugs.

**Fix** — Replace boolean fields with `type RuntimeStatus = { kind: "idle" } | { kind: "starting"; promise: Promise<void> } | { kind: "running"; controller: AbortController } | { kind: "stopping" } | { kind: "stopped" } | { kind: "failed"; error: unknown }`. This makes every method audit each transition explicitly.

**Locations:**
- `packages/sdk/src/agent/Agent.ts:26-28` (`started` + `startPromise`)
- `packages/sdk/src/runtime/PlatformRuntime.ts:58-66` (`initPromise` + `runtime` + `contactHandler` + `activeAdapter` + `stopping` + `contactsSubscribed`)
- `packages/sdk/src/runtime/rooms/AgentRuntime.ts:50-54` (`running` + `stopping` + `stopController.signal.aborted` + `consumeTask` + `fatalError`)
- `packages/sdk/src/runtime/Execution.ts:56-60` (`processTask` + `syncComplete` + `running` + `inFlight`)

[↑ Summary in review.md M1](../review.md#m1-lifecycle-modeled-as-ad-hoc-booleans-instead-of-discriminated-unions)

#### `ContactEventHandler` is a god-class mixing 6 concerns
*Major · Effort: L · `packages/sdk/src/runtime/ContactEventHandler.ts` (462 lines)*

**Observation** — The class mixes the following concerns:

1. **Strategy dispatch** — routing between `callback`, `hub_room`, and `disabled` modes.
2. **Dedup** with LRU eviction.
3. **Request-info cache** — LRU cache with REST fallback.
4. **Message formatting** for broadcast and hub-room channels.
5. **Hub-room init** with promise lock.
6. **Error wrapping** via `ContactEventHandlerError`.
7. **Error serialization** (lines 435-451) — reimplements exactly what `core/logger.ts` `sanitizeValue` already does.

The `HUB_ROOM_SYSTEM_PROMPT` constant (lines 16-43) is also defined here — it belongs in `prompts.ts`.

**Impact** — Hard to navigate, hard to test in isolation, and refactors are high-risk — any change risks touching multiple unrelated concerns.

**Fix** — Extract by concern:

- **`LruCache<TKey, TValue>`** → `utils/`.
- **`formatContactEvent` / `formatContactBroadcast`** → `formatters/contact.ts` (matches the pattern already used by `runtime/formatters.ts`).
- **`HUB_ROOM_SYSTEM_PROMPT`** → `runtime/prompts.ts`.
- **`ContactEventHandlerError`** → `core/errors.ts` (or a new `contact/errors.ts`).
- **Remove `serializeError`** entirely — rely on the logger's sanitizer.

[↑ Summary in review.md M5](../review.md#m5-god-files-and-god-classes)

#### `ExecutionContext` mixes context management, hydration/caching, participant tracking, and message dedup
*Major · Effort: L · `packages/sdk/src/runtime/ExecutionContext.ts` (385 lines, ~16 public methods)*

**Observation** — A single class owns 9 distinct concerns:

1. **Message history + dedup** — `history`, `messageIds`, `dedupCache`, `recordMessage`, `hasMessage`.
2. **Hydrated context cache with TTL** — `contextCache`, `contextCacheExpiresAt`, `hydrateContext`, `isCacheExpired`, `nextCacheExpiry`.
3. **Participant list management** — `participants`, `addParticipant`, `removeParticipant`, `setParticipants`, `consumeParticipantsMessage`, `lastSentParticipantIds`.
4. **Contacts message buffering**.
5. **Pending system messages**.
6. **Retry tracker passthrough**.
7. **Tools instance ownership**.
8. **LLM-initialised flag**.
9. **Execution state** — `"starting"` / `"idle"` / `"processing"`.

Concerns (3) and (6) are duplicates of existing classes: `ParticipantTracker` (`runtime/participantTracker.ts`, 66 lines) already owns concern (3) — see the related Minor finding — and `MessageRetryTracker` already owns concern (6).

**Impact** — The class conflates 9 distinct concerns, making it hard to test any one responsibility in isolation and increasing the blast radius of every change.

**Fix** — Decompose into:

- **`ConversationHistory`** — owns history + dedup + `maxContextMessages` (concern 1).
- **`ContextHydrator`** — owns the hydrate/cache logic (concern 2).
- **Reuse the existing `ParticipantTracker`** for concern 3 instead of reimplementing it.
- **Leave only orchestration in `ExecutionContext`** — wire the above together, hold the tools instance and execution state.

[↑ Summary in review.md M5](../review.md#m5-god-files-and-god-classes)

#### `Execution` mixes queue management, recovery, sync, retry, status reporting, and idle waiters
*Major · Effort: L · `packages/sdk/src/runtime/Execution.ts` (362 lines)*

**Observation** — The class is responsible for 7 distinct concerns:

1. **Event queue + waiters** — `enqueue`, `nextQueuedEvent`, `waiters`.
2. **Idle waiters with timeouts** — `waitForIdle`, `idleWaiters`. (Manual timeout that should be `Promise.race`.)
3. **Stale message recovery** from REST — `recoverStaleProcessingMessages`.
4. **REST/WS sync** — `synchronizeWithNext`.
5. **Retry coordination** — `retryTracker`.
6. **Execution orchestration** — `executeEvent`, `executeSyncMessage`.
7. **WS-message dedup against synced messages** — `drainedWsMessageIds`, `syncProcessedIds`, `firstWsMessageId`.

Several helpers (`toMessageEvent`, the entire sync algorithm) are not really class-state-dependent and could be pure utilities.

**Impact** — The class mixes 7 concerns, making it hard to navigate, test in isolation, or refactor safely.

**Fix** —

- **Extract `syncMessages(link, retryTracker, logger)` and `recoverStale(link, retryTracker, logger)` as pure functions** — they don't need class state.
- **Replace `waitForIdle` with `Promise.race([idlePromise, timeoutPromise])`** so the manual timeout / clear-timeout dance goes away.

[↑ Summary in review.md M5](../review.md#m5-god-files-and-god-classes)

#### `AgentRuntime.stop()` cleanup ordering is sequential and not paired with setup
*Major · Effort: M · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:80-183`*

**Observation** — `start()` and `stop()` aren't symmetric. The two sequences:

**`start()` steps:**
1. `connect`
2. `subscribeAgentRooms`
3. `subscribeExistingRooms`
4. start `consumeLoop`
5. `subscribeAgentContacts`

**`stop()` steps:**
1. `abort` + await `consumeTask`
2. Stop executions one-by-one in a `for` loop (linear in N rooms when they could run in parallel via `Promise.all`)
3. `leaveTrackedRoom` per room
4. Clear maps
5. `unsubscribeAgentContacts`
6. `disconnect`

There's no symmetric "leave agent_rooms" call — it's implicit in `disconnect()` of the transport. The cleanup steps are inlined inside `stop()` rather than mirrored against the start steps via paired helper functions, so adding a new channel subscription requires modifying both methods in different ways.

**Impact** — Cleanup is hard to audit for completeness and asymmetric with setup — adding new subscriptions risks forgetting the teardown step.

**Fix** —

- **Introduce a `subscribeChannels()` / `unsubscribeChannels()` pair on `ThenvoiLink`** that owns the full set of channel subscriptions, so adding a channel touches one symmetric pair instead of two unsymmetric methods.
- **Parallelise execution shutdown in `AgentRuntime.stop()`** with `Promise.all(this.executions.values().map(e => e.stop(...)))` — they're independent, the current `for` loop serialises them unnecessarily.

#### `AgentRuntime.stop()` swallows fatalError if cleanup throws
*Major · Effort: S · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:153-183`*

**Observation** — If any `leaveTrackedRoom` (line 162) or `onSessionCleanup` (line 166) throws, control jumps out of `stop()` with that error, and the subsequent `if (this.fatalError) throw` at line 179-181 never runs. The fatal error from the runtime is silently lost. Also, the loop at line 161-163 awaits each leave sequentially; a single hung leave blocks the entire shutdown without a timeout.

**Impact** — The original `fatalError` (the root cause of the shutdown) is silently dropped whenever any cleanup step throws, making the actual failure invisible to callers.

**Fix** — Wrap individual cleanup steps with `Promise.allSettled`, collect errors, and rethrow an `AggregateError` (same pattern used in `PlatformRuntime.stop()`).

[↑ Summary in review.md M11](../review.md#m11-cleanup-uses-promiseall-where-allsettled-is-needed)

#### `executeEvent` mutates `this.running = false` and clears the queue on first failure — single error kills the runtime per room
*Major · Effort: M · `packages/sdk/src/runtime/Execution.ts:291-316`*

**Observation** — Line 307 sets `this.running = false` and 308 splices the queue empty whenever any WS event handler throws. This is intentional fail-fast behaviour for fatal runtime errors, but it's not documented and is asymmetric with `executeSyncMessage` (line 260-289) which logs and swallows. From the caller side, `AgentRuntime.consumeLoop` already catches and calls `failRuntime`, so the in-Execution shutdown is duplicated. The double-shutdown means errors trigger *both* the Execution-level kill path and the AgentRuntime-level abort path.

**Impact** — Undocumented dual-shutdown paths make it hard to reason about which failure handling is authoritative, and the asymmetry with `executeSyncMessage` is a latent source of confusion.

**Fix** — Document the contract (likely: WS events are fail-fast, REST sync errors are best-effort). Or unify into a single failure callback. Add JSDoc on `executeEvent` and `executeSyncMessage` describing the distinction.

#### `PlatformRuntime.executeAdapter` status-reporting flow is hard to follow
*Major · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:319-325`*

**Observation** — When the adapter throws, the code awaits `markFailed` in best-effort mode (it logs at `warn` only via `markMessageStatus`), then rethrows the original adapter error at line 324. The flow is correct under current invariants (`bestEffort` prevents `markFailed` from throwing), but it depends on those invariants being preserved. The control flow would be clearer if status reporting were wrapped in its own try/catch independent of the original error path.

**Impact** — The current structure relies on implicit invariants being preserved — a future change to `markFailed` could break error propagation without a clear compile-time signal.

**Fix** — Replace with `try { await adapter.onEvent(input); markProcessed(...); } catch (e) { logger.error(...); markFailed(...).catch(...); throw e; }` to make the lifecycle obvious.

#### `Agent.create` silently allows empty agentId/apiKey
*Major · Effort: S · `packages/sdk/src/agent/Agent.ts:36-61`*

**Observation** — `Agent.create({ adapter })` with no `config`, no `agentId`, no `apiKey` produces `new PlatformRuntime({ agentId: "", apiKey: "", ... })`, which then throws `ValidationError` in `PlatformRuntime`'s constructor. The error message says "Use loadAgentConfig()", which is fine, but the failure is at a layer the user didn't construct. `Agent.create` is the documented entry point and should perform its own clear validation.

**Impact** — The error surfaces from an internal layer the user didn't interact with, producing a confusing message that doesn't point to the correct fix site.

**Fix** — Validate in `Agent.create` itself with a clearer message that mentions the `Agent.create` parameters (`agentId`, `apiKey`, or `config`).

### Minor

#### `simpleAdapter.ts` lives in `core/` despite being an adapter base class
*Minor · Effort: S · `packages/sdk/src/core/simpleAdapter.ts`*

**Observation** — All 10 consumers of `SimpleAdapter` are in `src/adapters/`. The only thing the class needs from `core/` are protocol types (which themselves live in `contracts/protocols`). Putting an adapter base class in `core/` blurs the boundary; new adapters look in `adapters/` and may not find it.

**Impact** — New adapter authors look in `adapters/` and may not find `SimpleAdapter`, slowing discovery and blurring the `core/` boundary.

**Fix** — Move to `src/adapters/SimpleAdapter.ts` and update imports + the barrel export in `core/index.ts` / root `index.ts`.

#### `isDirectExecution.ts` is single-line glue in `core/`
*Minor · Effort: S · `packages/sdk/src/core/isDirectExecution.ts`*

**Observation** — This is a 6-line process-arg detection helper used only by example files (no src consumers). It's also tied to `import.meta.url` which is an ESM concept. Suitable for `lib/utils/` (general-purpose) rather than `core/` (SDK heart).

**Impact** — A utility with no `src/` consumers pollutes `core/` and is needlessly exposed in the public API.

**Fix** — Move to a `src/utils/` folder, or co-locate it with the examples and remove from the SDK public API since no source code in `src/` uses it. The file lacks JSDoc.

#### `ParticipantTracker` is exported and duplicates `ExecutionContext`'s participant logic
*Minor · Effort: S · `packages/sdk/src/runtime/participantTracker.ts`, exported at `packages/sdk/src/runtime/index.ts:65`*

**Observation** — `ParticipantTracker` is fully implemented (add/remove/changed/markSent) but unused anywhere in `src/`. `ExecutionContext` reimplements the same logic inline (`addParticipant`/`removeParticipant`/`consumeParticipantsMessage` with `lastSentParticipantIds`). Either consolidate by making `ExecutionContext` delegate to `ParticipantTracker`, or delete `ParticipantTracker`.

**Impact** — Dead code in the public API surface; future maintainers waste time determining which participant-tracking implementation is canonical.

**Fix** — Delete `participantTracker.ts` if not needed externally, or refactor `ExecutionContext` to use it (preferred for "Avoiding Duplication").

[↑ Summary in review.md M19](../review.md#m19-participanttracker-and-roompresence-are-unused-parallel-implementations)

#### Dead `assertNever` function in `PlatformRuntime.ts`
*Minor · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:335-337`*

**Observation** — No caller. The contact-event handler at line 328-332 already just forwards to `contactHandler.handle(event)` without exhaustive checking.

**Impact** — Dead code adds noise and may confuse readers into thinking exhaustive checking is happening when it isn't.

**Fix** — Delete the function.

#### Dead/duplicate `toMessageEvent` synthetic-event construction in `AgentRuntime.getOrCreateExecution`
*Minor · Effort: S · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:321-336`*

**Observation** — Hand-built fake `PlatformEvent` with `id: "execution-failed"`, content `""`, `inserted_at: new Date(0).toISOString()` exists only so `failRuntime()` has an event to log. The `failRuntime` signature requires a `PlatformEvent` but the watcher path has no real event. This is a smell that `failRuntime` should accept an optional event, not synthesise a fake one.

**Impact** — Fake event construction is confusing and masks that the watcher path has no real event to pass.

**Fix** — Change `failRuntime(error, event?: PlatformEvent)` and pass undefined here.

#### Manual timeout instead of `Promise.race` in `Execution.waitForIdle`
*Minor · Effort: S · `packages/sdk/src/runtime/Execution.ts:100-136`*

**Observation** — The hand-rolled `settled` flag + `clearTimeout` is exactly what `Promise.race(...)` (and `AbortController` for cancellation) is designed to avoid.

**Impact** — Manual timeout handling is more error-prone and harder to follow than `Promise.race`, running counter to the code-style preferences guide's async-style guidance.

**Fix** — `return Promise.race([this.whenIdle(), this.delay(timeoutMs).then(() => false)])` with an internal `idle` promise.

#### `PlatformRuntime.stop()` rethrows non-Error fatals with `new Error(String(...))`, losing context
*Minor · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:262-264`, `packages/sdk/src/runtime/rooms/AgentRuntime.ts:180`, `:197`*

**Observation** — Wrapping non-Error throwables in `new Error(String(...))` discards the original cause. The codebase has `ThenvoiSdkError(message, cause)` which is purpose-built for this.

**Impact** — Original non-Error throwables lose their context, making failures harder to diagnose.

**Fix** — Use `new ThenvoiSdkError("Runtime failed", runtimeError)` to preserve cause.

#### `ContactEventHandler.dedup`/`dedupOrder` is an LRU implemented by hand
*Minor · Effort: M · `packages/sdk/src/runtime/ContactEventHandler.ts:97-98`, `:359-397`*

**Observation** — The same LRU pattern is implemented four times across the codebase:

- **`requestCache`** — Map + LRU eviction in `ContactEventHandler`.
- **`dedup` / `dedupOrder`** — Set + LRU in `ContactEventHandler`.
- **`ExecutionContext.dedupCache`** — line 39-40, 375-383.
- **`MessageRetryTracker`** — fourth implementation of the same pattern.

**Impact** — Maintenance burden — future LRU fixes must be applied four times, and the implementations may drift.

**Fix** — Extract a `BoundedSet<T>` / `BoundedMap<K, V>` utility into `utils/`.

#### `ThenvoiSdkError` constructor uses non-portable `cause` argument
*Minor · Effort: S · `packages/sdk/src/core/errors.ts:3`*

**Observation** — The constructor passes `cause` through `Error`'s options bag — only supported in ES2022+ runtimes. The SDK targets Node so that's fine, but no test or JSDoc documents this.

**Impact** — The ES2022 runtime requirement is undocumented and could surprise consumers targeting older Node versions.

**Fix** — Add a brief JSDoc noting `cause` is propagated via standard `Error(message, { cause })` and requires ES2022.

#### Error classes never override `name` via `Object.defineProperty`, but ESM minifiers can rename `this.name`
*Minor · Effort: S · `packages/sdk/src/core/errors.ts` (all classes)*

**Observation** — Assignment `this.name = "ValidationError"` works but is lost under some TypeScript downlevel targets that don't preserve subclass prototype chain. tsup likely emits ES2022 so this is fine in practice. No `Object.setPrototypeOf(this, new.target.prototype)` is needed in modern targets, but it's worth a comment.

**Impact** — Under certain downlevel targets the `name` assignment may be silently lost, breaking `instanceof` checks for consumers.

**Fix** — None required if target is ES2022+; otherwise add prototype restoration.

#### JSDoc absent across runtime public surface
*Minor · Effort: L · all of `packages/sdk/src/runtime/` and `packages/sdk/src/core/` (errors.ts, logger.ts, isDirectExecution.ts)*

**Observation** — `Agent.ts` has 3 JSDoc blocks. `SimpleAdapter` has 1. Everything else has zero. Public methods on `PlatformRuntime` (`start`, `stop`, `runForever`, `bootstrapRoomMessage`, `resetRoomSession`), `AgentRuntime` (same set), `Execution`, `ExecutionContext` are wholly undocumented. Error classes have no JSDoc explaining when each is thrown.

**Impact** — SDK consumers don't get inline hover docs for runtime types; onboarding cost is higher than necessary, especially for the non-obvious `stop(timeoutMs)` return value semantics.

**Fix** — Add 1-2 line JSDoc to public methods. Especially document the `stop(timeoutMs)` contract — `true = graceful`, `false = forced` — which is not obvious.

#### `PlatformRuntime.executeAdapter` does messy classification inline
*Minor · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:304-308`*

**Observation** — Whether an event is "synthetic" (skip mark-processing) is computed inline by comparing senderType and senderId. This domain check should be a tiny pure helper (`isSyntheticMessage(message)`) named in `types.ts` or `formatters.ts`.

**Impact** — Inline domain logic is harder to test and understand than a named predicate.

**Fix** — Extract `isSyntheticContactMessage(message: PlatformMessageLike): boolean`.

#### Logger discipline: `info` used to announce stale-message recovery; should be `debug`?
*Minor · Effort: S · `packages/sdk/src/runtime/Execution.ts:189-192`*

**Observation** — "Recovering stale processing messages" with count is debug-level detail unless the user cares per-room. With many rooms this floods info logs. Compare to other info logs in the slice — they're rare and lifecycle-level.

**Impact** — At scale with many rooms, this log floods the `info` channel, making it harder to spot actual lifecycle milestones.

**Fix** — Demote to `debug`, or keep `info` only when count > 0 and add a note.

#### `ContactEventHandler` `logFailure` always logs at `error`, even for retryable failures
*Minor · Effort: S · `packages/sdk/src/runtime/ContactEventHandler.ts:421-433`*

**Observation** — "retryable" failures should arguably log at `warn`, not `error`. The current approach inflates `error`-level metrics for transient issues.

**Impact** — Transient failures inflate `error`-level metrics, making it harder to distinguish real failures from expected retries.

**Fix** — Use `error` for non-retryable, `warn` for retryable.

#### `AgentRuntime` never cleans up `executionWatchers` if a watcher promise never settles
*Minor · Effort: M · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:319-342`, `:165-173`*

**Observation** — `executionWatchers` is cleared via `Map.clear()` in `stop()` but the underlying `.catch().finally()` promise chain stays alive on the heap until each `execution.waitUntilStopped()` resolves. If `stop()` doesn't `await` these (it doesn't), and the execution's `stop()` returns before the chain settles (`graceful=false` path returns early without awaiting `processTask`, see Execution.ts:143-145), the watcher could fire later against a destroyed runtime.

**Impact** — Watcher promise chains can fire against a destroyed runtime after `stop()` returns, leading to use-after-free style behavior.

**Fix** — `await Promise.allSettled([...this.executionWatchers.values()])` after stopping executions, before clearing.

#### `ExecutionContext` doesn't expose a way to clear its caches besides letting it be GC'd
*Minor · Effort: M · `packages/sdk/src/runtime/ExecutionContext.ts`*

**Observation** — `AgentRuntime.stop()` clears `contexts.clear()` (line 170) but each `ExecutionContext` may have a pending `hydrateContext()` REST call in flight. There's no AbortSignal threaded through — see Async/Promise issue below.

**Impact** — In-flight REST hydration calls continue running after shutdown, potentially causing post-stop side effects.

**Fix** — Thread an `AbortSignal` from `AgentRuntime` into `ExecutionContext` REST calls.

#### No `AbortController` threaded into REST calls; only WS consume loop is cancellable
*Minor · Effort: M · `packages/sdk/src/runtime/ExecutionContext.ts:282-329`, `packages/sdk/src/runtime/Execution.ts:174-217`*

**Observation** — During shutdown the WS consume loop sees its signal abort, but in-flight REST pagination (up to 100 pages) keeps running until completion. There's no mechanism to interrupt them. With a slow REST endpoint a stop can take minutes.

**Impact** — A slow REST endpoint can cause shutdown to block for minutes, and there is no way to interrupt the in-flight calls.

**Fix** — Plumb an `AbortSignal` from `AgentRuntime.stopController` into the REST facade, and `signal.throwIfAborted()` between pages.

#### `RoomPresence` is exported but appears to be unused parallel implementation of `AgentRuntime`'s room logic
*Minor · Effort: S · `packages/sdk/src/runtime/rooms/RoomPresence.ts`*

**Observation** — Only `tests/room-presence.test.ts` and `tests/parity-contract.test.ts` use it. `AgentRuntime` reimplements all of: connect-on-start, subscribeAgentRooms, hydrateTrackedRooms, consumeEvents, room added/removed/deleted dispatch — yet doesn't use `RoomPresence`. Two parallel implementations of the same logic exist.

**Impact** — Two parallel implementations create a maintenance trap — future changes must be applied twice, and the implementations will inevitably diverge.

**Fix** — Either delete `RoomPresence` (and the tests) if `AgentRuntime` is the successor, or refactor `AgentRuntime` to compose `RoomPresence`. Right now it's a maintenance trap.

### Nits

#### Inconsistent stop signature — `Agent.stop(timeoutMs?: number | null)` vs `PlatformRuntime.stop(timeoutMs?: number)`
*Nit · Effort: S · `packages/sdk/src/agent/Agent.ts:85`, `packages/sdk/src/runtime/PlatformRuntime.ts:222`*

**Observation** — `Agent.stop` accepts `null` (mapped via `?? undefined` at line 99), `PlatformRuntime.stop` does not. Subtle inconsistency.

**Impact** — The signature inconsistency is a minor footgun for anyone calling both layers directly.

**Fix** — Pick one and stick to it (probably `number | undefined`).

#### `ConsoleLogger.error` writes to stderr; other levels go through `console`
*Nit · Effort: S · `packages/sdk/src/core/logger.ts:33-36` vs `:38-50`*

**Observation** — Asymmetric — debug/info/warn go through `console.*` (which writes structured args), error writes a serialized string to `process.stderr` directly. The error path can't be customised by a `console.error` override in tests.

**Impact** — The asymmetry makes it impossible to intercept error logs via `console.error` overrides in tests.

**Fix** — Use `this.emit("error", ...)` for consistency, or document why error goes direct to stderr.

#### `RuntimeStateError` doesn't accept a `cause`
*Nit · Effort: S · `packages/sdk/src/core/errors.ts:29`*

**Observation** — Sibling classes (`ValidationError`, `TransportError`, `ThenvoiSdkError`) all accept a `cause`. `UnsupportedFeatureError` and `RuntimeStateError` don't.

**Impact** — Missing `cause` on two error classes creates an inconsistent API and forces callers to lose error context when wrapping.

**Fix** — Accept `cause` on all error classes for symmetry.

#### `core/index.ts` re-exports protocol types from `../contracts/protocols` even though `core/` doesn't define them
*Nit · Effort: S · `packages/sdk/src/core/index.ts:2-17`*

**Observation** — This blurs the boundary between `core/` and `contracts/`. Consumers should import protocol types from `contracts/` directly.

**Impact** — The `core/` barrel becomes a catch-all, blurring the boundary between modules and making ownership unclear.

**Fix** — Only re-export what `core/` actually owns.

#### `Agent.shutdownTimeoutMs = 30_000` magic number
*Nit · Effort: S · `packages/sdk/src/agent/Agent.ts:28`, `:59`, `packages/sdk/src/runtime/shutdown.ts:1`*

**Observation** — `30_000` is duplicated across `Agent.ts` (twice) and `runtime/shutdown.ts`.

**Impact** — The magic number must be updated in three places when the default timeout changes.

**Fix** — Pull into a single `DEFAULT_SHUTDOWN_TIMEOUT_MS` constant exported from `runtime/shutdown.ts` and consumed by `Agent`.

#### `SimpleAdapter.onStarted` uses field assignment for state shared with the lifecycle
*Nit · Effort: S · `packages/sdk/src/core/simpleAdapter.ts:23-25`, `:44-47`*

**Observation** — `agentName`/`agentDescription` are `protected` strings written by `onStarted` and never reset. If the adapter is reused across two runs (e.g. via `Agent.create` after `Agent.stop`), the previous values leak. They probably can't be (each Agent owns one adapter), but the lifecycle isn't documented.

**Impact** — Undocumented lifecycle assumptions around `agentName`/`agentDescription` could cause stale values to leak if the adapter is ever reused.

**Fix** — Either freeze adapter to one run, or expose a reset hook.

#### `bootstrapRoomMessage` adds room to `subscribedRooms` but never goes through `trackRoomJoin`
*Nit · Effort: S · `packages/sdk/src/runtime/rooms/AgentRuntime.ts:284-288`*

**Observation** — `bootstrapRoomMessage` directly calls `link.subscribeRoom` + `subscribedRooms.add` instead of going through `trackRoomJoin`. This bypasses `roomFilter` and `onRoomJoined` callbacks. Either intentional (caller already vetted the room) or a bug.

**Impact** — Bypassing `trackRoomJoin` silently skips `roomFilter` and `onRoomJoined` callbacks, which may be either intentional or a bug.

**Fix** — Document the bypass or route through `trackRoomJoin`.

#### Public field names mix underscored and non-underscored prefixes
*Nit · Effort: S · `packages/sdk/src/runtime/PlatformRuntime.ts:39-66`*

**Observation** — `_agentId`, `_apiKey`, `_wsUrl`, `_restUrl`, `_agentName`, `_agentDescription`, `_onParticipantAdded`, `_onParticipantRemoved`, `_roomFilter`, `_contextFactory` use `_` prefix, but `linkInstance`, `initPromise`, `runtime`, `contactHandler`, `activeAdapter`, `stopping`, `preprocessor`, `logger`, `sessionConfig`, `contactConfig`, `agentConfig`, `linkOptions`, `configuredIdentity`, `contactsSubscribed` do not. No clear pattern.

**Impact** — Inconsistent naming makes it hard to determine at a glance whether a field is private; the `_` prefix is also redundant with TypeScript's `private` keyword.

**Fix** — Pick one convention. TypeScript `private` already prevents external access; the `_` prefix is redundant.

## Strengths worth keeping

- **Error hierarchy is small and used consistently** — `ThenvoiSdkError` base with
  `ValidationError`, `TransportError`, `UnsupportedFeatureError`, `RuntimeStateError`. Throughout
  `core/`, `agent/`, `runtime/`, every public-API throw uses one of these (3 raw `new Error` are
  all in `assertNever` exhaustive-check helpers, which is appropriate).
- **Logger is properly injected** ("Design Principles") — every class that needs a logger takes it
  via constructor options with `?? new NoopLogger()`. No singleton import of a default logger.
  Sensitive-key redaction in `ConsoleLogger` is a nice touch.
- **Phoenix channel setup/teardown is centralized** in `PhoenixChannelsTransport` — channel
  references and event-handler refs are tracked together (`channels` + `channelRefs`), and `leave`
  removes both handler refs and the channel. The `pendingJoins` map prevents duplicate joins.
  Failed joins clean up listeners before throwing (lines 165-171).
- **Reconnect backoff is configurable** with sensible default (1s/2s/5s/10s/30s).
- **`runtime/rooms/subscriptions.ts` extracts pure utilities** (`trackRoomJoin`, `trackRoomLeave`,
  `hydrateTrackedRooms`) — these follow "Manager vs Utility Separation" well: stateless,
  dependencies passed as parameters.
- **`AgentRuntime.consumeLoop` uses `AbortSignal`** for cancellation (the primary cancellation
  path).
- **Discriminated unions are used for `PlatformEvent`** (`platform/events.ts`) with full exhaustive
  switching via `assertNever` in `AgentRuntime.handleEvent` and `ContactEventHandler.formatEventMessage`.
- **`MessageRetryTracker` is a clean small utility** with bounded memory.
- **Type safety is high** — only two `as unknown as` casts in the entire core+agent+runtime+adapter
  tools slice (both in `runtime/tools/`, not in the slice under review). No `any`, no `@ts-ignore`.
  ESLint config enforces `no-explicit-any: error` in `src/`.
- **`runtime/shutdown.ts` `GracefulShutdown`** correctly handles SIGINT/SIGTERM/SIGHUP and double-
  signal force-exit. `withSignals` ensures `unregisterSignals` runs in `finally`.
- **`PhoenixChannelsTransport` join is idempotent** (line 119: early return if already joined) and
  in-flight joins are deduplicated via `pendingJoins` map.
- **Stale-message recovery** (`Execution.recoverStaleProcessingMessages`) is a thoughtful
  reliability feature.
- **Capability gating** with `assertCapability(this.capabilities, "contacts", ...)` in
  `ThenvoiLink.subscribeAgentContacts` — adapter clearly throws `UnsupportedFeatureError` when a
  capability isn't present.

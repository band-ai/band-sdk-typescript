# PLAN-INT-876: openclaw backlog drain + history rehydration on (re)connect

## Summary

openclaw's Band transport (`packages/openclaw/src/transport.ts`) drives a bare `RoomPresence`,
which only streams live WebSocket events going forward. Messages sent while a Band account
is disconnected are silently dropped on reconnect. The SDK already solves this in
`runtime/rooms/AgentRuntime.ts` (which wraps one `Execution` per room), so the fix is to swap
`RoomPresence` for `AgentRuntime` in `createBandGateway`, not to reinvent backlog/dedup logic.

## Design

### Why `AgentRuntime`, not a hand-rolled drain pass

The issue offers two options: switch to `Execution`, or bolt a `getNextMessage()` drain pass
onto `RoomPresence` with manual dedup. Investigation of the SDK shows the second option would
duplicate ~150 lines of already-tested logic:

- `Execution.processLoop()` (`packages/sdk/src/runtime/Execution.ts:154`) already runs, per
  room, in order: `recoverStaleProcessingMessages()` → `synchronizeWithNext()` → live queue
  drain. Dedup against the live WebSocket stream is handled via `firstWsMessageId` /
  `drainedWsMessageIds` / `syncProcessedIds` (`Execution.ts:57,74-76,164-168,212-258`) — the
  first WS message observed while `!syncComplete` becomes the "sync point"; the REST backlog
  (`link.getNextMessage(roomId)`) is drained until that same message ID is reached, then the
  duplicate WS-side delivery of that message is swallowed once.
- `AgentRuntime` (`packages/sdk/src/runtime/rooms/AgentRuntime.ts`) is the thing that creates
  an `Execution` per room (`getOrCreateExecution`, line 311) at the right time — on
  `room_added` (live join) and on `subscribeExistingRooms()` at startup (line 375, gated by
  `agentConfig.autoSubscribeExistingRooms`), which internally calls the same
  `hydrateTrackedRooms` (`rooms/subscriptions.ts`) that `RoomPresence` uses today. So swapping
  the presence class for the runtime class preserves openclaw's current room-hydration
  behavior and *adds* backlog drain / stale-processing recovery / bootstrap for free, because
  each room's `Execution` runs its `processLoop()` as soon as it's constructed.
- This is already covered by `packages/sdk/tests/execution.test.ts` (crash recovery, dedup,
  retry-exceeded-marks-failed, sync failures don't crash the loop) — openclaw doesn't need to
  re-test that machinery, only that it's wired up correctly.

Both `link.getNextMessage` and `link.getStaleProcessingMessages` degrade gracefully (return
`null` / `[]`) when the REST client doesn't implement `getNextMessage`/`listMessages`
(`ThenvoiLink.ts:442-473`), so this is safe to enable unconditionally — no capability flag
needed, and it's a no-op against a backend that doesn't yet support the backlog endpoints.

### Data flow after the change

1. `createBandGateway.startAccount` connects the link, then constructs an `AgentRuntime`
   instead of a `RoomPresence`, with `agentConfig: { autoSubscribeExistingRooms: true }` to
   preserve today's "hydrate all existing rooms on connect" behavior.
2. `AgentRuntime.start()`:
   - subscribes `agent_rooms` (unchanged),
   - hydrates existing rooms via `hydrateTrackedRooms` and, for each, calls
     `getOrCreateExecution(roomId)` — this immediately kicks off that room's
     `recoverStaleProcessingMessages()` + `synchronizeWithNext()` (backlog drain) *before* any
     live event is processed for that room,
   - starts the WS consume loop (`consumeLoop`), which for `message_created` events calls
     `getOrCreateExecution(roomId).enqueue(event)` — same room, same `Execution`, so dedup
     against the just-drained backlog is automatic.
3. Each dispatched message (backlog or live) reaches openclaw via one `onExecute` callback
   (`(context: ExecutionContext, event: PlatformEvent) => Promise<void>`), which now contains
   the logic that used to live in `presence.onRoomEvent`: build `MsgContext` via
   `platformEventToInboundContext` (unchanged, still pure/tested), call `dispatch`, then
   `link.markProcessed(...)` best-effort. This is a straight move, not a rewrite.
4. `onRoomJoined` (room type caching) and `onContactEvent` (contact handler) wiring carry over
   unchanged — `AgentRuntime` exposes the same two hook shapes as `RoomPresence`.

### Trade-offs

- `AgentRuntime` keeps one `ExecutionContext` per room (participant list, dedup cache, retry
  tracker) that `RoomPresence` didn't have. openclaw doesn't need the LLM-context-hydration
  half of `ExecutionContext` (`getHydratedHistory`/`hydrateContext`) — it only rides on
  `Execution` for backlog/dedup/retry. We leave those knobs at their SDK defaults; not
  exercising them costs nothing (they're lazy — `hydrateContext()` is only called if
  something calls `getHydratedHistory`/`hydrateContext`, which openclaw's `onExecute` won't).
- Participant fetching: today `onRoomEvent` does a REST `listChatParticipants` call per
  message to build the mention roster. `ExecutionContext.addParticipant`/`removeParticipant`
  are populated by `AgentRuntime` from `participant_added`/`participant_removed` events, which
  *could* replace that per-message REST call — but that's a separate optimization outside this
  issue's scope. Keep the existing per-message REST fetch as-is to minimize the diff. **Scoping
  note (architect review):** this isn't a free follow-up — `ExecutionContext` only tracks
  participants from `participant_added`/`participant_removed` events seen *while connected*
  (`AgentRuntime.ts:250-268`); it has no initial roster hydration. A future switch would need
  to add that. Flagging as debt, not folding in now.

### Two semantic changes this swap is NOT a "straight move" of (architect review — HIGH, block sign-off)

The Implementation details section below originally described moving `onRoomEvent`'s body
into `onExecute` unchanged. Two real behavioral differences between `RoomPresence` and
`AgentRuntime`/`Execution` make that unsafe as written; both must be designed for explicitly:

- **HIGH-1 — `onExecute` must be TOTAL (never throw); today's handler is allowed to.**
  `Execution.executeEvent` (`Execution.ts:291-316`) **rethrows** any error `onExecute` throws,
  which propagates to `AgentRuntime`'s execution watcher → `failRuntime` (`AgentRuntime.ts:322,
  410`), which sets `fatalError` and **aborts the whole account's `consumeLoop`** — every room
  on that account stops processing live WebSocket events. This is also **asymmetric**:
  `executeSyncMessage` (backlog path, `Execution.ts:260-289`) *swallows* the same throw and
  keeps going, so a poison message only kills the connection if it arrives live, not from
  backlog. openclaw would never even observe this today — `runLifecycle` only awaits
  `ctx.abortSignal`, not runtime death — so the account would silently go dark.
  **Fix:** wrap the *entire* `onExecute` body — not just the `dispatch`/`markProcessed` calls,
  but also `platformEventToInboundContext`, `replaceUuidMentions`/`buildParticipantsBlock`,
  `trackLastSender`, and the `getRoomType` lookup — in one `try/catch` so `onExecute` itself
  never throws (log on catch). Additionally wire `onError` on the `AgentRuntime` constructor
  options (constructor-only, `AgentRuntimeOptions.onError`) to `log(...)` so a fatal runtime
  error is at least observable instead of the account just going quiet.
- **HIGH-2 — `runtime.stop()` needs a finite timeout; the original plan had this backwards.**
  The trade-offs section originally argued for calling `stop()` with no timeout "for parity"
  with `RoomPresence.stop()`. That's wrong: `RoomPresence.stop()` just aborts its consume loop
  and awaits it — it never waits on in-flight handlers. `AgentRuntime.stop(undefined)` calls
  `execution.stop(undefined)` per room, which calls `waitForIdle(undefined)`
  (`Execution.ts:138-148`) and **blocks until `inFlight === 0`** — and `inFlight` only drops
  to 0 after `onExecute` (which awaits `dispatch`, which awaits the model) resolves. An
  in-flight model call at teardown time means `runtime.stop()` can hang indefinitely, and
  `teardown()` runs on both abort *and* disconnect-before-restart, so a hung dispatch blocks
  shutdown/restart entirely. **Fix:** pass a finite `timeoutMs` to `runtime.stop(timeoutMs)`
  (a few seconds, matching the scale of other best-effort operations in this file) instead of
  calling it with no argument.
- **MEDIUM — new at-least-once redelivery is a real, new failure mode.** Backlog drain relies
  on the server-side cursor advancing via `markProcessed`. openclaw already calls that
  best-effort and silently swallows failures (`transport.ts` `catch { /* best effort */ }`).
  Today that's harmless (nothing re-reads unprocessed messages). After this change, a
  persistently-failing `markProcessed` means every reconnect re-drains the full backlog and
  re-dispatches those messages to the model — duplicate runs. At-least-once is an acceptable
  trade-off, but the failure must not be silent: log when `markProcessed` fails so a stuck
  cursor is observable, rather than swallowing it outright.

## Implementation details

Files touched: only `packages/openclaw/src/transport.ts` and its test,
`packages/openclaw/tests/unit/transport.test.ts`. No SDK changes needed — `AgentRuntime` and
`ContactEventHandler` are already exported from `@thenvoi/sdk/runtime` (same subpath
`RoomPresence` is imported from today, `transport.ts:19`).

1. **Imports** (`transport.ts:19`): replace
   `import { RoomPresence, ContactEventHandler } from "@thenvoi/sdk/runtime";`
   with
   `import { AgentRuntime, ContactEventHandler } from "@thenvoi/sdk/runtime";`
   Also import `ExecutionContext` type and `PlatformEvent` (already imported) as needed for
   the `onExecute` signature.

2. **`PresenceLike` interface** (`transport.ts:141-148`): rename/replace with a `RuntimeLike`
   interface — **architect correction: just `{start, stop}`**, nothing else. `onRoomJoined`/
   `onContactEvent` become constructor-only inputs on `AgentRuntime` (see step 3) and are never
   read off the returned instance, so they don't belong on this interface at all:
   ```ts
   interface RuntimeLike {
     start: () => Promise<unknown>;
     stop: (timeoutMs?: number) => Promise<unknown>;
   }
   ```

3. **`createPresence` → `createRuntime`** (`transport.ts:233-235`, `BandGatewayDeps.createPresence`
   at line 160): rename the deps hook to `createRuntime`, and change its signature to accept
   the constructor options up front (since `AgentRuntime`'s callbacks are constructor-only,
   unlike `RoomPresence`'s mutable `on*` props):
   ```ts
   createRuntime?: (
     link: LinkLike,
     opts: {
       agentId: string;
       onExecute: (context: unknown, event: PlatformEvent) => Promise<void>;
       onRoomJoined?: (roomId: string, payload: Record<string, unknown>) => unknown;
       onContactEvent?: (event: ContactEvent) => Promise<void>;
       onError?: (error: unknown, event: PlatformEvent) => void;
     },
   ) => RuntimeLike;
   ```
   Default (note the added `onError`, wired per HIGH-1 above):
   ```ts
   const createRuntime = deps.createRuntime ?? ((link, opts) =>
     new AgentRuntime({
       link: link as never,
       agentId: opts.agentId,
       onExecute: opts.onExecute as never,
       onRoomJoined: opts.onRoomJoined,
       onContactEvent: opts.onContactEvent,
       onError: opts.onError,
       agentConfig: { autoSubscribeExistingRooms: true },
     }) as unknown as RuntimeLike);
   ```

4. **`startAccount`** (`transport.ts:260-371`): restructure so `onExecute` (previously the body
   of `presence.onRoomEvent`) is built *before* constructing the runtime, since it's now a
   constructor argument instead of an assignable property:
   - Move the `onRoomEvent` closure body (lines 293-344) into a local
     `async function onExecute(context: unknown, event: PlatformEvent)`, **wrapped in a single
     top-level `try/catch` covering the WHOLE body — roomId extraction, the participant fetch,
     `platformEventToInboundContext`, `trackLastSender`, `dispatch`, AND `markProcessed`** (per
     HIGH-1: `onExecute` must never throw, since `Execution.executeEvent` rethrows and that
     kills the whole account's live-event loop; today's `RoomPresence.onRoomEvent` throwing is
     already bad, but this makes the failure mode explicit and testable). On catch, `log(...)`
     and return — never rethrow.
   - Build a top-level `onError: (error, event) => log(...)` closure and pass it into
     `createRuntime(...)` too, so a `fatalError` inside `AgentRuntime` (which aborts that
     account's `consumeLoop`) is at least observable instead of the account silently going
     dark.
   - Build `onRoomJoined` and `onContactEvent` closures the same way (currently assigned as
     `presence.onRoomJoined = ...` / `presence.onContactEvent = ...`, lines 288-291, 346-352) —
     keep their bodies identical, just pass them into `createRuntime(...)` instead of
     assigning post-construction.
   - Replace `const presence = createPresence(link);` + the three `presence.on* = ...`
     assignments with a single `const runtime = createRuntime(link, { agentId: selfAgentId, onExecute, onRoomJoined, onContactEvent, onError });`.
   - `setAccount(...)`: rename the stored `presence` field to `runtime` (check
     `state.ts`'s `Account` type for the field name and update it there too — grep confirms
     `presence` is the only place-name; rename consistently across `transport.ts` + `state.ts`).
   - `await presence.start()` → `await runtime.start()`.
   - **Best-effort `markProcessed` (inside `onExecute`, per MEDIUM above): log on failure
     instead of silently swallowing** — change the existing `catch { /* best effort */ }`
     around `link.markProcessed(...)` to `catch (err) { log(...) }`, so a persistently
     stuck server-side cursor (which would otherwise cause silent duplicate backlog
     redelivery on every reconnect) is observable.

5. **`teardown`** (`transport.ts:245-258`): rename `presence` local var to `runtime`,
   **`presence.stop()` → `runtime.stop(STOP_TIMEOUT_MS)` (a finite timeout, e.g. `5_000` —
   architect correction, HIGH-2 above: `AgentRuntime.stop()` with no timeout blocks on
   `inFlight === 0` per room, i.e. on an in-flight `dispatch()` awaiting the model, so an
   unbounded stop can hang teardown indefinitely; `RoomPresence.stop()` never had this
   problem since it doesn't wait on in-flight handlers at all).** Behavior otherwise
   `link.disconnect()`).

6. **`BandGatewayDeps`** (`transport.ts:158-165`): rename `createPresence` → `createRuntime`
   (breaking rename is fine — it's an internal test-injection seam, not public API; grep
   openclaw's other source files and `openclaw.plugin.json` to confirm nothing else references
   `createPresence` by name before renaming).

7. **`LinkLike`** (`transport.ts:127-139`): no change — `AgentRuntime` uses the same
   `link.connect/disconnect/rest/markProcessed` surface, plus `link.subscribeAgentRooms`,
   `link.nextEvent`, `link.getNextMessage`, `link.getStaleProcessingMessages`,
   `link.subscribeRoom`/`unsubscribeRoom`, `link.listAllChats` internally — but those are all
   called by the *real* `AgentRuntime`/`Execution` against the *real* `ThenvoiLink`, never by
   openclaw's own code, so `LinkLike` (the structural type openclaw's own code touches) doesn't
   need new members. Only the **test fakes** (`makeLink()` in `transport.test.ts`) need no
   change either, since tests inject a fake `createRuntime` (see Testing plan) rather than
   exercising the real `AgentRuntime`/`Execution` internals.

8. **Edge cases**:
   - Account has zero rooms at connect time → `hydrateTrackedRooms` iterates zero rooms,
     `AgentRuntime.start()` still succeeds (matches today).
   - REST backend doesn't implement `getNextMessage`/`listMessages` → graceful no-op backlog
     drain (verified in SDK, `ThenvoiLink.ts:442-473`); openclaw behaves exactly as it does
     today (live-only).
   - A room's backlog drain throws (network error) → `Execution.recoverStaleProcessingMessages`
     already catches and logs, continues to `synchronizeWithNext` (also loop-scoped, not
     fatal) — no new error handling needed in openclaw.
   - Reconnect while messages are still `processing` from a crash mid-handling → covered by
     `recoverStaleProcessingMessages`, already exercised by SDK's `execution.test.ts`.
   - **Known limitation (architect review, LOW):** `getOrCreateExecution` (which starts a
     room's `processLoop` → backlog drain → `onExecute`) is invoked *before*
     `onRoomJoined` caches that room's type (`AgentRuntime.ts:385-386` calls
     `getOrCreateExecution` then `onRoomJoined` in the same callback, but the drain itself
     runs asynchronously). In practice the race is almost always won by the room-type cache
     write (the drain waits on a network round-trip first), but it isn't guaranteed — an
     early backlog message could hit `getRoomType() === undefined` and default `ChatType` to
     `'group'`. Not fixing this now; documenting as a known, low-probability limitation.

## Testing plan (TDD)

This is a **feature** (backlog/rehydration wiring), not a bug fix in the sense of "existing
behavior is wrong" — messages are *never* processed today, so there's no reproduction test to
write against current code; instead we test-first each new behavior in
`packages/openclaw/tests/unit/transport.test.ts`, reusing the existing `vitest` +
dependency-injection style (`createBandGateway(deps)` with fake `link`/`createRuntime`/`dispatch`).

For each behavior below: write the failing test against the *current* `transport.ts` first
(it will fail to compile/fail assertions because `createPresence`/`presence` don't exist yet
post-rename, or because runtime wiring doesn't call `onExecute` the same way), then make the
implementation change, then get it green.

1. **Runtime construction replaces presence construction**
   - Test: `createBandGateway` with a fake `createRuntime` records that it was called with
     `{ agentId: "agent-self", onExecute, onRoomJoined, onContactEvent }` (assert the shape of
     the passed opts object, not internals) instead of asserting on `presence.onRoomEvent`
     being assigned post-construction.
   - Replaces the current `makePresence()` helper's `onRoomEvent`/`onRoomJoined`/`onContactEvent`
     mutable-prop pattern with a fake `createRuntime: (link, opts) => runtime` that captures
     `opts` for later invocation — update `makePresence()` → `makeRuntime()` accordingly.

2. **`onExecute` dispatch-routing (renamed from "dispatch-routing" tests, same assertions)**
   - Existing tests `"dispatch-routing: a text message is mapped and routed to dispatch;
     markProcessed best-effort"` and `"...self-authored + non-text are skipped"` and
     `"markProcessed best-effort: a failing markProcessed does not throw"` (lines 320-372) get
     rewritten to invoke the captured `opts.onExecute(context, event)` instead of
     `presence.onRoomEvent(roomId, event)`. Assertions unchanged (dispatch called once with
     right roomId/ctx.To, markProcessed called with the right args, best-effort swallow).

3. **`start`/`stop` lifecycle (renamed from "starts an account..." etc, lines 258-319)**
   - Same assertions (`link.connect` called once, account registered with resolved owner,
     `runtime.start()` called once, `runtime.stop()` + `link.disconnect()` called once on
     abort) but against `runtime` instead of `presence`.

4. **New: existing-room hydration is enabled** (this is the actual bug-fix behavior — currently
   untested because `RoomPresence` was constructed with `autoSubscribeExistingRooms: true`
   directly; after the rewrite this becomes an `agentConfig` passed into `AgentRuntime`).
   **Resolved per architect review — do NOT `vi.mock("@thenvoi/sdk/runtime", ...)`** (no
   precedent in the suite — it's DI-only throughout; it's a built ESM dist module; and
   `ContactEventHandler` would need mocking too). Two tests instead:
   - **4a — flag assertion (a proxy, cheap):** extract a small pure exported helper,
     `buildRuntimeOptions(link, opts)`, that returns the plain object passed to `new
     AgentRuntime(...)` (the object literal from step 3's default factory, unit-testable on
     its own — mirrors how `platformEventToInboundContext`/`createReplyDeliver` are already
     pulled out as pure, directly-testable functions). Unit test asserts
     `agentConfig.autoSubscribeExistingRooms === true` and that `onExecute`/`onRoomJoined`/
     `onContactEvent`/`onError` are wired through unchanged.
   - **4b — integration test (the one that actually proves INT-876 is fixed):** one test that
     exercises the **real** `AgentRuntime` + `Execution` (not injected fakes) against a fake
     `link` whose `getStaleProcessingMessages`/`getNextMessage` are seeded to return a single
     backlog message and whose `nextEvent` is controllable (e.g. resolves after a signal, or
     via a small manual queue) — assert `onExecute`/`dispatch` fires for that backlog message
     with no live WebSocket event ever delivered. The flag assertion in 4a only proves intent;
     this test proves behavior.

5. **New (HIGH-1): `onExecute` never throws, even when ctx-building fails.** Test that an
   `onExecute` whose `platformEventToInboundContext` (or `listChatParticipants`, or any other
   step inside the wrapped body) throws does **not** propagate — assert the call resolves
   without rejecting, `dispatch` was not called, and (if exercising the real `AgentRuntime`)
   the runtime's `consumeLoop`/`fatalError` state is untouched (i.e. a subsequent good event on
   the same or another room still dispatches normally). Also assert the `onError` callback
   passed into `createRuntime(...)` gets invoked if a hard failure ever does reach it.

6. **New (HIGH-2): `stop()` is called with a finite timeout.** Lifecycle test asserting
   `runtime.stop` (the fake's `stop` method) is called with a defined numeric `timeoutMs`
   (not `undefined`) from `teardown()` — both on the abort path and the
   disconnect-before-restart path.

7. **New (MEDIUM): `markProcessed` failure is logged, not silently swallowed.** Extends the
   existing "markProcessed best-effort: a failing markProcessed does not throw" test to also
   assert `log` was called with a message identifying the failure (in addition to the existing
   assertion that the call still resolves without throwing).

8. **`onExecute` dispatch-routing (renamed from "dispatch-routing" tests, same assertions)**
   - Existing tests `"dispatch-routing: a text message is mapped and routed to dispatch;
     markProcessed best-effort"` and `"...self-authored + non-text are skipped"` and
     `"markProcessed best-effort: a failing markProcessed does not throw"` (lines 320-372) get
     rewritten to invoke the captured `opts.onExecute(context, event)` instead of
     `presence.onRoomEvent(roomId, event)`. Assertions unchanged (dispatch called once with
     right roomId/ctx.To, markProcessed called with the right args, best-effort swallow).

9. **`start`/`stop` lifecycle (renamed from "starts an account..." etc, lines 258-319)**
   - Same assertions (`link.connect` called once, account registered with resolved owner,
     `runtime.start()` called once, `runtime.stop(timeoutMs)` + `link.disconnect()` called once
     on abort) but against `runtime` instead of `presence`.

10. **Runtime construction replaces presence construction**
    - Test: `createBandGateway` with a fake `createRuntime` records that it was called with
      `{ agentId: "agent-self", onExecute, onRoomJoined, onContactEvent, onError }` (assert the
      shape of the passed opts object, not internals) instead of asserting on
      `presence.onRoomEvent` being assigned post-construction.
    - Replaces the current `makePresence()` helper's `onRoomEvent`/`onRoomJoined`/`onContactEvent`
      mutable-prop pattern with a fake `createRuntime: (link, opts) => runtime` that captures
      `opts` for later invocation — update `makePresence()` → `makeRuntime()` accordingly.

11. **`state.ts`**: if `setAccount`'s `Account` shape's `presence` field is renamed to `runtime`,
    add/update whatever `state.test.ts` (check for its existence) asserts on that field name.

12. **Full regression**: run `pnpm --filter @band-ai/openclaw-channel-band test` (which runs
    `pnpm --filter @thenvoi/sdk build && vitest run`) to confirm the SDK build picks up no
    breaking type changes and the full openclaw suite (transport + outbound + mentions + state)
    stays green.

No new SDK-level tests are needed for backlog/dedup/retry itself — `packages/sdk/tests/
execution.test.ts` already covers that for `Execution`. Tests 5/6/7 above are new
openclaw-side coverage for behavior differences the architect review surfaced (HIGH-1/HIGH-2/
MEDIUM) that are specific to how openclaw *wires into* `Execution`, not to `Execution` itself.

## Open questions / risks

1. **Field rename `presence` → `runtime` in `state.ts`**: confirmed — `state.ts:22` has
   `presence?: unknown;` on `AccountStateInput`/`AccountState`. Rename to `runtime?: unknown;`
   and update the one read site in `transport.ts`'s `teardown()` (`account.presence`).
2. **Resolved (architect review):** do not mock `@thenvoi/sdk/runtime`; use the
   `buildRuntimeOptions` flag-assertion test plus one real-`AgentRuntime` integration test
   (testing plan items 4a/4b above).
3. **Resolved (architect review):** keep the per-message `listChatParticipants` REST call as
   today; defer switching to `ExecutionContext`'s participant tracking as follow-up debt — it
   isn't a free swap, since `ExecutionContext` only accumulates participants from
   `participant_added`/`participant_removed` events seen while connected and has no initial
   roster hydration, so a real switch needs that added first.

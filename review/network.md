[← Back to top-level review](../review.md)

# Network Layer Review

Scope: `packages/sdk/src/client/`, `packages/sdk/src/rest/`, `packages/sdk/src/platform/`, `packages/sdk/src/phoenix.d.ts`.

## Summary

The network layer is split into three concerns — a REST facade/adapter over `@band-ai/rest-client`, a Phoenix Channels websocket transport, and a thin `BandLink` that joins them and exposes an `AsyncIterable` of platform events. Most of the code is reasonable. The hand-rolled `FernBandClientLike` abstraction is not verified against the package it claims to describe and carries nine namespaces that package does not have, and the Phoenix transport leans on unsafe casts because its ambient declaration is too narrow.

**What's good:**

- Centralized channel cleanup in `PhoenixChannelsTransport.leave` removes every event ref subscription before leaving and deletes from both maps.
- `pendingJoins` map dedupes concurrent `join(topic)` calls, preventing duplicate channels and handlers.
- `ConsoleLogger` redacts `api_key`/`token`/`authorization`/`secret`/`cookie`/`password` from logged context, and credentials never go through `console`.
- Rate-limit retry uses bounded exponential backoff with jitter.
- Zod payload validation at the event boundary drops invalid socket payloads with a log rather than throwing into the consumer iterator.
- `StreamingTransport` interface abstracts the websocket and lets tests inject a fake.
- `AbortSignal` is plumbed through `runForever`/`nextEvent` on the WS side with proper listener cleanup.
- Terminal disconnects are first-class: `disconnectReason.ts` gives a typed `WebSocketDisconnectError` with a parsed reason, `connect()` refuses to reconnect after one (`PhoenixChannelsTransport.ts:122-124`), and pending `runForever` waiters are rejected rather than left hanging (`:399-402`). `#80` also added 74 new tests in `tests/phoenix-upgrade-errors.test.ts` and grew `tests/phoenix-channels-transport.test.ts` by ~500 lines, so this layer is now the best-covered part of the SDK.

**What's not** (each linked to its full finding):

- The hand-rolled REST client interface isn't checked against the real package, and carries nine dead legacy branches — see [`FernBandClientLike` declares nine namespaces the REST client does not have](#fernbandclientlike-declares-nine-namespaces-the-rest-client-does-not-have).
- No cancellation on REST: [`RestRequestOptions` drops `abortSignal`](#restrequestoptions-drops-abortsignal-from-the-underlying-client) and the [retry sleep ignores cancellation](#settimeout-based-sleep-ignores-cancellation).
- Phoenix ambient is too narrow, forcing [unsafe casts into Socket internals](#unsafe-casts-reach-into-phoenix-socket-internals) and [misdeclared callbacks](#phoenixdts-ambient-narrows-behaviour-the-sdk-depends-on).
- Dead state with no error escape hatch: [`onHandlerError` declared but never wired](#onhandlererror-is-declared-but-never-wired-up).
- REST errors aren't normalized — see [REST errors are not normalized to typed SDK errors](#rest-errors-are-not-normalized-to-typed-sdk-errors).
- Close-path probes private Phoenix state instead of the SDK's own map, on three call paths — see [Connection retention on close depends on probing private socket state](#connection-retention-on-close-depends-on-probing-private-socket-state).
- The connect handshake hand-rolls its deferred, spreading one invariant across four methods — see [Connect handshake hand-rolls its deferred](#connect-handshake-hand-rolls-its-deferred-instead-of-using-promiserace).

## Findings

### Blockers

*None.*

### Major

#### `FernBandClientLike` declares nine namespaces the REST client does not have
*Major · Effort: M · `packages/sdk/src/client/rest/types.ts:233`, `packages/sdk/src/client/rest/FernRestAdapter.ts:411-934`, `packages/sdk/src/platform/BandLink.ts:125`*

**Observation** — `FernBandClientLike` (`client/rest/types.ts:233`) is a hand-rolled interface describing the shape of `@band-ai/rest-client` so the SDK can wrap it. It declares 19 namespaces; 10 exist on the installed client (`0.0.118`, verified against `node_modules/@band-ai/rest-client/dist/cjs/Client.d.ts`) and **9 do not**: `myProfile`, `myChatMessages`, `chatRooms`, `chatMessages`, `chatParticipants`, `chatContext`, `agentPeers`, `agentContacts`, `agentMemories`. Those 9 are the legacy names, and in `FernRestAdapter` they are consistently probed **first**, with the working `agentApi*` call as the `??` fallback — e.g. `this.client.chatMessages?.createChatMessage ?? this.client.agentApiMessages?.createAgentChatMessage` (`:446-448`), and the same shape at `:598`, `:613`, `:629`, `:648`, `:662`, `:682`, `:702`, `:725`, `:742`, `:807`, `:820`, `:837`. Every one of those first branches is now statically dead: it evaluates to `undefined` on every call, on every request, forever.

The double-cast at `platform/BandLink.ts:125` (`new BandClient(...) as unknown as FernBandClientLike`) is still what lets this compile. It was hiding a correctness bug before; now it hides dead code — and it will hide the next round of drift just as effectively.

**Impact** — No functional breakage today, but every REST call pays an extra property lookup down a branch that can never be taken, and the hand-rolled interface is still not verified against the package it claims to describe. The next upstream namespace rename will again be invisible to the compiler.

**Fix** —

- **Stop hand-writing `FernBandClientLike`** — replace it in `client/rest/types.ts:233` with a type derived from the real client (e.g. `type BandRestClient = InstanceType<typeof BandClient>`) and use that wherever `FernBandClientLike` is referenced today, so the compiler enforces alignment with whatever `@band-ai/rest-client` actually exposes. With `0.0.118` this is now a realistic change — the namespaces line up.
- **Delete the nine dead legacy branches in `FernRestAdapter.ts`** — drop the `this.client.<legacy>?.… ??` prefix from each of the 13 fallback chains listed above and call the `agentApi*` method directly. If any legacy name is deliberately retained for an older deployed client, say so in a comment naming the minimum version, rather than leaving it as an unexplained first branch.
- **Remove the cast at `platform/BandLink.ts:125`** (`as unknown as FernBandClientLike`) — with the above done it is no longer needed and keeping it would re-hide future drift.
- ~~**Add a contract test**~~ — **already done, and it is the reason this finding is now down to dead-code cleanup.** `#150` added `tests/band-client-conformance.test.ts` (77 lines), which instantiates a real `BandClient` and asserts that all ten `agentApi*` namespaces and their 25 methods exist, with an explicit red-check that the assertion can fail. Its header comment names this exact problem: *"catches a removed or renamed generated resource that typecheck alone misses (`BandLink` casts `BandClient` through `unknown`)"*. Two gaps remain in it, both worth closing while doing the cleanup above: it asserts only that the **preferred** namespaces exist, never that the nine legacy ones are **absent** — so the dead branches stay invisible to it — and the version is pinned in prose (the describe block is literally `"BandClient conformance (0.0.118)"`) rather than read from `package.json`, so it will silently describe the wrong version after the next bump.


#### `RestRequestOptions` drops `abortSignal` from the underlying client
*Major · Effort: S · `packages/sdk/src/client/rest/requestOptions.ts:1`*

**Observation** — Upstream `BaseRequestOptions` exposes `abortSignal?: AbortSignal`, `queryParams`, plus the supported `timeoutInSeconds`/`maxRetries`/`headers`. The SDK's `RestRequestOptions` only forwards three of those four. Because `mergeOptions` (`FernRestAdapter.ts:32`) shallow-merges into `DEFAULT_REQUEST_OPTIONS`, even if a caller sneaks in `abortSignal` via the wider shape it is dropped at the type boundary. The result is that REST calls cannot be cancelled — including the rate-limit retry loop in `withRateLimitRetry` (`FernRestAdapter.ts:73`), which can sleep up to 16s+jitter across four attempts of `getAgentMe`.

**Impact** — REST calls are not cancellable, including long-running retry loops. Users relying on `AbortController` for timeouts or navigation-driven cancellation have no recourse on the REST path.

**Fix** — Either re-export `BaseRequestOptions` as `RestRequestOptions`, or add `abortSignal?: AbortSignal` (and `queryParams?: Record<string, unknown>`) to the interface and forward it through `mergeOptions`. Honor the signal in `withRateLimitRetry`'s `sleep` (`FernRestAdapter.ts:63`).

[↑ Summary in review.md M9](../review.md#m9-abortsignal-not-plumbed-through-rest)

#### Connect handshake hand-rolls its deferred instead of using `Promise.race`
*Minor · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:406-434`, `:121-149`*

**Observation** — `waitForConnection` (`:406-434`) hand-rolls the deferred: it constructs a `new Promise`, stashes `connectResolve`/`connectReject` on `this`, and arms a `setTimeout` that rejects. It is correct as written — the timer is cleared on both outcomes (`:421` on resolve, `:426` on reject), and `connect()` (`:121-149`) captures the pending promise in a local and only clears `this.connectPromise` when it is still the same promise (`:136`, `:141`), so a late `onOpen` cannot let a second `connect()` observe a stale one. But that correctness rests on three separate `null`-out sites (`:413-414`, `:422`, `:427-428`) plus the identity check in `connect()`, spread across four methods (`connect`, `waitForConnection`, `handleOpen`, `recordTerminalDisconnect`) and not obvious from any one of them.

**Impact** — Maintenance risk only. The connect handshake's correctness depends on every future edit preserving a null-out discipline that no type or test enforces.

**Fix** — Optional. If this area is touched again, replace the stashed-callback pair with `Promise.race` between a deferred settled by `handleOpen`/`recordTerminalDisconnect` and a timeout promise, so the "who settles this, and is it still current?" question has one answer in one place. `clearTimeout` in a `finally` rather than in each branch.

#### `onHandlerError` is declared but never wired up
*Major · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:42`, `:148`*

**Observation** — `private onHandlerError?: (error: unknown) => void;` is declared and called when a topic handler rejects, but nothing in the codebase ever assigns it. There is no setter, no constructor option, and `BandLink` does not register one. So topic-handler errors only get logged — `BandLink` has no way to react (e.g., disconnect, surface a typed `TransportError` on the event iterator).

**Impact** — Topic-handler errors are silently swallowed at the transport boundary. The link has no error escape hatch, so failures in message handling are invisible to callers.

**Fix** — Either remove the field, or expose it (constructor option / `setHandlerErrorCallback`) and have `BandLink` enqueue a typed error event or trip an internal failed-state.

#### Unsafe casts reach into Phoenix Socket internals
*Major · Effort: M · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:459-471`, `:92`*

**Observation** — The hand-rolled `phoenix.d.ts` does not expose `Socket.channels` or `Socket.remove(channel)`, so the transport reads/writes them through two named helpers that launder the socket: `removeSocketChannel` (`:459-462`, cast on `:460`) and `getSocketChannelCount` (`:464-471`, cast on `:465`). Naming them helps readability but not type safety.

The `onClose` mismatch is sharper. The callback registered at `:92` is typed inline as `(event?: { code?: number; reason?: string }) => void` while `phoenix.d.ts:29` declares `onClose(callback: () => void)`. That assignment only type-checks because a function with an optional parameter is assignable to a zero-parameter signature — the ambient is being worked around, not satisfied. `recordSocketClose` (`:369-387`) then reads `event?.code` and `event?.reason` and derives a `platformReason` from them, so real behaviour depends on a payload the ambient does not describe (phoenix passes the WS CloseEvent — see `node_modules/phoenix/assets/js/phoenix/socket.js:404,544`).

**Impact** — The casts bypass the type checker entirely for private Phoenix internals. Any Phoenix upgrade that renames `channels` or `remove` will silently break connection cleanup at runtime with no compile-time warning.

**Fix** — Two options:

1. **Switch to `@types/phoenix` + a small extension** (recommended). A direct inspection of `@types/phoenix@1.6.7` confirms it declares `Socket.remove(channel: Channel): void` and `Socket.onClose(callback: (event: CloseEvent) => …)` correctly — both currently casted-around in the transport. The only gap is `Socket.channels`, which the SDK can declare via a 3-line ambient extension on top of `@types/phoenix`:

   ```ts
   import "phoenix";
   declare module "phoenix" {
     interface Socket { channels: Channel[]; }
   }
   ```

   Add `@types/phoenix` to `devDependencies`, delete the hand-rolled `phoenix.d.ts`, and replace it with this extension file. Inherits ongoing maintenance from DefinitelyTyped instead of carrying it in-tree.

2. **Extend the hand-rolled `phoenix.d.ts`** to declare the real members in use (`remove(channel: Channel): void;`, `channels: Channel[];`, `onClose(callback: (event: { code?: number; reason?: string }) => void): number`). Lower one-time cost, but the SDK keeps owning the ambient forever and `phoenix.d.ts` will continue to type only a fraction of Phoenix's actual surface.

Either way, drop the `as unknown as` casts in `PhoenixChannelsTransport.ts:460` and `:465` afterwards, and give `onClose` a declared event payload so `:92` no longer relies on optional-parameter assignability.

[↑ Summary in review.md M10](../review.md#m10-phoenixdts-ambient-is-too-narrow)

#### `phoenix.d.ts` ambient narrows behaviour the SDK depends on
*Major · Effort: M · `packages/sdk/src/phoenix.d.ts:1-32`*

**Observation** — The `phoenix` npm package ships no `.d.ts` (`node_modules/phoenix/package.json` has no `types` field), so an ambient is necessary. The SDK's hand-rolled ambient under-specifies:

- **`onClose(() => void)`** — declared with no event payload.
- **`Socket.remove`** — not declared.
- **`Socket.channels`** — not declared.
- **`Channel.join()` / `leave()`** — declared as returning `Push` with no `timeout` overload.
- **`joinRef` / `ref` lifecycle** — not declared.

This is the root cause of two other issues in this review.

**Impact** — The incomplete ambient forces unsafe casts throughout the transport and allows the type checker to accept code that silently misuses the Phoenix API. Any future transport addition touching these undeclared members will require another cast.

**Fix** — Prefer adopting `@types/phoenix` (community-maintained on DefinitelyTyped — current version `1.6.7` covers the full Socket/Channel/Push/Presence surface including `Socket.remove`, `Socket.onClose(event: CloseEvent)`, `Channel.push()`, `ChannelState`, etc.; missing only `Socket.channels` which can be added via a 3-line ambient extension). Alternative: expand the hand-rolled ambient to cover the surface the SDK actually uses — lower one-time cost but the SDK keeps owning the maintenance.

[↑ Summary in review.md M10](../review.md#m10-phoenixdts-ambient-is-too-narrow)

#### REST errors are not normalized to typed SDK errors
*Major · Effort: M · `packages/sdk/src/client/rest/FernRestAdapter.ts:73-98`, `:407-934`, `packages/sdk/src/client/rest/RestFacade.ts:408-415`*

**Observation** — Successful or 4xx/5xx errors thrown by `@band-ai/rest-client` are `BandError`/`BandTimeoutError`. The adapter only catches these for rate-limit detection (`isFernRateLimitError`) and otherwise re-throws verbatim. Pagination/schema mismatches throw raw `Error("Invalid ... response: ...")` (`FernRestAdapter.ts:106`, `:147`, `:178`) instead of `ValidationError`/`BandSdkError`. `RestFacade.forward` (line 408) only logs `debug` — it does not log the failure with context or wrap the error. So consumers cannot reliably `instanceof TransportError`/`ValidationError` to react.

**Impact** — Callers cannot reliably distinguish REST error types. Pagination and schema errors surface as generic `Error` instances, making structured error handling impossible and silently hiding validation failures in logs.

**Fix** — Replace the raw `throw new Error("Invalid ... response")` calls with `ValidationError` (already imported elsewhere in `pagination.ts`). In `RestFacade.forward`, catch and log `warn` with operation + context, then rethrow; optionally wrap non-SDK errors in `TransportError` to give callers a stable type to catch. Treat `BandTimeoutError` explicitly — it's a transient and could be retried under the same backoff policy as 429.

#### Connection retention on close depends on probing private socket state
*Major · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:337-348`, `:369-387`, `:464-471`*

**Observation** — `stopReconnectIfNoChannels` (`:337-348`) calls `getSocketChannelCount(this.socket)`, which reads the private `channels` array, and returns early unless the count is exactly `0`. The guard is written `getSocketChannelCount(this.socket) !== 0` (`:340`), so when the cast fails and the helper yields the `"unknown"` sentinel, `"unknown" !== 0` is true, the method returns, and the socket keeps reconnecting. The sentinel exists precisely because the cast can fail, and the guard treats that failure as "channels remain" — the least safe of the two readings.

Three call paths reach it: `recordSocketClose` (`:373`) on a clean close, and the socket `onError` handler on both the retryable-upgrade path (`:103`) and the generic-error path (`:116`). So a cast failure defeats reconnect-stop after a failed handshake as well as after a close. Meanwhile the SDK's own `this.channels` Map (`:35`) is the source of truth and already tracks every joined topic — the code never consults it.

**Impact** — The socket can continue reconnecting indefinitely when `getSocketChannelCount` returns `"unknown"` (cast failure), even when the SDK has no active topics. This wastes network resources and can prevent clean shutdown — now reachable from close, upgrade-failure, and generic-error paths.

**Fix** — Use `this.channels.size === 0` in `stopReconnectIfNoChannels` instead of poking at Phoenix internals. That fixes all three call sites at once, removes the `"unknown"` sentinel entirely, and removes one of the unsafe casts.

### Minor

#### ~~`disconnect()` mutates the map being iterated~~ — no longer applicable
*Not a finding · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:151-172`*

An earlier review of this file flagged `disconnect()` for iterating `this.channels.keys()` while `leave()` deleted from the same map. That is no longer the code. `disconnect()` (`:151-172`) snapshots the keys and leaves in parallel — `await Promise.allSettled([...this.channels.keys()].map((topic) => this.leave(topic)))` (`:152-154`) — and surfaces the failures rather than swallowing them: rejected results are collected (`:159-164`) and rethrown as an `AggregateError` (`:166-171`). Recorded here only so the pattern is not "re-fixed"; it is already the model the rest of the cleanup paths should follow.

#### `BandLink.disconnect()` uses `Promise.allSettled` and silently swallows leave errors
*Minor · Effort: S · `packages/sdk/src/platform/BandLink.ts:172-183`*

**Observation** — The `allSettled` correctly continues on individual room-unsubscribe failures, but the rejections are never inspected — they are swallowed.

**Impact** — Unsubscribe failures during disconnect are invisible to operators. Orphaned server-side subscriptions may persist without any log signal to diagnose them.

**Fix** — Iterate the settled results and `logger.warn("Failed to unsubscribe room during disconnect", { roomId, error: result.reason })` on each rejected entry.

#### `RestFacade.forward` only debug-logs and never warns on failure
*Minor · Effort: S · `packages/sdk/src/client/rest/RestFacade.ts:408-415`*

**Observation** — Every REST call emits a `debug` line on entry but errors propagate without a `warn`/`error` log carrying the operation name. This is the only place that knows the high-level operation name (`getMemory`, `listChats`, …).

**Impact** — REST failures are invisible in production logs unless the caller happens to log the caught error. The operation name is lost once the error propagates past this boundary.

**Fix** — Wrap `call()` in a try/catch, ``logger.warn(`REST ${operation} failed`, { ...metadata, error })``, then rethrow.

#### `getNextMessage` silently converts `UnsupportedFeatureError` to `null`
*Minor · Effort: S · `packages/sdk/src/platform/BandLink.ts:442-456`*

**Observation** — The catch returns `null` on `UnsupportedFeatureError` but emits no log. Operators trying to diagnose why messages aren't being pulled will see no signal.

**Impact** — Silent fallback makes it impossible to distinguish "no message available" from "feature not supported on this REST adapter" without reading the source code.

**Fix** — `logger.warn("getNextMessage unsupported on current REST adapter", { roomId, error })` before returning `null`.

#### `getStaleProcessingMessages` does not handle errors
*Minor · Effort: S · `packages/sdk/src/platform/BandLink.ts:366-379`*

**Observation** — Pre-checks `this.rest.listMessages` but lets thrown errors from the call bubble. Compare with `getNextMessage` which catches `UnsupportedFeatureError`. Inconsistent.

**Impact** — Inconsistent error handling between two similar methods confuses callers about what error contract to expect from the REST layer.

**Fix** — Either return `[]` with a `warn` log on `UnsupportedFeatureError`, or document that the caller must handle it. Whichever is chosen, do it consistently with `getNextMessage`.

#### Hand-rolled `instanceof Error` fallback in retry loop is dead code
*Minor · Effort: S · `packages/sdk/src/client/rest/FernRestAdapter.ts:95-97`*

**Observation** — The loop only exits via early `return` (success) or `throw` (failure on the last attempt / non-429). The trailing `throw lastError instanceof Error ? lastError : new Error("Rate-limit retry exhausted without a terminal error.")` is unreachable.

**Impact** — Dead code adds noise and can mislead future readers into thinking the branch is reachable, potentially causing incorrect modifications.

**Fix** — Remove and `throw new Error("unreachable")` (or restructure as a do/while with `for` index returning).

#### `setTimeout`-based sleep ignores cancellation
*Minor · Effort: S · `packages/sdk/src/client/rest/FernRestAdapter.ts:63-65`*

**Observation** — `sleep()` is a bare `setTimeout` wrapper. If/when `abortSignal` is added to `RestRequestOptions`, this would still block until the timer fires.

**Impact** — Even after `abortSignal` is plumbed through `RestRequestOptions`, the retry sleep will not respect cancellation, leaving callers blocked for up to 16s+ during backoff.

**Fix** — Take an optional `AbortSignal` and reject (or resolve early) on abort.

#### `payloadSchemas.ts` schemas accept `.passthrough()` but the parsed payload is then dropped
*Minor · Effort: S · `packages/sdk/src/platform/BandLink.ts:502-523`, `packages/sdk/src/platform/streaming/payloadSchemas.ts`*

**Observation** — Schemas use `.passthrough()` which preserves unknown keys, but the event shape stores the parsed payload *and* a `raw` copy. There's no consumer of `raw` in this layer, and the duplication doubles the per-event payload memory.

**Impact** — Per-event memory usage is doubled by storing both the parsed and raw payload with no consumer of the raw copy in the network/platform layer.

**Fix** — Confirm `raw` is consumed downstream (it isn't in the network/platform code). If not, drop `raw` from the BaseEvent.

#### `ws` is load-bearing, not a removable polyfill — do not "drop the `ws` dependency"
*Minor · `packages/sdk/src/platform/streaming/nodeWebSocketFactory.ts:2`, `:19-33`, `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:437-445`*

**Why this is worth stating explicitly** — `ws` looks like a legacy polyfill that Node 22.12's native `WebSocket` global makes redundant, and an earlier review of this file recommended removing it on exactly that reasoning. **Removing it would break API-key authentication.** Authentication happens on the handshake, not the query string: `resolveWebSocketFactory` (`PhoenixChannelsTransport.ts:437-445`) builds a factory that sets an `x-api-key` **request header** (`nodeWebSocketFactory.ts:19-24`), and the native `WebSocket` constructor cannot set handshake headers at all. The transport says so itself — `resolveWebSocketFactory` throws `TransportError("Phoenix WebSocket API-key auth requires a WebSocket transport that can set handshake headers.")` on any non-Node runtime (`:442-444`). A comment at `nodeWebSocketFactory.ts:1` recording this would stop the next reader reaching the same wrong conclusion.

**What is worth fixing** — the casts, of which there are three: `NodeWebSocket as unknown as NodeWebSocketConstructor` (`nodeWebSocketFactory.ts:20`), `BandNodeWebSocket as unknown as typeof WebSocket` (`:32`), and the `NodeUpgradeWebSocket` intersection type (`:4-11`) that hand-declares the `unexpected-response` / `emit` members `@types/ws` does not surface in the shape the factory needs. The factory also `return`s a non-`this` value from a constructor (`:28`) to smuggle the real socket out of the wrapper class.

**Residual impact** — Low, but the SDK now carries a hand-rolled `ws`-to-DOM adapter with three unchecked casts on the connection path, and a constructor-return trick that most readers will not expect.

**Residual fix** — Replace the wrapper `class` + constructor-return with a plain factory function typed as `typeof WebSocket` at the single boundary Phoenix requires, and narrow the two `as unknown as` casts to one declared adapter interface. Also worth a comment at `nodeWebSocketFactory.ts:1` recording *why* `ws` is mandatory (handshake headers), so this finding is not "re-fixed" by a future reader.

**Also worth noting** — the "API key never logged" strength recorded below is now true for a different reason: the key no longer travels in Phoenix `params` (`PhoenixChannelsTransport.ts:70-76` passes only `agent_id` and `on_conflict`), it travels in the `x-api-key` handshake header. It is still never logged, but the logger-redaction argument no longer covers it — nothing logs the header at all.

### Nits

#### `phoenix.d.ts` lives at `src/phoenix.d.ts` instead of a `types/` folder
*Nit · Effort: S · `packages/sdk/src/phoenix.d.ts`*

**Observation** — Both `phoenix.d.ts` and `optional-deps.d.ts` live at the root of `src/`. There's a `src/types/` folder used for shared types but ambients are not co-located.

**Impact** — Ambient declarations are scattered rather than grouped, making it harder to locate all type overrides when debugging type issues.

**Fix** — Move ambient `.d.ts` files into `src/types/ambient/` (or similar) so the `src/` root contains only first-class source.

#### `barrel src/rest/index.ts` could be `export *`
*Nit · Effort: S · `packages/sdk/src/rest/index.ts`*

**Observation** — This barrel re-exports from three sibling files in `client/rest/`. It is split across `export type { ... }` and `export { ... }` — fine, but two of the re-exports are from a single file (`RestFacade` and `FernRestAdapter` both from `./RestFacade`). Could simplify.

**Impact** — Slightly more verbose barrel than necessary; any new export from `RestFacade` requires a manual update here.

**Fix** — Replace the `export { FernRestAdapter, RestFacade } from "../client/rest/RestFacade";` line with `export * from "../client/rest/RestFacade";` so future exports added to `RestFacade.ts` don't need a parallel update here.

#### `BandLink.queueEvent` is `public` but only used internally
*Nit · Effort: S · `packages/sdk/src/platform/BandLink.ts:207-215`*

**Observation** — `queueEvent` is `public` and called from `emit` (`:517`). No external caller in the network code uses it.

**Impact** — Exposing an internal method as public widens the API surface unnecessarily and may invite misuse by external callers.

**Fix** — Mark `private` unless it is intentionally part of the test surface.

#### `DEFAULT_WS_URL` and `deriveDefaultRestUrl` live alongside the class instead of in `constants/config`
*Nit · Effort: S · `packages/sdk/src/platform/BandLink.ts:49-55`*

**Observation** — A single constant and a 4-line URL deriver are inlined. Fine as-is, but they are also re-exported from `src/index.ts`, suggesting they may be part of the public API and could live in a clearer location.

**Impact** — Configuration values are harder to discover and maintain when inlined in implementation files rather than a dedicated constants module.

**Fix** — Either leave inline (cheap) or move to `platform/constants.ts`.

#### `markMessageStatus` operation-name argument is typed as a string union mirroring caller names
*Nit · Effort: S · `packages/sdk/src/platform/BandLink.ts:418-440`*

**Observation** — The `operation` argument has a literal union manually duplicated from the three call sites.

**Impact** — Adding a new call site requires updating the union type manually; a missed update silently produces a type error only at the call site.

**Fix** — Either accept any string (for logging) or extract a `const MARK_OPERATIONS = [...] as const` and derive the type.

## Strengths worth keeping

- **Centralized channel cleanup in `PhoenixChannelsTransport.leave`** (`:245-271`) — removes all event ref subscriptions before leaving the channel, then deletes from both maps. Matches "Resource Cleanup Patterns".
- **`pendingJoins` map** (`:37`, `:182-197`) — handles concurrent `join(topic)` calls by deduping promises, preventing duplicate channels and duplicate handlers.
- **Logger sanitization** (`core/logger.ts:11,93`) — `SENSITIVE_KEY_PATTERN` redacts `api_key`, `token`, `authorization`, `secret`, `cookie`, `password` from logged context. Credentials in `Logger`-routed paths are safe by default. The SDK consistently routes through `Logger`, not `console`.
- **Rate-limit retry with exponential backoff + jitter** (`FernRestAdapter.ts:67-92`) — matches "Async Function Design" ("Implement retry logic with exponential backoff for transient failures"). Retries are bounded.
- **Zod payload validation at the event boundary** (`BandLink.emit`, `:502-523`) — invalid socket payloads are logged and dropped rather than throwing into the consumer's iterator. Schemas have a single source of truth in `payloadSchemas.ts` and the `SupportedSocketEvent` type is derived (no duplication).
- **`StreamingTransport` interface** (`platform/streaming/transport.ts`) abstracts the websocket implementation and lets tests inject a fake — matches "Design Principles" ("Prefer explicit dependency injection over hidden singleton calls"). `BandLinkOptions.transport` accepts a custom transport.
- **API key never logged** — the key travels in an `x-api-key` handshake header set inside `nodeWebSocketFactory.ts:19-24`, not in Phoenix `params` (which carry only `agent_id` and `on_conflict`, `PhoenixChannelsTransport.ts:70-76`). Nothing logs the header, and the rest-client accepts the key in its constructor rather than in logged headers. Note this means logger redaction is not what protects it — nothing logs it at all.
- **Pagination is generic and validated** — `fetchPaginated` (`pagination.ts:107`) caps `maxPages`, supports three explicit termination strategies, and emits `ValidationError` on malformed metadata.
- **Capability gating before subscription** — `subscribeAgentContacts` calls `assertCapability` before joining the channel, so a contacts-disabled runtime never opens the channel rather than silently consuming events it cannot service.
- **`AbortSignal` is plumbed through `runForever` and `nextEvent`** on the WS side (`BandLink.ts:185`, `:299`), with proper listener cleanup in `nextEvent` (`:313-349`). Cancellation is correct on the streaming path even though it is missing on the REST path.

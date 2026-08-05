[← Back to top-level review](../review.md)

# Network Layer Review

Scope: `packages/sdk/src/client/`, `packages/sdk/src/rest/`, `packages/sdk/src/platform/`, `packages/sdk/src/phoenix.d.ts`.

## Summary

The network layer is split into three concerns — a REST facade/adapter over `@thenvoi/rest-client`, a Phoenix Channels websocket transport, and a thin `ThenvoiLink` that joins them and exposes an `AsyncIterable` of platform events. Most of the code is reasonable, but a hand-rolled type abstraction (`FernThenvoiClientLike`) is out of sync with the installed upstream client, and the Phoenix transport leans on unsafe casts because its ambient declaration is too narrow.

**What's good:**

- Centralized channel cleanup in `PhoenixChannelsTransport.leave` removes every event ref subscription before leaving and deletes from both maps.
- `pendingJoins` map dedupes concurrent `join(topic)` calls, preventing duplicate channels and handlers.
- `ConsoleLogger` redacts `api_key`/`token`/`authorization`/`secret`/`cookie`/`password` from logged context, and credentials never go through `console`.
- Rate-limit retry uses bounded exponential backoff with jitter.
- Zod payload validation at the event boundary drops invalid socket payloads with a log rather than throwing into the consumer iterator.
- `StreamingTransport` interface abstracts the websocket and lets tests inject a fake.
- `AbortSignal` is plumbed through `runForever`/`nextEvent` on the WS side with proper listener cleanup.

**What's not** (each linked to its full finding):

- The hand-rolled REST client interface is out of sync with the installed upstream — see [`FernThenvoiClientLike` does not match the installed `@thenvoi/rest-client`](#fernthenvoiclientlike-does-not-match-the-installed-thenvoirest-client).
- No cancellation on REST: [`RestRequestOptions` drops `abortSignal`](#restrequestoptions-drops-abortsignal-from-the-underlying-client) and the [retry sleep ignores cancellation](#settimeout-based-sleep-ignores-cancellation).
- Phoenix ambient is too narrow, forcing [unsafe casts into Socket internals](#unsafe-casts-reach-into-phoenix-socket-internals) and [misdeclared callbacks](#phoenixdts-ambient-narrows-behaviour-the-sdk-depends-on).
- Connect-timeout uses manual `setTimeout` instead of `Promise.race` — see [Connect timeout uses manual `setTimeout`](#connect-timeout-uses-manual-settimeout-instead-of-promiserace).
- Dead state with no error escape hatch: [`onHandlerError` declared but never wired](#onhandlererror-is-declared-but-never-wired-up).
- REST errors aren't normalized — see [REST errors are not normalized to typed SDK errors](#rest-errors-are-not-normalized-to-typed-sdk-errors).
- Close-path probes private Phoenix state instead of the SDK's own map — see [Connection retention on close depends on probing private socket state](#connection-retention-on-close-depends-on-probing-private-socket-state).

## Findings

### Blockers

#### `FernThenvoiClientLike` does not match the installed `@thenvoi/rest-client`
*Blocker · Effort: L · `packages/sdk/src/client/rest/types.ts:233`, `packages/sdk/src/client/rest/FernRestAdapter.ts:411-934`*

**Observation** — `FernThenvoiClientLike` (`client/rest/types.ts:233`) is a hand-rolled interface meant to describe the shape of the upstream `@thenvoi/rest-client` so the SDK can wrap it. But the namespaces it declares — `agentApiIdentity`, `agentApiContacts`, `agentMemories`, `agentApiPeers`, `humanApiProfile`, `chatContext`, and ~8 others — don't exist on the actually-installed `ThenvoiClient`. The real client (`node_modules/@thenvoi/rest-client/dist/cjs/Client.d.ts`) exposes only `agents`, `chatRooms`, `chatParticipants`, `chatMessages`, `system`, `myChats`, `myChatMessages`, `myChatThreads`, `myProfile`, `myTasks`, `test`, `tools`.

The double-cast at `platform/ThenvoiLink.ts:97` (`new ThenvoiClient(...) as unknown as FernThenvoiClientLike`) is what makes the SDK compile despite the divergence — without it, TypeScript would flag every missing namespace as an error. The cast is doing exactly what casts do: making the compiler accept something it would otherwise refuse.

At runtime the breakage takes two forms:

- **Silent fallback** — `FernRestAdapter` probes phantom namespaces with optional chaining. `getAgentMe()` (line 411) tries `agentApiIdentity?.getAgentMe`, finds `undefined`, and falls back to `myProfile.getMyProfile`. The call succeeds but returns data from the wrong code path — potentially with different semantics than the SDK intended.
- **Hard failure** — when no fallback exists, the adapter throws `UnsupportedFeatureError`. Affected: peers, contacts, memory, contact requests, chat events (line 474), chat participants (line 532), chat context (line 907), `getNextMessage` (line 644).

There's also a lockfile drift on top: `package.json` pins `0.0.113` but the installed version is `0.0.112-rc.0`.

**Impact** — A large fraction of network paths (peers, contacts, memory, contact requests, agent identity) are permanently broken against the real upstream client. Callers will receive `UnsupportedFeatureError` for features that should work once the correct client namespaces are mapped.

**Fix** —

- **Stop hand-writing `FernThenvoiClientLike`** — replace it in `client/rest/types.ts:233` with a type derived from the real client (e.g. `type ThenvoiRestClient = InstanceType<typeof ThenvoiClient>`) and use that wherever `FernThenvoiClientLike` is referenced today, so the compiler enforces alignment with whatever `@thenvoi/rest-client` actually exposes.
- **Delete the dead branches in `FernRestAdapter.ts`** — any code path probing a namespace that doesn't exist on the real client (`agentApiIdentity`, `agentApiContacts`, `agentApiMessages`, `agentMemories`, `agentApiPeers`, `humanApiProfile`, `chatContext`, …) is unreachable and should be removed; if a branch is reserved for a future client version, gate it behind an explicit feature flag with a TODO and the target version.
- **Remove the cast at `platform/ThenvoiLink.ts:97`** (`as unknown as FernThenvoiClientLike`) — with the above done it is no longer needed and keeping it would re-hide future drift.
- **Reconcile the version mismatch** — `package.json` declares `0.0.113` but `node_modules` has `0.0.112-rc.0`; decide which is the source of truth (likely the lockfile / what's installed in CI), align the other side, and if `0.0.113` is an unreleased build that's expected to introduce the missing namespaces, document that in the SDK README.

[↑ Summary in review.md B4](../review.md#b4-fernthenvoiclientlike-interface-mismatches-the-installed-thenvoirest-client)

### Major

#### `RestRequestOptions` drops `abortSignal` from the underlying client
*Major · Effort: S · `packages/sdk/src/client/rest/requestOptions.ts:1`*

**Observation** — Upstream `BaseRequestOptions` exposes `abortSignal?: AbortSignal`, `queryParams`, plus the supported `timeoutInSeconds`/`maxRetries`/`headers`. The SDK's `RestRequestOptions` only forwards three of those four. Because `mergeOptions` (`FernRestAdapter.ts:32`) shallow-merges into `DEFAULT_REQUEST_OPTIONS`, even if a caller sneaks in `abortSignal` via the wider shape it is dropped at the type boundary. The result is that REST calls cannot be cancelled — including the rate-limit retry loop in `withRateLimitRetry` (`FernRestAdapter.ts:73`), which can sleep up to 16s+jitter across four attempts of `getAgentMe`.

**Impact** — REST calls are not cancellable, including long-running retry loops. Users relying on `AbortController` for timeouts or navigation-driven cancellation have no recourse on the REST path.

**Fix** — Either re-export `BaseRequestOptions` as `RestRequestOptions`, or add `abortSignal?: AbortSignal` (and `queryParams?: Record<string, unknown>`) to the interface and forward it through `mergeOptions`. Honor the signal in `withRateLimitRetry`'s `sleep` (`FernRestAdapter.ts:63`).

[↑ Summary in review.md M9](../review.md#m9-abortsignal-not-plumbed-through-rest)

#### Connect timeout uses manual `setTimeout` instead of `Promise.race`
*Major · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:215-231`*

**Observation** — `waitForConnection` builds a Promise with a `setTimeout` reject and stashes `connectResolve` on `this`. If `onOpen` fires *after* the timeout rejects, `connectResolve` is overwritten to `null`, but the surrounding `connectPromise` plumbing in `connect()` (lines 79-103) only nulls `connectPromise` on settle — there is no protection against a second `connect()` call landing while `onOpen` happens to fire late. Also the `setTimeout` is not cleared on early reject, only on resolve (line 227).

**Impact** — The uncleared timeout and late-resolve race can lead to unexpected state — a second `connect()` call may observe a stale promise or a spurious resolve after timeout. The timeout handle leak is minor but can cause test-flakiness.

**Fix** — Replace with `Promise.race` between a deferred resolved on `onOpen` and a timeout promise. Track the open callback ref so it can be removed on either outcome. Always `clearTimeout` regardless of which branch wins.

#### `onHandlerError` is declared but never wired up
*Major · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:24`, `:148`*

**Observation** — `private onHandlerError?: (error: unknown) => void;` is declared and called when a topic handler rejects, but nothing in the codebase ever assigns it. There is no setter, no constructor option, and `ThenvoiLink` does not register one. So topic-handler errors only get logged — `ThenvoiLink` has no way to react (e.g., disconnect, surface a typed `TransportError` on the event iterator).

**Impact** — Topic-handler errors are silently swallowed at the transport boundary. The link has no error escape hatch, so failures in message handling are invisible to callers.

**Fix** — Either remove the field, or expose it (constructor option / `setHandlerErrorCallback`) and have `ThenvoiLink` enqueue a typed error event or trip an internal failed-state.

#### Unsafe casts reach into Phoenix Socket internals
*Major · Effort: M · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:242-254`, `:59`*

**Observation** — The hand-rolled `phoenix.d.ts` does not expose `Socket.channels` or `Socket.remove(channel)`, so the transport reads/writes them via `socket as unknown as { remove?: ... }` and `socket as unknown as { channels?: Channel[] }`. Similarly, `onClose` is declared `() => void` but the implementation reads `event.code`/`event.reason` from the CloseEvent (phoenix passes the WS CloseEvent — see `node_modules/phoenix/assets/js/phoenix/socket.js:404,544`).

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

Either way, drop the `as unknown as` casts in `PhoenixChannelsTransport.ts:243, :248` afterwards.

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

**Observation** — Successful or 4xx/5xx errors thrown by `@thenvoi/rest-client` are `ThenvoiError`/`ThenvoiTimeoutError`. The adapter only catches these for rate-limit detection (`isFernRateLimitError`) and otherwise re-throws verbatim. Pagination/schema mismatches throw raw `Error("Invalid ... response: ...")` (`FernRestAdapter.ts:106`, `:147`, `:178`) instead of `ValidationError`/`ThenvoiSdkError`. `RestFacade.forward` (line 408) only logs `debug` — it does not log the failure with context or wrap the error. So consumers cannot reliably `instanceof TransportError`/`ValidationError` to react.

**Impact** — Callers cannot reliably distinguish REST error types. Pagination and schema errors surface as generic `Error` instances, making structured error handling impossible and silently hiding validation failures in logs.

**Fix** — Replace the raw `throw new Error("Invalid ... response")` calls with `ValidationError` (already imported elsewhere in `pagination.ts`). In `RestFacade.forward`, catch and log `warn` with operation + context, then rethrow; optionally wrap non-SDK errors in `TransportError` to give callers a stable type to catch. Treat `ThenvoiTimeoutError` explicitly — it's a transient and could be retried under the same backoff policy as 429.

#### Connection retention on close depends on probing private socket state
*Major · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:59-72`*

**Observation** — On socket close the transport calls `getSocketChannelCount(this.socket)`, which reads the private `channels` array, and if it is zero/`"unknown"` calls `socket.disconnect()` to stop reconnecting. The comparison is `=== 0`, so if the cast yields `"unknown"` the early-return branch is *not* taken and the socket will keep reconnecting — but the SDK's own `this.channels` Map is the source of truth and already tracks topics. The code never consults its own state.

**Impact** — The socket can continue reconnecting indefinitely when `getSocketChannelCount` returns `"unknown"` (cast failure), even when the SDK has no active topics. This wastes network resources and can prevent clean shutdown.

**Fix** — Track joined topics in the SDK's `this.channels` Map (already does) and on close use `this.channels.size === 0` instead of poking at Phoenix internals. That also removes one of the unsafe casts.

### Minor

#### `disconnect()` mutates the map being iterated
*Minor · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:105-112`*

**Observation** — `for (const topic of this.channels.keys()) { await this.leave(topic); }` — `leave()` deletes from `this.channels`. Map iteration handles deletion during iteration, but the pattern is fragile and a future refactor (e.g., parallel leaves with `Promise.all`) would break.

**Impact** — Maintenance burden — any future refactor to parallel cleanup will silently skip topics due to mid-iteration mutation, with no compile-time warning.

**Fix** — Snapshot: `const topics = [...this.channels.keys()]; await Promise.all(topics.map((t) => this.leave(t)));` (or keep sequential if order matters). Also matches the "Resource Cleanup Patterns" guidance about a single, deterministic cleanup function.

#### `ThenvoiLink.disconnect()` uses `Promise.allSettled` and silently swallows leave errors
*Minor · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:125-136`*

**Observation** — The `allSettled` correctly continues on individual room-unsubscribe failures, but the rejections are never inspected — they are swallowed.

**Impact** — Unsubscribe failures during disconnect are invisible to operators. Orphaned server-side subscriptions may persist without any log signal to diagnose them.

**Fix** — Iterate the settled results and `logger.warn("Failed to unsubscribe room during disconnect", { roomId, error: result.reason })` on each rejected entry.

#### `RestFacade.forward` only debug-logs and never warns on failure
*Minor · Effort: S · `packages/sdk/src/client/rest/RestFacade.ts:408-415`*

**Observation** — Every REST call emits a `debug` line on entry but errors propagate without a `warn`/`error` log carrying the operation name. This is the only place that knows the high-level operation name (`getMemory`, `listChats`, …).

**Impact** — REST failures are invisible in production logs unless the caller happens to log the caught error. The operation name is lost once the error propagates past this boundary.

**Fix** — Wrap `call()` in a try/catch, ``logger.warn(`REST ${operation} failed`, { ...metadata, error })``, then rethrow.

#### `getNextMessage` silently converts `UnsupportedFeatureError` to `null`
*Minor · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:350-364`*

**Observation** — The catch returns `null` on `UnsupportedFeatureError` but emits no log. Operators trying to diagnose why messages aren't being pulled will see no signal.

**Impact** — Silent fallback makes it impossible to distinguish "no message available" from "feature not supported on this REST adapter" without reading the source code.

**Fix** — `logger.warn("getNextMessage unsupported on current REST adapter", { roomId, error })` before returning `null`.

#### `getStaleProcessingMessages` does not handle errors
*Minor · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:366-379`*

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
*Minor · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:405-421`, `packages/sdk/src/platform/streaming/payloadSchemas.ts`*

**Observation** — Schemas use `.passthrough()` which preserves unknown keys, but the event shape stores the parsed payload *and* a `raw` copy. There's no consumer of `raw` in this layer, and the duplication doubles the per-event payload memory.

**Impact** — Per-event memory usage is doubled by storing both the parsed and raw payload with no consumer of the raw copy in the network/platform layer.

**Fix** — Confirm `raw` is consumed downstream (it isn't in the network/platform code). If not, drop `raw` from the BaseEvent.

#### Optional `ws` dependency typing
*Minor · Effort: S · `packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts:2`, `:234-240`*

**Observation** — `import { WebSocket as NodeWebSocket } from "ws"` is unconditional, and then `return NodeWebSocket as unknown as typeof WebSocket` is needed because `ws.WebSocket` is shaped slightly differently from DOM `WebSocket`. Engines target Node >= 22.12, which has a native `WebSocket` global. The `ws` polyfill is no longer strictly required.

**Impact** — An unnecessary `ws` dependency ships with the SDK and the cast hides a type mismatch that could surface as a runtime error on Node versions where native and polyfill `WebSocket` differ in behavior.

**Fix** — Drop the `ws` import and use the native `WebSocket` global on Node 22.12+, removing the cast. If older Node compatibility is needed, gate the import dynamically and avoid the `as unknown as` cast by defining a narrow common interface.

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

#### `ThenvoiLink.queueEvent` is `public` but only used internally
*Nit · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:142-150`*

**Observation** — `queueEvent` is `public` and called from `emit` (line 416). No external caller in the network code uses it.

**Impact** — Exposing an internal method as public widens the API surface unnecessarily and may invite misuse by external callers.

**Fix** — Mark `private` unless it is intentionally part of the test surface.

#### `DEFAULT_WS_URL` and `deriveDefaultRestUrl` live alongside the class instead of in `constants/config`
*Nit · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:36-42`*

**Observation** — A single constant and a 4-line URL deriver are inlined. Fine as-is, but they are also re-exported from `src/index.ts`, suggesting they may be part of the public API and could live in a clearer location.

**Impact** — Configuration values are harder to discover and maintain when inlined in implementation files rather than a dedicated constants module.

**Fix** — Either leave inline (cheap) or move to `platform/constants.ts`.

#### `markMessageStatus` operation-name argument is typed as a string union mirroring caller names
*Nit · Effort: S · `packages/sdk/src/platform/ThenvoiLink.ts:326-348`*

**Observation** — The `operation` argument has a literal union manually duplicated from the three call sites.

**Impact** — Adding a new call site requires updating the union type manually; a missed update silently produces a type error only at the call site.

**Fix** — Either accept any string (for logging) or extract a `const MARK_OPERATIONS = [...] as const` and derive the type.

## Strengths worth keeping

- **Centralized channel cleanup in `PhoenixChannelsTransport.leave`** (line 179) — removes all event ref subscriptions before leaving the channel, then deletes from both maps. Matches "Resource Cleanup Patterns".
- **`pendingJoins` map** (line 22, 118-133) — handles concurrent `join(topic)` calls by deduping promises, preventing duplicate channels and duplicate handlers.
- **Logger sanitization** (`core/logger.ts:11,93`) — `SENSITIVE_KEY_PATTERN` redacts `api_key`, `token`, `authorization`, `secret`, `cookie`, `password` from logged context. Credentials in `Logger`-routed paths are safe by default. The SDK consistently routes through `Logger`, not `console`.
- **Rate-limit retry with exponential backoff + jitter** (`FernRestAdapter.ts:67-92`) — matches "Async Function Design" ("Implement retry logic with exponential backoff for transient failures"). Retries are bounded.
- **Zod payload validation at the event boundary** (`ThenvoiLink.emit`, line 405) — invalid socket payloads are logged and dropped rather than throwing into the consumer's iterator. Schemas have a single source of truth in `payloadSchemas.ts` and the `SupportedSocketEvent` type is derived (no duplication).
- **`StreamingTransport` interface** (`platform/streaming/transport.ts`) abstracts the websocket implementation and lets tests inject a fake — matches "Design Principles" ("Prefer explicit dependency injection over hidden singleton calls"). `ThenvoiLinkOptions.transport` accepts a custom transport.
- **API key never logged** — `params: { api_key: options.apiKey }` is passed to Phoenix; the logger redacts it. The rest-client also accepts the key in its constructor, not in headers logged anywhere by the SDK.
- **Pagination is generic and validated** — `fetchPaginated` (`pagination.ts:107`) caps `maxPages`, supports three explicit termination strategies, and emits `ValidationError` on malformed metadata.
- **Capability gating before subscription** — `subscribeAgentContacts` calls `assertCapability` before joining the channel, so a contacts-disabled runtime never opens the channel rather than silently consuming events it cannot service.
- **`AbortSignal` is plumbed through `runForever` and `nextEvent`** on the WS side (`ThenvoiLink.ts:138`, `:223`), with proper listener cleanup in `nextEvent` (`:235-259`). Cancellation is correct on the streaming path even though it is missing on the REST path.

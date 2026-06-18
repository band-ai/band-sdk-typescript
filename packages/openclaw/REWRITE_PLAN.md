# OpenClaw Channel Plugin Rewrite — Design & Implementation Plan (FINAL)

> Status: **CONSENSUS REACHED** with architect (reviewed over Band/Jam, grounded against the
> installed `openclaw@2026.3.24` `.d.ts` and our `@thenvoi/sdk`). Target: rewrite
> `@band-ai/openclaw-channel-band` from the legacy OpenClaw plugin shape onto the modern
> `openclaw/plugin-sdk` channel plugin API, per
> https://docs.openclaw.ai/plugins/sdk-channel-plugins.

## 1. Motivation & Context

The current plugin (`packages/openclaw/src/{index,channel,mcp-tools,prompts}.ts`) targets a
**legacy** OpenClaw plugin contract:

- Default-export `plugin(api)` reading `api.registerChannel`, `api.registerTool`,
  `api.on("before_agent_start")`, `api.onInboundMessage`, `api.runtime`.
- A hand-rolled `bandChannel` with `gateway.startAccount/stopAccount`,
  `outbound.sendText/sendMedia`, `setup.validateConfig`, `threading`, `messaging`.
- A global `globalThis` "gateway registry" to survive Jiti module reloads.
- Inbound dispatch by **reflectively** poking `runtime.channel.reply.dispatchReplyFromConfig`
  (`channel.ts:672-756`).
- 12 custom MCP tools via `api.registerTool`.
- System-prompt injection via the `before_agent_start` hook (`index.ts:110-122`).

The modern SDK (verified present in installed `openclaw@2026.3.24`) provides first-class
factories: `createChannelPluginBase`, `createChatChannelPlugin`, `defineChannelPluginEntry`,
`defineSetupPluginEntry` (all from `openclaw/plugin-sdk/core`), plus dispatch helpers
`dispatchInboundMessage` / `dispatchInboundMessageWithBufferedDispatcher`
(from `openclaw/plugin-sdk/reply-runtime`). Adopting these removes all reflection into
private runtime internals.

## 2. Resolved Decisions (consensus)

| # | Decision |
|---|----------|
| **D1 — Inbound + lifetime** | Band is push/WebSocket (not webhook): **no `registerHttpRoute`**. The long-lived connection is owned by the **channel gateway adapter** `gateway.startAccount(ctx)`, kept alive with `runPassiveAccountLifecycle({ abortSignal, start, stop })` (`plugin-sdk/channel-lifecycle`). Each inbound `message_created` event is delivered to core via `ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg, dispatcherOptions:{ deliver } })`, where `deliver` routes to `outbound.sendText`. `registerFull(api)` is used **only** for tool registration, not for owning the socket. |
| **D2 — Tools boundary** | Reply/"say this in the room" flows through core's shared `message` tool + the channel `outbound` adapter (`plugin-sdk/tool-send`). **Drop `band_send_message`** (and any speculative cross-room send — YAGNI; nothing in the codebase needs it). **Keep the 6 platform-management tools** core has no equivalent for: peers lookup, participants add/remove/list (3), create_chatroom, send_event, contacts CRUD + contact-request handling. |
| **D3 — Mandatory mentions** | There is **no** channel-level "mentions are mandatory" hook in 2026.3.24. Enforcement is a **hard invariant in the outbound adapter**: resolve mentions (explicit `@Name` in text → last-sender → first-other-participant) and **throw if it resolves to zero**. Mention logic lives in a pure `mentions.ts`. |
| **D4 — Version pin (UPDATED → latest)** | Target **latest `2026.6.6`** (per product decision — greenfield rewrite should build against current). `devDependencies.openclaw` pinned to **`2026.6.6`**, `peerDependencies` **`>=2026.6.0`**. The 2026.6.6 API is **backward-compatible** with the surface our consensus designed against — all factories/dispatch/gateway/mention symbols verified present in its `.d.ts`. We code to its **real export map**, now with proper TYPE contracts available (see D9). (Supersedes the earlier 2026.3.24 pin from the first consensus round.) |
| **D5 — Prompt injection** | `ChannelAgentPromptAdapter.messageToolHints({ cfg, accountId })` only sees `cfg`/`accountId` — **no per-room context**. So `agentPrompt` hosts the **static** `BASE_INSTRUCTIONS` only. Per-room `room_id` is **our** responsibility: `startAccount` appends a **`\n\n[Band Room: <roomId>]` SUFFIX** to the model-visible display `Body` (a *suffix*, not a prefix — see INT-836 ordering note in §2A, so it can't collide with leading-`@agent` strip or leading-`/command` parse). Command fields (`CommandBody`/`BodyForCommands`/`RawBody`) stay raw. `formatThreadContext`/envelope no longer carry `roomId`; reply routing back to the same room is automatic via `outbound.sendText(ctx.to=roomId)`. |
| **D6 — State** | Drop the `globalThis` registry as the default. Use a **module-scoped `Map` keyed by `accountId`**, populated by `startAccount`, read by `getLink('default')` for the **tools path** (tool execution gets only params — no `accountId`/gateway ctx, so tools stay single-account `'default'` with a documented limitation). Keep a `reset()` for test isolation. Re-add a versioned-`globalThis` guard **only if** a real duplicate-connection bug appears under the loader (prove it, don't pre-pay). |
| **D7 — Migration** | The two entries cannot run side-by-side (both register the same channel id + alias → double-register + double WS connect). So: **big-bang module cutover**, **test-first scaffolding** (write new pure modules behind tests while legacy still ships), **single-commit entry swap** once `channel.test` is green. Keep legacy files until the ported e2e passes. |
| **D8 — Wiring** | The `gateway` adapter (`startAccount`/`stopAccount`) is a **top-level field on `ChannelPlugin`** and is carried via the **`base` object** passed to `createChatChannelPlugin` (which only destructures base/security/pairing/threading/outbound). `ctx.channelRuntime` is **optional** — **null-guard it**: when absent, log + skip dispatch (degraded path) rather than throw. *(Step-6 verification: confirm how the gateway adapter attaches to the `base` returned by `createChannelPluginBase`, whose options list `gatewayMethods` but not a `gateway` field.)* |
| **D9 — Testing approach (sdk-testing)** | The sdk-testing doc's helper *functions* (`createTestPluginApi`, `installChannelSetupContractSuite`, `expectChannelInboundContextContract`, …) are **in-repo-only** — NOT published in 2026.6.6 for external plugins. So: keep **vitest + hand-rolled `vi.fn()` spies** for behavior, and additionally **type the plugin against the real exported TYPE contracts** for compile-time conformance — `plugin-sdk/channel-contract` (`ChannelMeta`, `ChannelCapabilities`, `ChannelGatewayContext`, `ChannelOutboundAdapter`, `ChannelMentionAdapter`, `ChannelToolSend`, …), `plugin-sdk/config-contracts` (`DmPolicy`, `GroupPolicy`, `ReplyToMode`, `ChannelConfigSchema`, …), `plugin-sdk/channel-entry-contract`. `installCommonResolveTargetErrorCases`/`withEnv` are also unavailable here — emulate with local equivalents if needed. |

### Verified API facts (2026.6.6 — backward-compatible with prior consensus)
- `dispatchInboundMessage({ ctx, cfg, dispatcher, replyOptions?, ... })` — `plugin-sdk/reply-runtime`; buffered variants `dispatchInboundMessageWithBufferedDispatcher` and `dispatchReplyWithBufferedBlockDispatcher` also there.
- `ChannelGatewayContext` now includes optional `channelRuntime?: ChannelRuntimeSurface` (since 2026.2.19); `gateway` is top-level on `ChannelPlugin`.
- `resolveChannelGroupRequireMention` gained `requireMentionOverride` + `overrideOrder:'before-config'|'after-config'` (exactly what D3 needs); **`resolveInboundMentionDecision({facts, policy})` is the preferred gating API — `resolveMentionGating`/`resolveMentionGatingWithBypass` are `@deprecated` in 2026.6.6, so build L3/F2 on the new API (its `shouldBypassMention` covers the owner-command bypass).**
- Dist is **flattened/hashed** in 2026.6.6 (no `src/` subtree); the `./plugin-sdk/testing` export subpath was **removed**. Import ONLY through public `plugin-sdk/*` subpaths — never deep-import a hashed chunk. (D4 pin is per product decision superseding the first round's Q4.)
- `agentPrompt` (`ChannelAgentPromptAdapter`) `messageToolHints` still only `{cfg, accountId}` (D5 holds); NEW optional `messageToolCapabilities`/`inboundFormattingHints`/`reactionGuidance` available.
- Outbound: `createAttachedChannelResultAdapter` (`plugin-sdk/channel-send-result`) builds `sendText`/`sendMedia` returning `OutboundDeliveryResult { channel, messageId, ... }`.
- `dispatchInboundMessage` legacy note retained — `channel-inbound` holds mention helpers, not dispatch.
- `runPassiveAccountLifecycle` / `waitUntilAbort` — `plugin-sdk/channel-lifecycle`.
- `ChannelGatewayContext` = `{ cfg, accountId, account, runtime, abortSignal, log, getStatus, setStatus, channelRuntime? }`.
- `ChannelThreadingAdapter` = `resolveReplyToMode` / `buildToolContext` / `resolveAutoThreadId` (no `formatThreadContext`).
- `formatInboundEnvelope` carries `channel/from/body/chatType/sender` — **not** `to`/`roomId`.
- `ChannelAgentToolFactory` gets only `{ cfg }`; tool execution receives params only.
- Factories live in `plugin-sdk/core`; `tool-send` (`extractToolSend`, `ChannelToolSend`), `outbound-runtime`, `channel-pairing`, `channel-policy` all present.

## 2A. INT-836 Personal-Agent Conformance Alignment

OpenClaw is a **personal-agent (PA) runtime**; this plugin is the **Band integration** (Band = the
platform `@thenvoi/sdk`/`ThenvoiLink` talks to — the Python SDK calls it `BandLink`). Band is *one of
several* platforms the agent connects to. Every level has an **inbound** (Band events → runtime) and
**outbound** (runtime decisions → Band actions) face; **isolation = the owner's configured topology**,
not a universal no-bleed rule (refined per harness).

Grounded SDK facts enabling this: `AgentIdentity.ownerUuid` (owner id via `getAgentMe()`), room payload
`type` + `owner` (direct-vs-group + room owner), `ContactEventHandler` `hub_room` strategy
(`createChat(hubTaskId)`), `stateDir` in configSchema (persistence).

| Rung / Fn | Status | What the rewrite does |
|---|---|---|
| **L0** Platform Adaptation | aligned | Band registers as a connected platform; chat tools namespaced; turn carries Band room+participant context, kept distinct. |
| **L1** Custom Prompt & Tools | aligned | `agentPrompt` adds Band instructions **additively** alongside the agent's native prompt; tools listed alongside, no clobber. |
| **L2** Conversation Context Fidelity *(inverts)* | **fix-in-rewrite** | Thread-identity fidelity: session key `band:{roomId}` is stable per room and does **not** fold chat_type/platform (avoids unintended fuse/split). **Bug fix:** stop hardcoding `ChatType:"group"` (legacy `channel.ts:696`). Room `type` is **not** on the message event nor retained by `RoomPresence` (Set of ids), so cache it in an **account-scoped `Map<roomId,type>` from the `onRoomJoined` payload** and look it up at dispatch; on miss (joined pre-restart / nullish) **default `'group'` + WARN** (safe because requireMention is forced false — chat_type no longer drives gating, only thread/observability labeling). Default = per-room isolation; exact bar refined per harness. |
| **L3** Multi-Participant *(inverts)* | **fix-in-rewrite** | **Band owns mention-gating** — agent applies **no** DM-vs-group gating; trust platform routing. Concretely (CORRECTED): set **`groups.resolveRequireMention: () => false`** (the `ChannelGroupAdapter` field on the base) — this is the channel's lever, NOT the internal `resolveChannelGroupRequireMention` core fn the first round named. `security.dm` is the **open/process-all** policy (`resolvePolicy: () => 'open'`, `resolveAllowFrom: () => null`, `defaultPolicy:'open'`). Net: every Band-delivered message processed, zero agent-side gate. Co-resident-N is N/A (single owned runtime). |
| **F2** Owner-gated commands + mention trim *(L3)* | **fix-in-rewrite (was a bug)** | Resolve `ownerUuid` via `getAgentMe()` at `startAccount`; set inbound `CommandAuthorized = (senderId === ownerUuid)` (legacy hardcoded `true` — `channel.ts:697`, an any-sender privilege bug). `ownerUuid` is **optional** → **fail-closed**: if null/undefined, `CommandAuthorized=false` for everyone. Mention-trim via the sanctioned **`ChannelMentionAdapter.stripMentions`** (`{text,ctx,cfg,agentId}`, using `channel-inbound` `buildMentionRegexes`/`normalizeMentionText`), **not** manual `ctx.Body` surgery. **F2 + L3 are coupled** — `commandAuthorized` feeds the gating decision's owner bypass; design as one unit. **Use `resolveInboundMentionDecision({ facts, policy })`** (its `shouldBypassMention` is exactly the owner bypass) — NOT `resolveMentionGatingWithBypass`, which is `@deprecated` in 2026.6.6. |
| **L4** Rehydration | aligned + F1 facet | Re-attach to Band rooms (incl. hub) on restart via `RoomPresence` auto-subscribe; `markProcessed` prevents replay/dupes. |
| **F1** Main-channel hub *(L0; restart L4)* | **deferred (seam designed)** | On first connect provision an **owner-only** hub (agent+owner), persist in `stateDir`, re-provision if missing. Builds on `ContactEventHandler` hub_room primitives. Bigger scope → propose as follow-up ticket; this rewrite leaves a clean seam (no global state, account-scoped). |
| **L5** Capabilities — Contacts | aligned | Contact tools = canonical L5 bar, **no inversion**. |
| **L5** Capabilities — Memory | out of scope | Band memory = shared cross-agent store; "asked-for, **not an early requirement**." Not in this rewrite. |
| **F3** Cross-platform control *(L5)* | aligned (single-account) | The 6 management tools ARE the cross-platform control surface — they drive Band from any platform context (work whenever the Band account is connected via `getLink('default')`). **Caveat:** aligned only for the **single connected Band account** (same single-account YAGNI limit as D6/C3); multi-Band-account control is out of scope. |
| **L6** Observability | aligned | `band_send_event` emits all types (thought/error/task/tool_call/tool_result). |
| **F0** Onboarding *(gate)* | aligned | Plugin installs like other platform plugins; `configSchema` + `uiHints` + `validateConfig` = guided credential flow; binary precondition to L0. |

**Net new work vs §2 plan:** L2 room-type cache (`Map<roomId,type>` from `onRoomJoined`) + chat-type
default/warn + stable thread key (bug fix); F2 owner-gating (`ownerUuid`, fail-closed) + mention-trim
via `stripMentions` adapter (bug fix); L3 `requireMention` forced false + open `security.dm`; D5
room-marker is a **suffix** (ordering-safe). F2 + L3 gating designed as one coupled unit.
**Deferred:** F1 hub (seam only), L5 shared-memory (out of scope).

> **INT-836 ordering note (inbound body transforms).** Three transforms touch the inbound body and all
> key off its start: the room marker, `stripMentions` (leading `@agent`), and command-parse. To keep
> them order-independent: command fields (`CommandBody`/`BodyForCommands`/`RawBody`) stay **raw**
> (core runs `stripMentions` → command-parse on them); the room marker is **appended as a suffix** to
> the model-visible `Body` only. A trailing, non-mention, non-leading token cannot corrupt either
> transform regardless of pipeline order.

## 3. Target Design

### 3.1 File structure
```
packages/openclaw/
├── package.json            # openclaw.extensions + openclaw.channel; pin openclaw 2026.3.24
├── openclaw.plugin.json    # kind:"channel", channels:[...], channelConfigs schema/uiHints
├── src/
│   ├── index.ts            # defineChannelPluginEntry({ ..., registerFull })  (tools only)
│   ├── setup-entry.ts      # defineSetupPluginEntry(bandChannel)  — transport-free
│   ├── channel.ts          # createChatChannelPlugin({ base, security, threading, outbound })
│   ├── base.ts             # createChannelPluginBase({ id, meta, capabilities, config, setup, agentPrompt, gateway })
│   ├── transport.ts        # ThenvoiLink + RoomPresence lifecycle; event→ctx (+room suffix)→dispatch
│   ├── outbound.ts         # sendText/sendMedia → resolveMentions → rest.createChatMessage
│   ├── tools.ts            # 6 platform-management custom tools
│   ├── mentions.ts         # pure resolveMentions (word-boundary @Name match)
│   ├── config.ts           # resolveAccount/inspectAccount/validateConfig + env fallbacks
│   ├── state.ts            # module-scoped account Map (getLink/setLink/reset)
│   └── prompts.ts          # static BASE_INSTRUCTIONS (no prompt-time room_id block)
└── tests/                  # see §5
```

### 3.2 `@thenvoi/sdk` usage (same repo)
- `ThenvoiLink` (root) — WS + REST combined client.
- `RoomPresence` (`@thenvoi/sdk/runtime`) — auto room subscription + `onRoomEvent/onRoomJoined/onRoomLeft/onContactEvent`.
- `ContactEventHandler` (`@thenvoi/sdk/runtime`) — contact-request dedup/broadcast.
- Types: `PlatformEvent`, `ContactEvent`, `ContactEventConfig` (root); `AgentIdentity`, `ChatParticipant` (`@thenvoi/sdk/rest`).
- REST surface: `getAgentMe`, `listChatParticipants`, `createChatMessage`, `createChatEvent`, `createChat`, `addChatParticipant`, `removeChatParticipant`, `listPeers`, `listContacts`, `addContact`, `removeContact`, `listContactRequests`, `respondContactRequest`, `markProcessed`.

### 3.3 Lifecycle (gateway.startAccount, per D1/D8)
1. Build `ThenvoiLink`; `connect()`; resolve `ownerUuid` + agent name via `getAgentMe()` (cache per
   account, for F2); create `RoomPresence({ autoSubscribeExistingRooms:true })`.
2. `setLink(accountId, link)` into the module-scoped Map (tools path).
3. `onRoomJoined`: cache `{roomId → room.type}` in an account-scoped Map (for L2 chat-type lookup).
4. `onRoomEvent`: skip self-authored + non-`text`; **no agent-side mention-gating (L3 — Band gated;
   requireMention forced false)**; map `message_created` → inbound ctx: keep command fields
   (`CommandBody`/`BodyForCommands`/`RawBody`) **raw** (core's `stripMentions` adapter trims the
   leading `@agent`, F2); **append** `\n\n[Band Room: <roomId>]` **suffix** to the display `Body`
   (D5 — suffix is order-independent, can't collide with leading-mention-strip / leading-command);
   set **`ChatType`** from the cached room type (default `'group'`+warn on miss, L2); set
   **`CommandAuthorized = senderId === ownerUuid`**, **fail-closed** if `ownerUuid` absent (F2). If
   `ctx.channelRuntime` present →
   `dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg, dispatcherOptions:{ deliver } })` where
   `deliver` → `outbound.sendText`; else log + skip (degraded). `markProcessed` best-effort.
5. `onContactEvent` → `ContactEventHandler.handle(...)`.
6. `runPassiveAccountLifecycle({ abortSignal, start, stop })` keeps it alive; `stop` calls
   `presence.stop()` + `link.disconnect()` exactly once; `deleteLink(accountId)`.
7. Duplicate-start guard preserved (account already starting).

### 3.4 Outbound adapter (per D2/D3)
- `outbound.attachedResults.sendText({ to, text })`: `resolveMentions` then
  `rest.createChatMessage(roomId, { content, mentions })`, return `{ messageId }`. **Throw** if
  mentions resolve to empty.
- `outbound.base.sendMedia(...)`: append media URL to text, reuse send path.

## 4. Migration / Compatibility / Rename (thenvoi → band)
This rewrite **rebrands the channel from `thenvoi` to `band`** (the underlying client lib stays
`@thenvoi/sdk` / `ThenvoiLink` — only the *channel/plugin* surface is renamed):
- **npm package:** `@thenvoi/openclaw-channel-thenvoi` → **`@band-ai/openclaw-channel-band`**.
  (Source dir stays `packages/openclaw/` unless we decide to rename it too.)
- **Channel id / label / alias:** → **`openclaw-channel-band`** / **"Band"** / **`["band"]`**
  (channel object `bandChannel`, log tag `[band]`). Clean rebrand — **no `thenvoi` back-compat alias**.
- **MCP tools:** `thenvoi_*` → **`band_*`** (6 retained management tools; drop `band_send_message`
  per D2). Update manifest `contracts.tools` accordingly.
- **Env vars:** `THENVOI_*` → **`BAND_API_KEY` / `BAND_AGENT_ID` / `BAND_WS_URL` / `BAND_REST_URL`**.
- **Session key:** `band:{roomId}`; **room marker:** `[Band Room: X]`.
- Keep `configSchema` accounts shape (apiKey/agentId/wsUrl/restUrl/stateDir) + the `BAND_*` env
  fallbacks.
- Bump plugin version; CHANGELOG notes the rename **and** the behavior change (reply via shared
  tool/outbound vs. legacy plain-text auto-route, and the `[Band Room: X]` body suffix).

## 5. TDD Test Plan (tests authored BEFORE implementation)

Tooling: vitest (configured). **B2:** `StubRestApi` is a no-op example stub (ignores args, omits
the optional contact methods) — use **hand-rolled `vi.fn()` RestApi spies** to assert call args.
Order = red → green → refactor; phasing **pure → outbound → contract → transport → e2e**.

**Phase 0 — characterization:** preserve the intent of current unit tests (channel-gateway,
mcp-tools, prompts) as the behavioral contract the rewrite must still satisfy.

**Final inventory:**
1. `mentions.test.ts` — word-boundary `@Name` (`@bob` ≠ `@bobby`); explicit `@Name` beats
   last-sender fallback; multiple `@Names` → multiple mentions; case-insensitive; excludes self;
   null/throw when only self present.
2. `config.test.ts` — `resolveAccount` precedence (plugin entries vs channels), env fallbacks,
   defaults; `validateConfig` ok/err (spy `getAgentMe`); `inspectAccount` reports configured
   **without leaking secrets**.
3. `prompts.test.ts` — `BASE_INSTRUCTIONS` is **static only** (no prompt-time room_id block).
4. `tools.test.ts` — the 6 management tools, happy path + validation errors, via `vi.fn()`
   RestApi spy (peers pagination, participant resolve-by-name, contacts CRUD, events).
5. `outbound.test.ts` — `sendText` resolves mentions + calls `createChatMessage` + returns
   `{ messageId }`; **throw-on-empty**; `sendMedia` appends URL; **explicit `@Name` end-to-end
   through the adapter** (the contract replacing `band_send_message`).
6. `channel.test.ts` — factory contract: `id`/`meta`/`capabilities`; **gateway-in-base present**;
   `security.dm` resolves; threading mode; outbound wired; `setup.resolveAccount` present.
7. `transport.test.ts` — `message_created` → ctx mapping **including the `[Band Room: X]`
   marker appearing as a SUFFIX on display `Body`** while command fields stay raw; self + non-text
   skip; **no agent-side mention-gating applied; a non-mention group message is still processed
   (requireMention forced false, L3)**; **`ChatType` from cached room type; cache MISS → `'group'`
   + warn (L2)**; stable per-room session key (distinct rooms → distinct keys, no fuse);
   `markProcessed` best-effort **does not throw**; contact-event routing to `ContactEventHandler`;
   **`channelRuntime`-absent degraded path** (log + skip); abort resolves the lifecycle + `stop()`
   called **once**; duplicate-start guard.
8. `mention-adapter.test.ts` — `stripMentions` removes a leading `@agent` token, leaves mid-text
   `@agent` and other text intact (composes with command-parse).
9. **`no-globalThis-leak`** assertion across tests.
10. Ported **env-gated e2e** (`connection`/`messaging`/`tools`) on `BAND_API_KEY`/`BAND_AGENT_ID`.
11. **F2 owner-gating matrix**: owner `senderId===ownerUuid` → `CommandAuthorized` true; non-owner →
    false (normal handling, no command); **`ownerUuid` absent → fail-closed (false for everyone)**;
    owner `/x` in a direct room → authorized without a mention; **edge case — user text that itself
    ends with `[Band Room: ...]`-shaped text still parses/authorizes correctly** (marker is
    display-only, command fields raw). (F1 hub tests land with the deferred F1 ticket, not this
    rewrite.)

**Gates:** package test suite green; typecheck clean; eslint clean; coverage parity-or-better vs.
the current unit suite.

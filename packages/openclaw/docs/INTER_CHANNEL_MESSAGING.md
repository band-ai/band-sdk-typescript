# Band channel: setup & inter-channel messaging

This guide documents what it takes to get the Band channel plugin fully working
inside an OpenClaw runtime — and in particular how to make **inter-channel
messaging** work (e.g. asking the agent on Telegram or webchat to send a message
into a Band room). It's written from the concrete gates we had to clear; each one
below corresponds to a real error you'll otherwise hit.

> TL;DR — if you set up Band via `openclaw channels add`, the plugin **auto-allows
> its own tools + the `message` tool** for you. The only step you must do by hand
> is opt into **cross-provider messaging** (a security toggle, §3). See
> [Troubleshooting](#troubleshooting) for the error → fix map.

## How messaging works in OpenClaw (mental model)

- The Band integration is an **OpenClaw channel plugin**, *not* an MCP server. Its
  management tools are named **`band_*`** (e.g. `band_lookup_peers`,
  `band_create_chatroom`), registered via the plugin's `registerFull(api)`.
- There is **no `band_send_message` tool** (intentionally dropped — see
  `REWRITE_PLAN.md` D2). Sending a chat message flows through **core's shared
  `message` tool** + this plugin's **`outbound` adapter** (`outbound.sendText`).
- **In-room replies route automatically**: when a message arrives from a Band
  room, the agent's plain-text reply is dispatched back to that same room. No tool
  needed.
- **Inter-channel / proactive sends need the `message` tool**: when the agent is
  *not* sitting in the target room (it's on Telegram, webchat, or another Band
  room), plain text won't reach the destination. The agent must call `message`
  with an explicit `channel` + `target`.

## Required configuration (`~/.openclaw/openclaw.json`)

### 1. Connect the Band account

```json
"channels": {
  "openclaw-channel-band": {
    "enabled": true,
    "accounts": {
      "my-band-account": {
        "apiKey": "band_...",
        "agentId": "8d74cf37-..."
      }
    }
  }
}
```

> The account key (`my-band-account` here) can be any id — it does **not** have to
> be `"default"`. The plugin resolves the connected account by its configured id
> (see [Plugin capabilities](#plugin-capabilities-shipped-in-this-package)).

And enable the plugin:

```json
"plugins": { "entries": { "openclaw-channel-band": { "enabled": true } } }
```

### 2. Make the tools visible to the agent — **automatic**

Tool **profiles** gate which tools the agent sees. The common `coding` profile
**excludes plugin tools** (`group:plugins`) **and** the core `message` tool
(`group:messaging`), so a configured Band account is otherwise invisible to the
agent.

**You normally don't have to do anything here.** When you configure Band via the
setup wizard, `ensureBandToolsAllowed` adds the required tools to your tool policy
automatically (merging into `tools.allow` or `tools.alsoAllow`, whichever you
use; `profile: "full"` needs nothing). The required tools are:

- `openclaw-channel-band` — the `band_*` management tools (the plugin id surfaces
  *only* this plugin's tools).
- `message` — core's shared send tool. **Without this there is no send tool at
  all** and the agent falls back to raw HTTP or misuses `band_send_event`.

If you hand-edit `openclaw.json` instead of using the wizard, add them yourself:

```json
"tools": { "profile": "coding", "alsoAllow": ["openclaw-channel-band", "message"] }
```

(`alsoAllow` is additive and valid alongside `profile`; you may not combine
`allow` and `alsoAllow` in the same scope.)

### 3. Allow cross-provider sends (`tools.message.crossContext`) — **manual, by design**

By default OpenClaw **denies** sending to a different provider than the session is
bound to (a deliberate guardrail against misrouting). Inter-channel messaging
(Telegram session → Band) is exactly this case, so enable it. This is the **one
setting the plugin does NOT auto-enable** — flipping a security guardrail should
be an explicit, conscious choice, so you set it yourself:

```json
"tools": {
  "message": {
    "crossContext": { "allowAcrossProviders": true }
  }
}
```

- `crossContext.allowAcrossProviders` (default **`false`**) — required for
  Telegram/webchat → Band.
- `crossContext.allowWithinProvider` (default `true`) — same-provider, different
  target; already allowed.
- `allowCrossContextSend` is **deprecated** — use `crossContext.*`.

Cross-context sends get an **origin marker** appended automatically so recipients
can see the message came from another context. Loosening this guardrail means any
session can send to any connected provider — enable it deliberately.

### Full example `tools` block

```json
"tools": {
  "profile": "coding",
  "alsoAllow": ["openclaw-channel-band", "message"],
  "message": {
    "crossContext": { "allowAcrossProviders": true }
  }
}
```

> Config is read at session/runtime startup — **restart the gateway** and start a
> **new session** after editing.

## Plugin capabilities (shipped in this package)

These are handled by the plugin code; listed so you understand why sends resolve:

- **Account resolution by configured id.** Tool execution and the outbound adapter
  resolve the connected account via `resolveAccount()` (`state.ts`): an explicit
  account id must match a connected account (no silent substitution), and a
  cross-context send with no account id falls back to the sole connected account.
  This is why the account key need not be `"default"`.
- **Band targets are recognized.** The shared `message` tool resolves targets
  through a channel directory; Band has no rooms directory, so the plugin declares
  `messaging.targetResolver.looksLikeId` (`channel.ts`) to accept a Band **room id
  (UUID)** as a direct target. Without it, a room id fails as `Unknown target`.
- **Tool allowlisting at setup.** `ensureBandToolsAllowed` (`setup-wizard.ts`) adds
  the `band_*` tools + `message` to the tool policy when the account is configured,
  so they're visible without a manual `tools.alsoAllow` edit.
- **Room discovery.** `band_list_chats` lets the agent enumerate rooms it's in to
  find a room id, rather than relying on an inbound marker.

## Sending a message into a Band room

The agent calls the **`message`** tool with:

- `channel`: `band` (the Band channel)
- `target`: the Band **room id** — a UUID. Get it from:
  - the `band_list_chats` tool (lists rooms you're in — the agent can discover ids
    this way), or
  - the `[Band Room: <uuid>]` marker on an inbound Band message, or
  - the id returned by `band_create_chatroom`.
- `text`: the message body

Two things to know:

- **Band requires at least one `@mention`.** `outbound.sendText` resolves mentions
  (explicit `@Name` → last sender → first other participant) and **throws if none
  resolve**. The target room must have another resolvable participant (use
  `band_add_participant` first if needed).

## Troubleshooting

| Symptom / error | Cause | Fix |
|---|---|---|
| `ToolSearch "band"` → "No matching deferred tools found"; agent uses raw HTTP | `band_*` tools filtered out by the tool profile | The wizard auto-allows them (§2); if hand-editing, add `"openclaw-channel-band"` to `tools.alsoAllow` |
| Searching `mcp__band__*` finds nothing | Wrong namespace — tools are `band_*`, not MCP-prefixed | Search/allow `band_*`; the integration is a channel plugin, not an MCP server |
| No send tool available; agent reaches for `band_send_event` | Core `message` tool not allowlisted | Auto-allowed by the wizard (§2); if hand-editing, add `"message"` to `tools.alsoAllow` |
| `Unknown target` / agent can't find a room to send to | No room id known | Use `band_list_chats` to discover room ids |
| `Cross-context messaging denied: ... target provider "openclaw-channel-band" while bound to "telegram"` | Cross-provider sends denied by default | Set `tools.message.crossContext.allowAcrossProviders: true` (§3) |
| `Band account "default" is not connected` | Account keyed by configured id, not `"default"` | Handled by `resolveAccount()`; ensure the account is connected and rebuild the plugin |
| `Unknown target "<uuid>" for Band` | Target isn't recognized / not a room id | Pass a Band **room UUID** as the target (from a `[Band Room: …]` marker or `band_create_chatroom`); `looksLikeId` accepts canonical UUIDs |
| `Cannot send to room ...: no other participant to @mention` | Band's mandatory-mention rule | Ensure the room has another participant (`band_add_participant`) and/or `@mention` someone in the text |
| Agent keeps using `band_send_event` instead of sending a message | `band_send_event` is for structured activity events only | Prompt + tool description steer to `message`; reinforce in the agent's custom instructions if needed |

## Notes / limitations

- **Single Band account** is the supported scope for the tools/outbound paths
  (D6). Multi-Band-account targeting is out of scope.
- After any `~/.openclaw/openclaw.json` edit or plugin rebuild, **restart the
  gateway** and use a **new session**.
- When developing the plugin locally, rebuild + restage with `pnpm link:local`
  (the runtime loads from `.local-link/dist`).

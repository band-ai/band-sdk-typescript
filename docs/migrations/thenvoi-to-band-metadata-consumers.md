# Thenvoi → Band outbound metadata consumer migration

Canonical checked-in artifact for cross-repository dependency **X-08** and
implementation proof **P-C4-6**. It records every searched source, each known
reader of the renamed outbound metadata, that reader's owner and migration
disposition, and the concrete missing-correlation signal to monitor.

> **Compatibility break (no cross-system atomicity).** The SDK guarantees each
> emitted payload uses a single namespace, but it cannot atomically migrate
> external readers of A2A, Parlant, or Linear-bridge metadata. An operator whose
> reader is not yet migrated must pin or revert to the last `0.x` SDK until that
> reader is updated.

## Searched sources

| Source | Ref / SHA | Scope | Status |
|---|---|---|---|
| `band-sdk-typescript` (this repo) | branch `feature/thenvoi-band-rename-c4-room-metadata`, base `ead21f5` | full `packages/sdk` source, examples, tests, docs | **searched — emitters only; no in-repo reader of the renamed keys** |
| `../thenvoi-platform` (backend) | `70464b737` (branch `dev`) | event/message metadata handling, A2A/Parlant/Linear consumers | **searched — no reader found** |
| `../band-frontend-app` | `ae171b2` | UI metadata consumers | **searched — no reader found** |
| `../platform-ui` | `a29c709` | UI metadata consumers | **searched — no reader found** |
| `../band-sdk-python` | `0c7b8dea` | parallel SDK (separate emitter) | **searched — no reader of TS SDK payloads** |
| `../python-sdk` | `6f00096` | parallel SDK | **searched — no reader found** |
| `../band-prototype` | `1172166` | prototype/operational config | **searched — no reader found** |

Owner approval for read-only linked-repository inspection was granted in room
message #88 and directed in #89. The inventory searched each source above for
the six renamed metadata keys, the three brand values, and the retained
`gateway_*`/`a2a_*` keys. **No in-scope operational reader of any renamed key or
brand value was found.** The backend (`../thenvoi-platform@70464b737`) treats
non-attention event metadata as an opaque, size-bounded pass-through
(`events_controller.ex`), so it neither reads nor validates these keys; the only
`thenvoi_system_prompt`-shaped hit is an unrelated documentation filename
(`obsidian_docs/.../thenvoi_system_prompt_template.md`), not a reader.
`../band-sdk-python` is a separate SDK that emits its own payloads and does not
read this SDK's; any brand alignment there is tracked in the cross-repository
handoff, not this branch.

No owned consumer therefore blocks REL-01 from this inventory. Unknown
third-party readers outside these repositories remain consumer-owned: release
notes publish the old→new key map and the monitors below, and direct an affected
operator to pin the last `0.x` SDK until their reader is migrated.

## Renamed outbound payload keys and values

Owned by C4; changed atomically per payload (no mixed namespace).

### Six metadata keys (`thenvoi_*` → `band_*`)

| Old key | New key | Emitter (owner) |
|---|---|---|
| `thenvoi_message_id` | `band_message_id` | `adapters/a2a-gateway/A2AGatewayAdapter.ts` (`toStatusUpdateEvent`) |
| `thenvoi_message_type` | `band_message_type` | `adapters/a2a-gateway/A2AGatewayAdapter.ts` |
| `thenvoi_sender_id` | `band_sender_id` | `adapters/a2a-gateway/A2AGatewayAdapter.ts` |
| `thenvoi_room_id` (metadata) | `band_room_id` | `adapters/a2a-gateway/A2AGatewayAdapter.ts`, `adapters/parlant/ParlantAdapter.ts` |
| `thenvoi_source` | `band_source` | `adapters/parlant/ParlantAdapter.ts` |
| `thenvoi_system_prompt` | `band_system_prompt` | `adapters/parlant/ParlantAdapter.ts` |

### Three brand values

| Location | Old value | New value |
|---|---|---|
| Parlant `band_source` metadata value | `thenvoi-sdk-typescript` | `band-sdk-typescript` |
| Parlant session title prefix | `Thenvoi Room …` | `Band Room …` |
| Linear bridge `linear_bridge` metadata value | `thenvoi` | `band` |

### Adapter identity strings (write-only, R-12/D-08)

Codex `clientInfo` (`band_codex_adapter` / `Band Codex Adapter`), Google ADK
`APP_NAME` (`band`) and default agent (`band_agent`), A2A agent-card skill tag
(`band`), OpenCode session-title prefix (`Band`). All are write-only identity
sent once (Codex `initialize`, A2A discovery, ADK runner/session with a fresh
UUID, OpenCode new-session title); the SDK reads none of them back.

### Public room-id field

`SessionRoomRecord.bandRoomId` / `PendingBootstrapRequest.bandRoomId` replace
`thenvoiRoomId` in public Linear contracts. The physical SQLite column
`thenvoi_room_id` and the `linear_thenvoi_*` table/index names are retained; the
store maps public `bandRoomId` ↔ physical `thenvoi_room_id` at its boundary.

## Readers, owners, dispositions

| Reader | Owner | Disposition |
|---|---|---|
| A2A gateway routing/history readers of `gateway_context_id`, `gateway_room_id`, `gateway_task_id`, `gateway_peer_id`, `gateway_peer_slug` | this repo | **Unchanged.** These keys are NOT renamed; routing (`shouldRouteToPendingTask`) and history reconstruction (`a2a-gateway/history.ts`) still read them. Retained by design. |
| A2A adapter readers of `a2a_context_id`, `a2a_task_id`, `a2a_task_state` | this repo | **Unchanged / retained.** |
| In-repository readers of the renamed `band_*` metadata keys | this repo | **None.** The six renamed keys are emitted outbound only; no in-repo code reads them back. Verified by source search at base `ead21f5` + this branch. |
| Backend event/message metadata (`../thenvoi-platform@70464b737`) | thenvoi-platform | **No reader.** Non-attention metadata is an opaque, size-bounded pass-through (`events_controller.ex`); the backend does not read or validate the renamed keys. No migration needed. |
| A2A/Parlant/Linear metadata in `../band-frontend-app@ae171b2`, `../platform-ui@a29c709`, `../band-prototype@1172166` | those repos | **No reader found** for any renamed key/brand value. |
| External A2A protocol clients consuming gateway status-event `band_*` metadata | consumer-owned (external, outside inventoried repos) | Not owned here. Release notes publish the old→new key map; affected operators pin the last `0.x` SDK until migrated. |
| External Parlant server / operators reading session & event `band_*` metadata and the `Band Room …` title | consumer-owned (external) | Same as above. |
| External consumers of the Linear-bridge `linear_bridge` metadata value | consumer-owned (external) | Same as above. |

## Missing-correlation monitors (executable signals)

Each renamed key breaks correlation for a reader still matching the old name.
Concrete signals to alert on after release:

- **A2A gateway status metadata.** In the A2A client/telemetry store, count
  status-event payloads whose `metadata` has any `thenvoi_message_id` /
  `thenvoi_room_id` / `thenvoi_sender_id` / `thenvoi_message_type` key in a
  rolling window:
  `SELECT count(*) FROM a2a_status_events WHERE json_extract(metadata,'$.thenvoi_room_id') IS NOT NULL AND received_at > now() - interval '1 hour'` —
  a nonzero result after the SDK upgrade means a producer downgrade or a reader
  still keyed on the old name; expect this to fall to zero and `band_room_id`
  presence to rise correspondingly.
- **Parlant sessions.** Alert when new sessions carry neither
  `metadata.band_source` nor `metadata.band_room_id` while session volume is
  nonzero, or when the session-title prefix distribution still shows
  `Thenvoi Room ` after the rollout window.
- **Linear bridge.** Alert when forwarded bootstrap/room payloads carry
  `linear_bridge = "thenvoi"` after upgrade (should be `"band"`).
- **Correlation-drop backstop.** For each surface, alert on a sustained drop in
  the join rate between emitted events and the downstream reader keyed on the new
  names — a drop that coincides with the SDK version bump identifies an
  unmigrated reader.

The queries above are illustrative of the signal shape; authoritative per-store
monitor definitions live with each consuming system. The in-repository inventory
(this repo + the linked operational repositories listed under Searched sources)
is complete and found no owned reader that blocks REL-01.

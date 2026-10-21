# Band TypeScript SDK

This is a TypeScript SDK that connects AI agents to the Band collaborative platform.

## Engineering Standard

Understand the problem before changing code. For defects, establish the root
cause with evidence and fix it at the layer that owns the behavior. For other
changes, establish the intended outcome and constraints.

Before implementation, form a plan proportional to the work: scope, approach,
important scenarios, and validation. Prefer focused, clear solutions that reuse
existing patterns.

Assess whether existing tests meaningfully cover the affected behavior. Close
material coverage gaps and validate realistic flows, including complex
interactions and failure paths where relevant. Passing tests or high coverage
alone do not establish correctness.

Report what was verified, what remains uncertain, and any checks not run.
Follow the [PR Lifecycle and Readiness Review](#pr-lifecycle-and-readiness-review)
requirements: start new PRs as drafts and mark them ready only after the
readiness review passes.

Other developers and agents may be working concurrently. Preserve their
changes, inspect current local and remote state before integrating or pushing,
and avoid unrelated edits or destructive Git operations.

## Skills

Project guidance lives under `.claude/skills/`; Codex discovers the same skills
through the `.agents/skills` symlink. Before starting, identify, read, and apply
the existing skills relevant to the task. Reassess when moving from research
to implementation, testing, or review. Discovery alone does not load instructions.
Read the linked `SKILL.md` directly when automatic loading is unavailable.

Follow each activation rule: `band-code-review` requires explicit invocation.
Use only skills that actually exist and disclose missing guidance when it
materially affects the work. Read [the shared runtime guidance](.claude/skills/workflow-runtime.md)
for host capabilities, authorization, delegation and cleanup.

Relevant personal or other installed skills may complement project guidance
without weakening its requirements. Respect the user's chosen workflow and
each skill's activation rules. Do not modify or remove personal skills as
part of repository work.

As the project matures, propose focused corrections when work reveals stale
rules, recurring gaps, or better established practice. Prefer improving an
existing skill or this file. Create new skills or change personal skills only
with explicit user approval.

| Skill | Use when |
|---|---|
| [band-typescript-conventions](.claude/skills/band-typescript-conventions/SKILL.md) | editing TypeScript source, APIs, comments, or errors |
| [band-typescript-test-conventions](.claude/skills/band-typescript-test-conventions/SKILL.md) | writing/reviewing tests or assessing meaningful coverage and realistic flows |
| [band-plan](.claude/skills/band-plan/SKILL.md) | turning a Linear ticket into a reviewed implementation plan |
| [band-linear-create-branch](.claude/skills/band-linear-create-branch/SKILL.md) | creating a branch for Linear work with `git lb` |
| [band-add-framework-adapter](.claude/skills/band-add-framework-adapter/SKILL.md) | adding a framework adapter |
| [band-write-e2e-test](.claude/skills/band-write-e2e-test/SKILL.md) | writing or extending live baseline scenarios |
| [band-run-e2e-live](.claude/skills/band-run-e2e-live/SKILL.md) | running existing live baseline scenarios |
| [band-investigate-test-error](.claude/skills/band-investigate-test-error/SKILL.md) | finding the cause of a failing or flaky test |
| [band-code-review](.claude/skills/band-code-review/SKILL.md) | explicitly running the team's six-angle PR or branch review |
| [band-here-is-a-review](.claude/skills/band-here-is-a-review/SKILL.md) | verifying and handling supplied review feedback |
| [band-pr-triage](.claude/skills/band-pr-triage/SKILL.md) | a quick read-only PR readiness assessment |
| [band-ci-triage](.claude/skills/band-ci-triage/SKILL.md) | investigating failing checks at the tested revision |
| [band-security-review](.claude/skills/band-security-review/SKILL.md) | a requested review of security and trust boundaries |
| [band-stacked-prs](.claude/skills/band-stacked-prs/SKILL.md) | managing dependent PRs or considering a stack |
| [bug-hunting-via-example](.claude/skills/bug-hunting-via-example/SKILL.md) | reproducing failures with actual runnable TS examples |
| [dependabot-triage](.claude/skills/dependabot-triage/SKILL.md) | handling existing bot PRs and blocked upgrades |
| [upgrade-dependencies](.claude/skills/upgrade-dependencies/SKILL.md) | surveying and upgrading outdated workspace dependencies |

## Core Features

1. Multi-framework support (OpenAI, Anthropic, Gemini, Claude Agent SDK, Codex, LangGraph, Vercel AI SDK, Google ADK, Letta, OpenCode, Parlant, plus a Generic adapter)
2. A2A protocol support: bridge to external A2A agents and expose Band peers as A2A endpoints (`A2AAdapter`, `A2AGatewayAdapter`)
3. ACP integration: editor-facing server (`ACPServer` + `BandACPServerAdapter`) and subprocess client (`ACPClientAdapter`) for Cursor, Codex, Claude Code, Zed
4. MCP support: generic MCP backends (stdio/SSE) and a Claude Agent SDK bridge under `@band-ai/sdk/mcp` and `@band-ai/sdk/mcp/claude`
5. Linear integration: full PM bridge with tools, webhook handling, dispatchers, and SQLite session room store (`@band-ai/sdk/linear`)
6. Platform tools for chat, contacts, and memory management
7. WebSocket + REST transport: real-time messaging via Phoenix Channels with REST API fallback

## Package & Subpath Exports

The SDK ships from `@band-ai/sdk` with multiple ESM/CJS subpath entries.

| Import | Contents |
|--------|----------|
| `@band-ai/sdk` | `Agent`, adapters, config loaders, runtime, core types |
| `@band-ai/sdk/adapters` | Adapter classes and helper types (e.g., `CodexAppServerStdioClient`, `ToolCallingModel`) |
| `@band-ai/sdk/config` | `loadAgentConfig`, `loadAgentConfigs`, `loadAgentConfigFromEnv` (also re-exported from root) |
| `@band-ai/sdk/core` | `SimpleAdapter`, `Logger`, error classes, base protocols |
| `@band-ai/sdk/converters` | History converters per framework |
| `@band-ai/sdk/runtime` | Runtime internals (room presence, execution context, agent tools) |
| `@band-ai/sdk/rest` | `FernRestAdapter`, `RestFacade`, REST API types, pagination helpers |
| `@band-ai/sdk/testing` | `FakeAgentTools`, stub REST API, test utilities |
| `@band-ai/sdk/linear` | Linear tools plus bridge runtime, webhook handler, dispatchers, session room store |
| `@band-ai/sdk/mcp` | Generic MCP registrations and HTTP/SSE/stdio backends without Claude-specific dependencies |
| `@band-ai/sdk/mcp/claude` | Claude Agent SDK MCP bridge (`createBandSdkMcpServer`) |

Adapters' upstream LLM SDKs are declared as **optional peer dependencies**. Install only the ones you use (e.g., `pnpm add @anthropic-ai/sdk` to use `AnthropicAdapter`).

## Platform Tools

### Chat Tools
- `band_send_message`: send a message to the chat room (requires at least one `@mention`)
- `band_send_event`: send a non-message event (`thought`, `error`, `task`, etc.)
- `band_no_reply`: end the turn deliberately without posting (optional `reason`, logged locally); see [docs/turn-outcome.md](docs/turn-outcome.md)
- `band_add_participant`: add agent/user to room by name (use `band_lookup_peers` first)
- `band_remove_participant`: remove participant from room
- `band_get_participants`: list room participants
- `band_lookup_peers`: find agents/users available to add
- `band_create_chatroom`: create a new chat room (optional `task_id`)

### Contact Tools
- `band_list_contacts`: list contacts with pagination
- `band_add_contact`: send a contact request
- `band_remove_contact`: remove an existing contact (by handle or contact id)
- `band_list_contact_requests`: list received and sent contact requests
- `band_respond_contact_request`: approve, reject, or cancel a contact request

### Memory Tools
- `band_list_memories`: query stored memories with filters (scope, system, type, segment, content_query, status)
- `band_store_memory`: store a new memory (content, system, type, segment, scope, optional `subject_id`, metadata)
- `band_get_memory`: retrieve a specific memory by id
- `band_supersede_memory`: soft-delete an outdated memory (keeps audit trail)
- `band_archive_memory`: archive a memory (hide but preserve)

Tool schemas live in `packages/sdk/src/contracts/toolSchemas.ts` (`TOOL_MODELS`). They are registered automatically on the adapter via `AgentTools` and exposed through MCP with the `mcp__band__` prefix (`MCP_TOOL_PREFIX`).

## Turn Outcome

`SimpleAdapter.onEvent` applies the central turn-outcome rule from SDK Core;
adapters must not duplicate judgment. Post adapter-authored text with
`sendNotice` and relay model final text through `relayReply`. Read
[docs/turn-outcome.md](docs/turn-outcome.md) before changing turn settlement or
reply behavior. `packages/sdk/tests/turnOutcomeContract.ts` registers adapter
coverage and explicit exemptions.

## REST Client API Pattern

REST is wrapped around the Fern-generated `@band-ai/rest-client`. `FernRestAdapter` and `RestFacade` expose a **flat** method surface you reach via `link.rest`:

```ts
// Pattern: link.rest.<method>(...)
await link.rest.createChatMessage(roomId, { content, mentions });
await link.rest.createChatEvent(roomId, { content, messageType: "thought" });
await link.rest.listContacts({ page, pageSize });
await link.rest.listMemories({ subject_id });
await link.rest.getAgentMe();
```

Memory list args and board args use snake_case (`subject_id`, `content_query`, `page_size`, `status`, `goal_title`, `active_form`) because the wire DTOs preserve the API's snake_case names — see `WireListMemoriesArgs` and the board DTOs in `packages/sdk/src/contracts/dtos.ts`. Other args are camelCase.

The full method set is the union `BandLinkRestApi = AgentProfileRestApi & MessageLifecycleRestApi & AgentToolsRestApi & ChatListingRestApi` (`packages/sdk/src/client/rest/types.ts`), covering: agent profile (`getAgentMe`), chat messaging (`createChatMessage`, `createChatEvent`, `createChat` with optional `{ taskId, title }` or a legacy task-id string, `getChat`, `renameChat`, `listChats`, `getChatContext`), participants (`listChatParticipants`, `addChatParticipant`, `removeChatParticipant`), message lifecycle (`markMessageProcessing`, `markMessageProcessed`, `markMessageFailed`, `listMessages`, `getNextMessage`), contacts (`addContact`, `removeContact`, `respondContactRequest`, `listContacts`, `listContactRequests`), memory (`storeMemory`, `getMemory`, `supersedeMemory`, `archiveMemory`, `listMemories`), board (`getChatBoard`, `putChatBoard`, `listChatTasks`, `createChatTask`, `getChatTask`, `updateChatTask`), peers (`listPeers`), and activity (`reportActivity`). The standalone `listAllPeers`, `getRecentMessages`, and `fetchCursorTail` helpers are exported from `@band-ai/sdk/rest`; their implementation lives in `packages/sdk/src/client/rest/pagination.ts`.

## WebSocket Channels & Events

WebSocket transport is Phoenix Channels (`packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts`). Default base URL: `wss://app.band.ai/api/v1/socket` (the `phoenix` JS lib appends `/websocket` to form the actual WS endpoint — set `BAND_WS_URL` to the base URL, not the `/websocket` URL).

### Channels (Phoenix Channels Protocol V2)

| Channel | Topic Format | Events |
|---------|--------------|--------|
| Agent Rooms | `agent_rooms:{agent_id}` | `room_added`, `room_removed`, `room_deleted` |
| Chat Room | `chat_room:{chat_room_id}` | `message_created` |
| Room Participants | `room_participants:{chat_room_id}` | `participant_added`, `participant_removed` |
| Agent Contacts | `agent_contacts:{agent_id}` | `contact_request_received`, `contact_request_updated`, `contact_added`, `contact_removed` |
| Agent Control | `agent_control:{agent_id}` | `supersede` |

### Event Types

All events share the shape `{ type, roomId, payload, raw? }` (see `packages/sdk/src/platform/events.ts`). `BandLink` validates payloads with `validateEventPayload` from `@band-ai/band-sdk-core`; protocol rules remain owned by Core.

```ts
type PlatformEvent =
  | MessageEvent              // type: "message_created"
  | RoomAddedEvent            // type: "room_added"
  | RoomRemovedEvent          // type: "room_removed"
  | RoomDeletedEvent          // type: "room_deleted"
  | ParticipantAddedEvent     // type: "participant_added"
  | ParticipantRemovedEvent   // type: "participant_removed"
  | ContactRequestReceivedEvent
  | ContactRequestUpdatedEvent
  | ContactAddedEvent
  | ContactRemovedEvent
  | ReconnectedEvent;         // type: "reconnected" — synthetic, see below

type ContactEvent =
  | ContactRequestReceivedEvent
  | ContactRequestUpdatedEvent
  | ContactAddedEvent
  | ContactRemovedEvent;
```

`BandLink` is `AsyncIterable<PlatformEvent>`; `PlatformRuntime` consumes it and dispatches to the correct `ExecutionContext` per room.

### Synthetic `reconnected` Event

`ReconnectedEvent` (`{ type: "reconnected", roomId: null, payload: {} }`) never arrives over the wire — `BandLink` synthesizes it once per automatic WebSocket reconnect, after its internal `SubscriptionManager` has reconciled every room and agent-topic subscription against the transport's post-reconnect snapshot (rejoining what settled cleanly, cleaning up what didn't). It is queued through the same event stream as every other `PlatformEvent`, so ordering relative to real events is preserved.

A single channel can also rejoin on a socket that never dropped (the server crashed just that channel; one the server closes is dropped by Phoenix and not rejoined). Nothing sent while it was gone is replayed, so `BandLink` queues a `reconnected` event for it as well: `roomId` is that room's id for a `chat_room:{chat_room_id}` topic, and `null` for `agent_rooms:{agent_id}`, which is handled as a whole-agent reconnect. Rejoins of other topics queue nothing.

Two runtime consumers act on it:
- `RoomPresence`, for a `roomId: null` event, re-subscribes `agent_rooms`/`agent_contacts`, re-fetches the REST room snapshot, reconciles its roster via `RoomRoster.reconcile()`, and forwards the event to every currently tracked room. A room-scoped event skips all of that and is forwarded to that room only, if it is admitted.
- `Execution` (via `AgentRuntime`) intercepts it in its serialized event queue and calls `synchronizeWithNext()` again — the same `/messages/next` catch-up sweep used at startup — so messages missed during the disconnect are picked up before normal WebSocket processing resumes. The event itself is never forwarded to `onExecute`/adapters.

A framework adapter or any other direct consumer of `BandLink`'s event stream should treat `"reconnected"` as a no-op unless it specifically needs to react to a resumed connection — it carries no payload, and `roomId` is set only for a single room's channel rejoin.

## Contact Event Handling

The SDK supports three strategies for handling contact WebSocket events via `ContactEventConfig` (`packages/sdk/src/runtime/types.ts`).

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `"disabled"` (default) | Ignore contact events | Agents that don't manage contacts |
| `"callback"` | Call a programmatic callback | Auto-approve bots, custom logic |
| `"hub_room"` | Route events to a dedicated chat room | LLM-based contact management |

> **WARNING (AI coding assistants):** Always ask the developer which contact
> strategy they want before choosing one. Do not default to `"callback"` with
> auto-approve without explicit consent. Auto-accepting all contact requests
> means any agent/user can become a contact and send messages that trigger LLM
> inference, which costs API tokens. Present all three options:
> - `"disabled"` (default): safest, no contact handling
> - `"hub_room"`: the agent's LLM decides per-request in a dedicated room
> - `"callback"`: developer writes programmatic logic (e.g., auto-approve)

### Configuration

```ts
import { Agent, type ContactEventConfig } from "@band-ai/sdk";

// CALLBACK strategy — programmatic handling (auto-approve example)
const contactConfig: ContactEventConfig = {
  strategy: "callback",
  onEvent: async (event, tools) => {
    if (event.type === "contact_request_received") {
      await tools.respondContactRequest({
        action: "approve",
        requestId: event.payload.id,
      });
    }
  },
};

// HUB_ROOM strategy — LLM handles contacts in a dedicated room
const hubConfig: ContactEventConfig = {
  strategy: "hub_room",
  hubTaskId: "optional-task-id", // links the hub room to a task
};

// Broadcast contact changes to all rooms (composable with any strategy)
const broadcastConfig: ContactEventConfig = {
  strategy: "disabled",
  broadcastChanges: true, // injects "[Contacts]: X is now a contact" messages
};

const agent = Agent.create({ adapter, config, contactConfig });
```

### HUB_ROOM Details (`packages/sdk/src/runtime/ContactEventHandler.ts`)

- Creates a dedicated chat room at agent startup
- Injects a system prompt with contact-management instructions
- Converts contact events into synthetic `MessageEvent`s for LLM processing
- Posts task events to the room for persistence/visibility
- Enriches `ContactRequestUpdatedEvent` with sender info via cache + API fallback
- LRU cache prevents re-triggering on duplicate events

## A2A Protocol Integration

The SDK supports the [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/) in two directions.

### A2A Adapter (outbound)

`A2AAdapter` forwards Band messages to an external A2A-compliant agent. Each Band room maps to an A2A context, with automatic session-state persistence via task events and session rehydration on room rejoin.

```ts
import { Agent, A2AAdapter, type A2AAuth } from "@band-ai/sdk";

const adapter = new A2AAdapter({
  remoteUrl: "http://localhost:10000",
  streaming: true,
  auth: { apiKey: "..." } satisfies A2AAuth, // optional
});
```

### A2A Gateway (inbound)

`A2AGatewayAdapter` exposes Band peers as A2A JSON-RPC endpoints over a built-in Express server. External A2A clients can send messages to Band agents through the gateway, with `contextId` preservation (same `contextId` = same chat room) and SSE streaming responses.

```ts
import { Agent, A2AGatewayAdapter } from "@band-ai/sdk";

const adapter = new A2AGatewayAdapter({ gatewayPort: 10000 });
```

### Key files

| Purpose | Path |
|---|---|
| A2A Adapter | `packages/sdk/src/adapters/a2a/A2AAdapter.ts` |
| A2A Adapter types | `packages/sdk/src/adapters/a2a/types.ts` |
| A2A Gateway Adapter | `packages/sdk/src/adapters/a2a-gateway/A2AGatewayAdapter.ts` |
| A2A Gateway server | `packages/sdk/src/adapters/a2a-gateway/server.ts` |

## ACP (Agent Client Protocol) Integration

ACP enables editors (Zed, Cursor, JetBrains, Neovim) to communicate with AI agents via JSON-RPC over stdio. The SDK provides both server and client sides.

### Architecture

Two-layer pattern (mirrors A2A Gateway):

| Layer | Server Side | Client Side |
|-------|-------------|-------------|
| Protocol | `ACPServer` (JSON-RPC handler) | spawned ACP subprocess |
| Platform Bridge | `BandACPServerAdapter` | `ACPClientAdapter` |

- **Server**: Editor → ACP → `ACPServer` → `BandACPServerAdapter` → Band REST/WS → peers
- **Client**: Band room message → `ACPClientAdapter` → that room's `ACPRoomAgent` → its own spawned subprocess (Codex, Claude Code, etc.), run in `<cwd>/.band-workspaces/<roomId>`

### Key files (under `packages/sdk/src/adapters/acp/`)

| File | Purpose |
|------|---------|
| `ACPServer.ts` | JSON-RPC handler exposing the ACP Agent surface |
| `BandACPServerAdapter.ts` | REST client + room/session mapping |
| `ACPClientAdapter.ts` | Public adapter: routes each room to its own `ACPRoomAgent` |
| `ACPRoomAgent.ts` | One room's ACP subprocess, session, and Band MCP server |
| `../shared/roomScopedAdapter.ts` | Per-room engine lifecycle shared with Cursor and Codex |
| `../shared/roomWorkspace.ts` | Per-room workspace layout and claims |

### Optional Dependency

```bash
pnpm add @agentclientprotocol/sdk
```

## MCP Support

Two MCP entry points:

- `@band-ai/sdk/mcp`: generic MCP registrations + stdio/SSE/server backends. Use `createBandMcpBackend`, `buildRoomScopedRegistrations`, `buildSingleContextRegistrations`. No Claude-specific dependency required.
- `@band-ai/sdk/mcp/claude`: bridge for the Claude Agent SDK. `createBandSdkMcpServer(options)` returns an in-process MCP server compatible with `@anthropic-ai/claude-agent-sdk`.

Room-scoped registrations give every tool a required `room_id`. Passing `roomlessTools` registers the tools outside `ROOM_TOOL_NAMES` without `room_id`, running on that instance.

Schema conversion uses Zod (`packages/sdk/src/mcp/zod.ts`). Tools exposed over MCP are prefixed with `mcp__band__`.

## Linear Integration

`@band-ai/sdk/linear` (re-exports from `packages/sdk/src/integrations/linear/`) ships a complete Linear ↔ Band PM bridge:

- `createLinearTools(...)`: Linear-specific agent tools (issues, comments, statuses)
- `createLinearWebhookHandler(...)`: Express-compatible webhook handler
- `createInlineLinearBridgeDispatcher`, `createInProcessLinearBridgeDispatcher`: dispatch strategies
- `createLinearBridgeRuntime(...)`: unified runtime for Linear ↔ Band
- `createSqliteSessionRoomStore(dbPath)`: persistent session-room mapping
- `StaleSessionGuard`: detects abandoned sessions
- Helpers for activity tracking, message conversion, notification handling

A complete reference application lives in `packages/sdk/examples/linear-band/` (run with `pnpm dev:linear` from `packages/sdk/`).

## Code Structure

```
packages/sdk/src/
├── agent/             # Agent.create() entry point
├── adapters/          # Framework adapters (one folder per framework, plus GenericAdapter.ts at top level)
│   ├── tool-calling/  # ToolCallingAdapter base + ToolCallingModel interface
│   ├── opencode/      # OpencodeAdapter; replies (reply grammar + routing), messages (decision texts)
│   └── shared/        # conversationPrompt, history, coercion utilities; decisions (thin wrapper over band-sdk-core's DecisionRegistry: payloads, timers, waits)
├── client/rest/       # FernRestAdapter, RestFacade, pagination, REST types
├── config/            # YAML and env-var config loaders
├── contracts/         # Protocols, DTOs, capabilities, chatEvents (CHAT_EVENT_TYPES), toolSchemas (TOOL_MODELS)
├── converters/        # History converters per framework
├── core/              # SimpleAdapter, Logger, errors, base classes
├── integrations/      # Deep integrations (currently: linear/)
├── linear/            # Subpath barrel for @band-ai/sdk/linear
├── mcp/               # Generic MCP + Claude SDK MCP bridge
├── platform/          # BandLink (WS+REST), PlatformEvent, Phoenix Channels transport, SubscriptionManager (internal)
├── rest/              # Subpath barrel for @band-ai/sdk/rest
├── runtime/           # PlatformRuntime, ExecutionContext, Execution, ContactEventHandler
│   ├── tools/         # AgentTools, ContactToolsImpl, ContactCallbackTools, customTools
│   ├── preprocessing/ # DefaultPreprocessor
│   ├── prompts/       # System-prompt building (base, memory, templates)
│   └── rooms/         # AgentRuntime
├── testing/           # FakeAgentTools, StubRestApi
├── types/             # Ambient type shims (google-adk.d.ts, ws.d.ts)
└── index.ts           # Main barrel export
```

## Runtime Lifecycle

`Agent`, `PlatformRuntime`, `AgentRuntime`, and `Execution` each keep their lifecycle in **one**
discriminated-union field (`packages/sdk/src/runtime/lifecycle.ts`), read publicly via a `state`
getter. Do not reintroduce parallel booleans (`started`, `running`, `stopping`, …) — they are what
made illegal combinations reachable and stranded shutdown on error paths.

| Type | Used by | States |
|---|---|---|
| `RuntimeLifecycleState` | `Agent`, `PlatformRuntime`, `AgentRuntime` | `not_started`, `starting`, `running`, `stopping`, `stopped`, `failed` |
| `ExecutionLifecycleState` | `Execution` | `running`, `stopping`, `stopped` (carries `graceful`), `failed` |

```text
not_started ─▶ starting ─▶ running ─▶ stopping ─▶ stopped
                   │          │           │           │
                   └──────────┴───────────┴──▶ failed │
                                                 │    │
                        starting ◀───────────────┴────┘
```

Rules:

- Every transition goes through `LifecycleTracker.transition()`, which validates it against
  `isLegalRuntimeTransition` / `isLegalExecutionTransition`. Both read a `Record` keyed by the full
  status union, so adding a state without adding its row fails `pnpm typecheck`.
- `stopped` and `failed` are re-startable for the three runtime owners; `Execution` is terminal.
- `start()` while a `stop()` is in flight rejects with `RuntimeStateError`.
- `stop()` while a `start()` is in flight **supersedes** that start for `Agent` and
  `PlatformRuntime`: it tears down what the start had already claimed and returns, and the start
  aborts at its next checkpoint with `RuntimeStateError` instead of installing a live runtime
  behind the completed teardown. It does not queue behind the start — several adapters only
  abandon a parked `onStarted()` once `onRuntimeStop()` runs, so a stop that waited would be
  waiting on itself. `AgentRuntime.stop()` does wait for its own start, since it drives no
  third-party adapter that can park indefinitely.
- "Was I superseded?" is asked through the lifecycle, not a second counter beside it: a start
  captures the `"starting"` state instance `startWithGate()` installed and later checks
  `LifecycleTracker.isCurrent()`. Every accepted transition installs a fresh frozen state, so this
  distinguishes "still my start" from "a replacement start is now running", which a bare status
  comparison cannot.
- Teardown steps are isolated from each other: one room's failing `Execution.stop()` never skips
  the remaining rooms, the map clearing, or `link.disconnect()`. Failures are collected and
  rethrown together (a single distinct error is rethrown as-is, keeping error identity intact).
- Concurrent `start()`/`stop()` calls join the in-flight operation and mirror its outcome,
  including the identical `Error` instance on failure. `stop()` never returns `true` for teardown
  it did not perform.
- `stop()` on an owner whose state is `failed` with nothing left to tear down rejects with the
  recorded error rather than resolving `true` — a `true` that contradicts `state` is the same
  masked-success bug in a narrower window.
- `Execution.enqueue()` after `stop()` rejects with `RuntimeStateError` instead of silently
  queueing into a queue nothing will read.
- `ExecutionState` in `ExecutionContext.ts` (`"starting" | "idle" | "processing"`) is a *per-turn
  activity* indicator, not a lifecycle. Keep the two vocabularies non-overlapping.

## Testing Structure

```
packages/sdk/tests/
├── *.test.ts          # Unit tests (per adapter, runtime, tools, MCP, Linear, etc.)
├── baseline/          # Live baseline E2E: adapter registry, toolkit, scenarios, scorecard
└── integration/       # Runnable scripts (the core bundler check) and shared live-platform plumbing
```

- Test runner: `vitest` (with v8 coverage via `@vitest/coverage-v8`)
- Live E2E is the baseline suite: `pnpm run test:baseline-live`, never part of the default `vitest run`.
  See `packages/sdk/tests/baseline/README.md` for how to run it and write a scenario
- See `packages/sdk/tests/README.md` for the test layout and the remaining scripts

## Commands

Run from the repository root unless a command says otherwise. Root `pnpm test`
and `pnpm typecheck` build the SDK first; directly filtered tests do not.
Build first for declaration/consumer proofs or downstream package checks:

```bash
# Install dependencies (root, monorepo-aware)
pnpm install --frozen-lockfile

# Build SDK output for directly filtered consumer/package checks
pnpm build:sdk

# Run unit tests (all packages, or only SDK)
pnpm test
pnpm --filter @band-ai/sdk test

# Run a single test file
pnpm --filter @band-ai/sdk exec vitest run path/to/file.test.ts

# Coverage
pnpm --filter @band-ai/sdk run coverage

# Type-check (no emit)
pnpm typecheck

# Lint
pnpm -r lint

# Build (tsup; emits ESM + CJS + .d.ts to dist/)
pnpm -r build

# Linear bridge example
pnpm --filter @band-ai/sdk run dev:linear
```

## Subpath Builds

`packages/sdk/tsup.config.ts` and `packages/sdk/package.json#exports` own the
entry/output mappings for ESM, CJS, and declarations. Names need not match the
import subpath (`mcp/claude` maps to `mcp-claude`). Add a new subpath by:

1. Creating an entry barrel under `packages/sdk/src/<name>/index.ts`
2. Adding the entry to `tsup.config.ts`
3. Adding the `./<name>` export to `packages/sdk/package.json#exports`

## Environment Variables

The SDK reads the `BAND_*` prefix by default, with a per-field fallback to the
legacy `THENVOI_*` variable (Band wins independently for each field; each legacy
variable used emits a one-time, non-secret deprecation warning). Override the
prefix via `loadAgentConfigFromEnv({ prefix })`; a custom prefix — including an
empty string — is used exactly, with no fallback.

- `BAND_AGENT_ID` (legacy `THENVOI_AGENT_ID`): agent UUID (required)
- `BAND_API_KEY` (legacy `THENVOI_API_KEY`): agent API key (required)
- `BAND_WS_URL` (legacy `THENVOI_WS_URL`): WebSocket base URL (optional; default: `wss://app.band.ai/api/v1/socket` — the `phoenix` lib appends `/websocket`)
- `BAND_REST_URL` (legacy `THENVOI_REST_URL`): REST API URL (optional; derived from the WS URL if not set, via `deriveDefaultRestUrl`)

LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, etc.) are read directly by the underlying provider SDKs and passed via adapter options. For Gemini, `@google/genai` accepts both `GOOGLE_API_KEY` and `GEMINI_API_KEY` (it prefers `GOOGLE_API_KEY` if both are set; verified in `@google/genai`'s `getApiKeyFromEnv`, peer range `>=1.44.0`).

## Adding a New Framework Adapter

Use [band-add-framework-adapter](.claude/skills/band-add-framework-adapter/SKILL.md)
for research, planning, registration and verification. Keep the TS constructor
pattern `new <Framework>Adapter(options)` with a named options interface,
optional framework peers, import isolation, central turn judgment, and explicit
room/resource ownership. Register turn-outcome tests and supported baseline
capabilities in the existing TS registries.

## Example Files (`packages/sdk/examples/`)

Each example is a standalone TypeScript script runnable with `tsx`. Folders include: `basic`, `openai`, `anthropic`, `gemini`, `claude-sdk`, `codex`, `langgraph`, `letta`, `parlant`, `custom-adapter`, `a2a-bridge`, `a2a-gateway`, `linear-band`.

> Note: the `vercel-ai-sdk`, `google-adk`, and `opencode` adapters ship without dedicated example folders today. Mirror an existing example (e.g., `examples/anthropic/`) when adding one.

### Conventions

- Use `loadAgentConfig("agent_name")` (YAML) or `loadAgentConfigFromEnv()` (env vars). Never read `BAND_AGENT_ID`/`BAND_API_KEY` directly via `process.env`.
- Throw `ValidationError` (from `@band-ai/sdk/core`) for missing required configuration; do **not** `console.error` + `process.exit`.
- Top-level `await` is fine; the package is ESM (`"type": "module"`).
- Examples are excluded from strict ESLint rules but still typechecked.

## Coding and Test Standards

Read [band-typescript-conventions](.claude/skills/band-typescript-conventions/SKILL.md)
for API design, typing, errors, logging, comments and package boundaries, and
[band-typescript-test-conventions](.claude/skills/band-typescript-test-conventions/SKILL.md)
for test design and coverage. Keep functions focused and reuse existing sources
of truth. Meaningful assertions and realistic complex flows matter more than
counts or percentages.

Prove ordering with explicit synchronization and confirmed completion; fixed
sleeps and elapsed wall time are not evidence. Use controlled clocks for
expiry/deadlines, keeping real process/network readiness independent. Cleanup
must cover failed or cancelled startup and release owned resources completely.

## External Research & Code Reuse

Verify external behavior in current primary documentation and the source of the
released version actually used. Before hand-rolling a nontrivial mechanism,
look for an established library and existing repository helpers. Verify the
needed capability and compatibility with package engines, optional peers,
module formats, and consumers; a plausible API name is not evidence.

## Pre-Commit Checklist

Reread the diff against the relevant conventions before selecting checks.
Look for duplicated policies or magic values, unnecessary indirection, and
assertions that do not prove the intended behavior. Linters alone cannot
establish these properties.

Choose validation for the affected behavior. Explicit user limits take
precedence; report unrun checks instead of implying they passed.

| Change | Local validation |
|---|---|
| Documentation or skill instructions only | Check links, frontmatter, referenced paths/commands, and relevant workflow scenarios. Validate changed runnable examples where applicable. Do not run the SDK suite or wait for CI solely for prose changes. |
| Executable skill helpers, examples, or scripts | Run relevant behavioral checks in their actual Node/package environment; executable helpers are code, even inside a skill. |
| Localized TypeScript source or tests | Run affected lint, type checks and behavioral tests; build SDK output first when consumer proofs need it. Broaden for affected callers. |
| Shared runtime/protocol behavior, dependencies, packaging, or broad refactors | Run the full workspace gate below plus relevant ESM/CJS, declaration, optional-peer/import isolation, downstream plugin and boundary/live checks. |
| CI or release workflows | Run applicable workflow guards and actionlint; see `docs/ci-cd-workflows.md`. Run release-hardening checks for changes to `.github/`, `scripts/`, or release configuration. Avoid publishing during probes. |

Mixed changes use the union of applicable checks. Do not repeat a passing gate
without new relevant changes or evidence. Required remote checks and approvals
remain merge gates.

Full workspace gate (not required for prose-only changes):

```bash
pnpm -r lint
pnpm typecheck
pnpm test
```

Use the affected package manifests and `.github/workflows/ci.yml` for additional
packaging/consumer commands. Root typecheck/test build the SDK first. Isolate
installs and build output from concurrent workers; never stash their work.

## Commit & PR Titles

Commit subjects and PR titles follow Conventional Commits: `type(scope): subject`. Every PR is squash-merged through the merge queue, so the PR title becomes the commit Release Please reads, and CI checks it (`Validate PR Title`).

- Allowed `type` and `scope` values are the `types:` and `scopes:` lists in `.github/workflows/pr-title.yml`. That file is the single source of truth. Read it before writing a title, and use only the values it lists.
- The scope is optional. If no listed scope fits, omit it (`fix: …`). Never invent one from a directory, class, or module name.
- The subject, the text after `type(scope): `, is at most 80 characters.
- Mark a breaking change with `!` after the scope: `feat(adapters)!: …`.

## Pull Request Descriptions

Use only **Why**, **What**, and **Scope** sections. Explain the problem, final
behavior and boundaries for a reviewer without chat context. Keep the body
current; avoid appended checklists, progress logs or a testing section. Record
validation and unresolved failures in the linked Linear issue or an evidence
attachment linked from the PR. A Linear ticket is not required for every
ordinary branch; follow `CONTRIBUTING.md` and use the branch skill for Linear work.

## PR Lifecycle and Readiness Review

Open new PRs as **drafts**. A draft is the place to share work in progress,
seek early design feedback, and expose unfinished validation. Mark it ready
for review only after the developer's readiness review passes. Ready means
the author has completed the engineering work and considers it fit for peer
review; it does not mean peers have approved it or that it is mergeable.

The readiness review checks the actual diff and relevant existing tests:

- **Problem understood:** a bug has a supported root-cause explanation and
  failure scenario; a feature has a clear underlying need and design rationale.
  Do not invent a root cause for documentation or mechanical changes.
- **Solution planned:** the approach, owning layer, scope, compatibility, and
  expected scenarios were considered before implementation. A small change
  may need a short explanation; complex or cross-component work needs a
  written plan. Reconcile the final implementation with that plan.
- **Implementation complete:** the diff solves the cause or need at its
  authoritative boundary, is focused and maintainable, and has no known
  blocking defects or unfinished in-scope work hidden as follow-ups.
- **Coverage meaningful:** apply the test-conventions skill's "Coverage and
  realistic flows" guidance. Map important scenarios to assertions, include
  relevant complex interactions and failure/recovery paths, and close material
  in-scope gaps. Passing tests and coverage percentages alone are insufficient.
- **Validation evidenced:** the applicable author checks from the Pre-Commit
  Checklist passed for the implementation being reviewed. Record the reviewed
  head, checks and outcomes, scenario coverage, and material limitations in
  the linked Linear issue or evidence attachment. Reuse earlier results only
  when subsequent changes do not affect what they prove. Keep the PR body in
  the existing Why / What / Scope format.

If a criterion fails or required author validation is blocked or unrun, keep
the PR in draft and state what remains. Do not replace evidence with a
checklist assertion. After substantive changes or a newly discovered blocking
defect, reassess readiness and return the PR to draft when the criteria no
longer hold; an ordinary reviewer suggestion alone does not invalidate it.

This repo starts its main CI jobs on `ready_for_review`, so green CI is not a
prerequisite for leaving draft. Applicable author validation must still pass;
CI pending after promotion is not a claimed pass and all required checks and
approvals remain merge gates. If an essential scenario can only be validated
in CI, use an authorized draft-compatible run or keep the PR in draft.

This review is an author responsibility, not a requirement to invoke the full
publishing code-review skill. A cheap PR triage verdict cannot substitute for
it. Agents should use `gh pr create --draft` when PR creation is authorized;
promote with `gh pr ready <pr>` only after the review passes and the task
authorizes that transition. Do not change unrelated PRs' stages or treat
readiness as permission to merge. See the
[GitHub stage documentation](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request).

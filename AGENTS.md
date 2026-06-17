# Thenvoi TypeScript SDK

This is a TypeScript SDK that connects AI agents to the Thenvoi collaborative platform.

## Core Features

1. Multi-framework support (OpenAI, Anthropic, Gemini, Claude Agent SDK, Codex, LangGraph, Vercel AI SDK, Google ADK, Letta, OpenCode, Parlant, plus a Generic adapter)
2. A2A protocol support: bridge to external A2A agents and expose Thenvoi peers as A2A endpoints (`A2AAdapter`, `A2AGatewayAdapter`)
3. ACP integration: editor-facing server (`ACPServer` + `ThenvoiACPServerAdapter`) and subprocess client (`ACPClientAdapter`) for Cursor, Codex, Claude Code, Zed
4. MCP support: generic MCP backends (stdio/SSE) and a Claude Agent SDK bridge under `@thenvoi/sdk/mcp` and `@thenvoi/sdk/mcp/claude`
5. Linear integration: full PM bridge with tools, webhook handling, dispatchers, and SQLite session room store (`@thenvoi/sdk/linear`)
6. Platform tools for chat, contacts, and memory management
7. WebSocket + REST transport: real-time messaging via Phoenix Channels with REST API fallback

## Package & Subpath Exports

The SDK ships from `@thenvoi/sdk` with multiple ESM/CJS subpath entries.

| Import | Contents |
|--------|----------|
| `@thenvoi/sdk` | `Agent`, adapters, config loaders, runtime, core types |
| `@thenvoi/sdk/adapters` | Adapter classes and helper types (e.g., `CodexAppServerStdioClient`, `ToolCallingModel`) |
| `@thenvoi/sdk/config` | `loadAgentConfig`, `loadAgentConfigFromEnv` (also re-exported from root) |
| `@thenvoi/sdk/core` | `SimpleAdapter`, `Logger`, error classes, base protocols |
| `@thenvoi/sdk/converters` | History converters per framework |
| `@thenvoi/sdk/runtime` | Runtime internals (room presence, execution context, agent tools) |
| `@thenvoi/sdk/rest` | `FernRestAdapter`, `RestFacade`, REST API types, pagination helpers |
| `@thenvoi/sdk/testing` | `FakeAgentTools`, stub REST API, test utilities |
| `@thenvoi/sdk/linear` | Linear tools plus bridge runtime, webhook handler, dispatchers, session room store |
| `@thenvoi/sdk/mcp` | Generic MCP registrations and HTTP/SSE/stdio backends without Claude-specific dependencies |
| `@thenvoi/sdk/mcp/claude` | Claude Agent SDK MCP bridge (`createThenvoiSdkMcpServer`) |

Adapters' upstream LLM SDKs are declared as **optional peer dependencies**. Install only the ones you use (e.g., `pnpm add @anthropic-ai/sdk` to use `AnthropicAdapter`).

## Platform Tools

### Chat Tools
- `thenvoi_send_message`: send a message to the chat room (requires at least one `@mention`)
- `thenvoi_send_event`: send a non-message event (`thought`, `error`, `task`, etc.)
- `thenvoi_add_participant`: add agent/user to room by name (use `thenvoi_lookup_peers` first)
- `thenvoi_remove_participant`: remove participant from room
- `thenvoi_get_participants`: list room participants
- `thenvoi_lookup_peers`: find agents/users available to add
- `thenvoi_create_chatroom`: create a new chat room (optional `task_id`)

### Contact Tools
- `thenvoi_list_contacts`: list contacts with pagination
- `thenvoi_add_contact`: send a contact request
- `thenvoi_remove_contact`: remove an existing contact (by handle or contact id)
- `thenvoi_list_contact_requests`: list received and sent contact requests
- `thenvoi_respond_contact_request`: approve, reject, or cancel a contact request

### Memory Tools
- `thenvoi_list_memories`: query stored memories with filters (scope, system, type, segment, content_query, status)
- `thenvoi_store_memory`: store a new memory (content, system, type, segment, scope, optional `subject_id`, metadata)
- `thenvoi_get_memory`: retrieve a specific memory by id
- `thenvoi_supersede_memory`: soft-delete an outdated memory (keeps audit trail)
- `thenvoi_archive_memory`: archive a memory (hide but preserve)

Tool schemas live in `packages/sdk/src/runtime/tools/schemas.ts` (`TOOL_MODELS`). They are registered automatically on the adapter via `AgentTools` and exposed through MCP with the `mcp__thenvoi__` prefix (`MCP_TOOL_PREFIX`).

## REST Client API Pattern

REST is wrapped around the Fern-generated `@thenvoi/rest-client`. `FernRestAdapter` and `RestFacade` expose a **flat** method surface you reach via `link.rest`:

```ts
// Pattern: link.rest.<method>(...)
await link.rest.createChatMessage(roomId, { content, mentions });
await link.rest.createChatEvent(roomId, { content, messageType: "thought" });
await link.rest.listContacts({ page, pageSize });
await link.rest.listMemories({ subject_id });
await link.rest.getAgentMe();
```

Memory list args use snake_case (`subject_id`, `content_query`, `page_size`, `status`) because the wire DTOs preserve the API's snake_case names — see `WireListMemoriesArgs` in `packages/sdk/src/contracts/dtos.ts`. Other args are camelCase.

The full method set is the union `ThenvoiLinkRestApi = AgentProfileRestApi & MessageLifecycleRestApi & AgentToolsRestApi & ChatListingRestApi` (`packages/sdk/src/client/rest/types.ts`), covering: agent profile (`getAgentMe`), chat messaging (`createChatMessage`, `createChatEvent`, `createChat`, `listChats`, `getChatContext`), participants (`listChatParticipants`, `addChatParticipant`, `removeChatParticipant`), message lifecycle (`markMessageProcessing`, `markMessageProcessed`, `markMessageFailed`, `listMessages`, `getNextMessage`), contacts (`addContact`, `removeContact`, `respondContactRequest`, `listContacts`, `listContactRequests`), memory (`storeMemory`, `getMemory`, `supersedeMemory`, `archiveMemory`, `listMemories`), and peers (`listPeers`). Pagination helpers live in `packages/sdk/src/client/rest/pagination.ts`.

## WebSocket Channels & Events

WebSocket transport is Phoenix Channels (`packages/sdk/src/platform/streaming/PhoenixChannelsTransport.ts`). Default base URL: `wss://app.thenvoi.com/api/v1/socket` (the `phoenix` JS lib appends `/websocket` to form the actual WS endpoint — set `THENVOI_WS_URL` to the base URL, not the `/websocket` URL).

### Channels (Phoenix Channels Protocol V2)

| Channel | Topic Format | Events |
|---------|--------------|--------|
| Agent Rooms | `agent_rooms:{agent_id}` | `room_added`, `room_removed`, `room_deleted` |
| Chat Room | `chat_room:{chat_room_id}` | `message_created` |
| Room Participants | `room_participants:{chat_room_id}` | `participant_added`, `participant_removed` |
| Agent Contacts | `agent_contacts:{agent_id}` | `contact_request_received`, `contact_request_updated`, `contact_added`, `contact_removed` |

### Event Types

All events share the shape `{ type, roomId, payload, raw? }` (see `packages/sdk/src/platform/events.ts`). Payload types are validated with Zod schemas in `packages/sdk/src/platform/streaming/payloadSchemas.ts`.

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
  | ContactRemovedEvent;

type ContactEvent =
  | ContactRequestReceivedEvent
  | ContactRequestUpdatedEvent
  | ContactAddedEvent
  | ContactRemovedEvent;
```

`ThenvoiLink` is `AsyncIterable<PlatformEvent>`; `PlatformRuntime` consumes it and dispatches to the correct `ExecutionContext` per room.

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
import { Agent, type ContactEventConfig } from "@thenvoi/sdk";

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

`A2AAdapter` forwards Thenvoi messages to an external A2A-compliant agent. Each Thenvoi room maps to an A2A context, with automatic session-state persistence via task events and session rehydration on room rejoin.

```ts
import { Agent, A2AAdapter, type A2AAuth } from "@thenvoi/sdk";

const adapter = new A2AAdapter({
  remoteUrl: "http://localhost:10000",
  streaming: true,
  auth: { apiKey: "..." } satisfies A2AAuth, // optional
});
```

### A2A Gateway (inbound)

`A2AGatewayAdapter` exposes Thenvoi peers as A2A JSON-RPC endpoints over a built-in Express server. External A2A clients can send messages to Thenvoi agents through the gateway, with `contextId` preservation (same `contextId` = same chat room) and SSE streaming responses.

```ts
import { Agent, A2AGatewayAdapter } from "@thenvoi/sdk";

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
| Platform Bridge | `ThenvoiACPServerAdapter` | `ACPClientAdapter` |

- **Server**: Editor → ACP → `ACPServer` → `ThenvoiACPServerAdapter` → Thenvoi REST/WS → peers
- **Client**: Thenvoi room message → `ACPClientAdapter` → spawned subprocess (Codex, Claude Code, etc.)

### Key files (under `packages/sdk/src/adapters/acp/`)

| File | Purpose |
|------|---------|
| `ACPServer.ts` | JSON-RPC handler exposing the ACP Agent surface |
| `ThenvoiACPServerAdapter.ts` | REST client + room/session mapping |
| `ACPClientAdapter.ts` | Spawns external ACP agent subprocess |

### Optional Dependency

```bash
pnpm add @agentclientprotocol/sdk
```

## MCP Support

Two MCP entry points:

- `@thenvoi/sdk/mcp`: generic MCP registrations + stdio/SSE/server backends. Use `createThenvoiMcpBackend`, `buildRoomScopedRegistrations`, `buildSingleContextRegistrations`. No Claude-specific dependency required.
- `@thenvoi/sdk/mcp/claude`: bridge for the Claude Agent SDK. `createThenvoiSdkMcpServer(options)` returns an in-process MCP server compatible with `@anthropic-ai/claude-agent-sdk`.

Schema conversion uses Zod (`packages/sdk/src/mcp/zod.ts`). Tools exposed over MCP are prefixed with `mcp__thenvoi__`.

## Linear Integration

`@thenvoi/sdk/linear` (re-exports from `packages/sdk/src/integrations/linear/`) ships a complete Linear ↔ Thenvoi PM bridge:

- `createLinearTools(...)`: Linear-specific agent tools (issues, comments, statuses)
- `createLinearWebhookHandler(...)`: Express-compatible webhook handler
- `createInlineLinearBridgeDispatcher`, `createInProcessLinearBridgeDispatcher`: dispatch strategies
- `createLinearBridgeRuntime(...)`: unified runtime for Linear ↔ Thenvoi
- `createSqliteSessionRoomStore(dbPath)`: persistent session-room mapping
- `StaleSessionGuard`: detects abandoned sessions
- Helpers for activity tracking, message conversion, notification handling

A complete reference application lives in `packages/sdk/examples/linear-thenvoi/` (run with `pnpm dev:linear` from `packages/sdk/`).

## Code Structure

```
packages/sdk/src/
├── agent/             # Agent.create() entry point
├── adapters/          # Framework adapters (one folder per framework, plus GenericAdapter.ts at top level)
│   ├── tool-calling/  # ToolCallingAdapter base + ToolCallingModel interface
│   └── shared/        # conversationPrompt, history, coercion utilities
├── client/rest/       # FernRestAdapter, RestFacade, pagination, REST types
├── config/            # YAML and env-var config loaders
├── contracts/         # Protocols, DTOs, capabilities, chatEvents (CHAT_EVENT_TYPES)
├── converters/        # History converters per framework
├── core/              # SimpleAdapter, Logger, errors, base classes
├── integrations/      # Deep integrations (currently: linear/)
├── linear/            # Subpath barrel for @thenvoi/sdk/linear
├── mcp/               # Generic MCP + Claude SDK MCP bridge
├── platform/          # ThenvoiLink (WS+REST), PlatformEvent, Phoenix Channels transport
├── rest/              # Subpath barrel for @thenvoi/sdk/rest
├── runtime/           # PlatformRuntime, ExecutionContext, Execution, ContactEventHandler
│   ├── tools/         # AgentTools, ContactToolsImpl, ContactCallbackTools, schemas
│   ├── preprocessing/ # DefaultPreprocessor
│   └── rooms/         # AgentRuntime
├── testing/           # FakeAgentTools, StubRestApi
└── index.ts           # Main barrel export
```

## Testing Structure

```
packages/sdk/tests/
├── *.test.ts          # Unit tests (per adapter, runtime, tools, MCP, Linear, etc.)
└── integration/       # Integration & e2e harnesses (runnable scripts)
```

- Test runner: `vitest` (with v8 coverage via `@vitest/coverage-v8`)
- Integration tests under `tests/integration/` are runnable scripts, not in the default `vitest run` set
- See `packages/sdk/tests/README.md` for the current harness list and how to run each one

## Commands

Run from the repo root or `packages/sdk/`:

```bash
# Install dependencies (root, monorepo-aware)
pnpm install

# Run unit tests (all packages from root, sdk only from packages/sdk)
pnpm -r test
pnpm --filter @thenvoi/sdk test

# Run a single test file
pnpm --filter @thenvoi/sdk exec vitest run path/to/file.test.ts

# Coverage
pnpm --filter @thenvoi/sdk run coverage

# Type-check (no emit)
pnpm -r typecheck

# Lint
pnpm -r lint

# Build (tsup; emits ESM + CJS + .d.ts to dist/)
pnpm -r build

# Linear bridge example
pnpm --filter @thenvoi/sdk run dev:linear
```

## Subpath Builds

`packages/sdk/tsup.config.ts` defines the entry points; each subpath in `package.json#exports` maps to its own `dist/<name>.{js,cjs,d.ts}`. Add a new subpath by:

1. Creating an entry barrel under `packages/sdk/src/<name>/index.ts`
2. Adding the entry to `tsup.config.ts`
3. Adding the `./<name>` export to `packages/sdk/package.json#exports`

## Environment Variables

The SDK reads only the `THENVOI_*` prefix by default (override via `loadAgentConfigFromEnv({ prefix })`).

- `THENVOI_AGENT_ID`: agent UUID (required)
- `THENVOI_API_KEY`: agent API key (required)
- `THENVOI_WS_URL`: WebSocket base URL (optional; default: `wss://app.thenvoi.com/api/v1/socket` — the `phoenix` lib appends `/websocket`)
- `THENVOI_REST_URL`: REST API URL (optional; derived from `THENVOI_WS_URL` if not set, via `deriveDefaultRestUrl`)

LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, etc.) are read directly by the underlying provider SDKs and passed via adapter options. For Gemini, `@google/genai` accepts both `GOOGLE_API_KEY` and `GEMINI_API_KEY` (it prefers `GOOGLE_API_KEY` if both are set; verified in `@google/genai` 1.50.x `getApiKeyFromEnv`).

## Adding a New Framework Adapter

When adding a new adapter, follow this workflow. Use the lowercase module name (e.g. `openai`, `gemini`) and derive the PascalCase class prefix (e.g. `OpenAI`, `Gemini`).

### Phase 1: Scaffold Source Files

1. Create the adapter folder at `packages/sdk/src/adapters/<framework>/` with at minimum:
   - `<Framework>Adapter.ts`: class extending `SimpleAdapter` (most adapters) or `ToolCallingAdapter` (LLMs that call platform tools as function calls)
   - `index.ts`: barrel export
   - `types.ts` (optional): adapter-specific option interfaces
2. If a history converter is needed, add `packages/sdk/src/converters/<framework>.ts` and re-export from `converters/index.ts`.
3. Add the upstream SDK as an **optional peer dependency** in `packages/sdk/package.json` (`peerDependencies` + `peerDependenciesMeta.<pkg>.optional = true`). Do not add it to `dependencies`.

### Phase 2: Wire Up Exports

1. Re-export the adapter and option types from `packages/sdk/src/adapters/index.ts` and `packages/sdk/src/index.ts`.
2. If the adapter has a dedicated subpath, add an entry in `tsup.config.ts` and `package.json#exports`.

### Phase 3: Implement the Adapter

- For `ToolCallingAdapter`: implement a `ToolCallingModel` that converts the platform `TOOL_MODELS` into the framework's tool-call format, executes the LLM call, and returns tool calls/results.
- For `SimpleAdapter`: implement `onMessage(message, tools)` directly. Use `tools.sendMessage`, `tools.sendEvent`, etc.
- Honour `agent_name` and own-agent filtering when converting history.
- Reuse helpers from `packages/sdk/src/adapters/shared/` (`conversationPrompt`, `history`, `coercion`, `lazyAsyncValue`).

### Phase 4: Tests

- Unit tests at `packages/sdk/tests/<framework>-adapter.test.ts` covering: invocation flow, tool execution, error handling, custom tools, history conversion edge cases.
- Use `FakeAgentTools` from `@thenvoi/sdk/testing` to mock the platform side.
- Optionally add an integration smoke test under `tests/integration/`.

### Phase 5: Example

- Create `packages/sdk/examples/<framework>/<framework>-agent.ts` mirroring an existing example (e.g., `examples/anthropic/anthropic-agent.ts`).
- Use `loadAgentConfig("my_agent")` (YAML) or `loadAgentConfigFromEnv()` (env vars) for credentials, **not** direct `process.env` reads.

### Phase 6: Final Validation

```bash
pnpm --filter @thenvoi/sdk run lint
pnpm --filter @thenvoi/sdk run typecheck
pnpm --filter @thenvoi/sdk test
```

### Key Files Reference

| Purpose | Path |
|---|---|
| Adapter source | `packages/sdk/src/adapters/<framework>/` |
| History converter | `packages/sdk/src/converters/<framework>.ts` |
| Adapter barrel | `packages/sdk/src/adapters/index.ts` |
| Top-level barrel | `packages/sdk/src/index.ts` |
| Tool schemas | `packages/sdk/src/runtime/tools/schemas.ts` |
| Tool calling base | `packages/sdk/src/adapters/tool-calling/` |
| Test fakes | `packages/sdk/src/testing/FakeAgentTools.ts` |

## Example Files (`packages/sdk/examples/`)

Each example is a standalone TypeScript script runnable with `tsx`. Folders include: `basic`, `openai`, `anthropic`, `gemini`, `claude-sdk`, `codex`, `langgraph`, `letta`, `parlant`, `custom-adapter`, `a2a-bridge`, `a2a-gateway`, `linear-thenvoi`.

> Note: the `vercel-ai-sdk`, `google-adk`, and `opencode` adapters ship without dedicated example folders today. Mirror an existing example (e.g., `examples/anthropic/`) when adding one.

### Conventions

- Use `loadAgentConfig("agent_name")` (YAML) or `loadAgentConfigFromEnv()` (env vars). Never read `THENVOI_AGENT_ID`/`THENVOI_API_KEY` directly via `process.env`.
- Throw `ValidationError` (from `@thenvoi/sdk/core`) for missing required configuration; do **not** `console.error` + `process.exit`.
- Top-level `await` is fine; the package is ESM (`"type": "module"`).
- Examples are excluded from strict ESLint rules but still typechecked.

## Coding Standards

- TypeScript strict mode is on (`tsconfig.json`: `strict: true`, `verbatimModuleSyntax: true`, `forceConsistentCasingInFileNames: true`).
- ESM only for source (`type: "module"`); use `.js` extensions in import paths only when required (verbatim module syntax).
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
- No `any` in `src/` — `@typescript-eslint/no-explicit-any` is `error` for `src/**/*.ts` (relaxed for tests/examples).
- Prefer named exports; avoid default exports.
- All public adapter options use named interfaces (`<Framework>AdapterOptions`).
- Use the `Logger` interface from `@thenvoi/sdk/core` instead of `console.*` in library code (`console.warn`/`console.error` allowed only when there is no logger context).
- Validate external input at boundaries with Zod schemas (`packages/sdk/src/platform/streaming/payloadSchemas.ts` is the model).
- Never bundle peer dependencies — they must remain `external` in `tsup.config.ts`.
- Async/await everywhere; do not return raw promises from non-async functions in library code.
- Keep node compatibility at `>=22` (`engines.node` in both root and SDK package.json).

## Pre-Commit Checklist

```bash
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

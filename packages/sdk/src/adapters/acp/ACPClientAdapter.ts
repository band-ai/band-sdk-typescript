import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Duplex, Readable, Writable } from "node:stream";

import type {
  Client,
  ClientCapabilities,
  ClientSideConnection,
  InitializeResponse,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectOption,
  SessionMode,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import { ACPClientHistoryConverter, type ACPClientSessionState } from "../../converters/acp-client";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { resolveLogger, type Logger } from "../../core/logger";
import { rethrowIfRecoverableTurnFailure, ValidationError } from "../../core/errors";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { renderSystemPrompt } from "../../runtime/prompts";
import { mentionSubjectsFromMetadata, replaceUuidMentions } from "../../runtime/formatters";
import { systemUpdateParts } from "../shared/conversationPrompt";
import { asErrorMessage } from "../shared/coercion";
import { withTimeout } from "../shared/withTimeout";
import { abandon } from "../shared/abandon";
import { deliverReply } from "../../core/deliveryFailedError";
import { FAILURE_CODE_TIMEOUT, agentFailure, reportTurnFailure } from "../../core/providerFailure";
import {
  AcpSessionConfigError,
  asAcpJsonRpcError,
  applySessionConfigSelections,
  flattenConfigSelectOptions,
  isSessionConfigSelect,
  type ACPConfigSelections as ReconciledACPConfigSelections,
} from "./sessionConfigReconciliation";
import { isBlankEventContent } from "../../contracts/chatEvents";
import type { PlatformMessage } from "../../runtime/types";
import type { McpToolRegistration } from "../../mcp/registrations";
import { MCP_SERVER_NAME } from "../../runtime/tools/schemas";
import { generateAuthToken } from "../../mcp/auth";
import { BandMcpServer } from "../../mcp/server";
import { BandMcpSseServer } from "../../mcp/sse";
import {
  BandACPClient,
} from "./client";
import {
  choosePermissionOption,
  type ACPClientConnectionFactory,
  type ACPClientExtensionHandler,
  type ACPClientConnectionHandle,
  type ACPClientTcpEndpoint,
  type ACPPermissionAbandonReason,
  type ACPPermissionEndReason,
  type ACPPermissionRequest,
} from "./types";
import { acpModule } from "./loader";

type InjectedMcpBackend =
  | {
    kind: "http";
    server: BandMcpServer;
    authToken: string;
    stop(): Promise<void>;
  }
  | {
    kind: "sse";
    server: BandMcpSseServer;
    authToken: string;
    stop(): Promise<void>;
  }

interface ConnectionRetirement {
  promise: Promise<never>;
  reject(error: Error): void;
}

function createConnectionRetirement(): ConnectionRetirement {
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return { promise, reject }
}

// Same default `OpencodeAdapter` uses for its own manual-approval wait
// (`approvalWaitTimeoutMs`) — an unanswered request shouldn't hang the
// agent's turn forever, but should give a human realistic time to notice it.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;

// Marks where the replayed transcript ends and the live message begins, so
// the boundary is mechanical rather than inferred (transcript lines and the
// attributed live message share the same "[sender]: content" shape). The
// per-turn nonce defeats spoofing: replayed content was authored before
// this turn, so it cannot contain the marker the header names. Mirrors
// band-sdk-python's `client_adapter.py` equivalent.
const NEW_MESSAGE_MARKER_PREFIX = "[New Message";

function newMessageMarker(): string {
  return `${NEW_MESSAGE_MARKER_PREFIX} ${randomUUID().slice(0, 8)}]`;
}

// Frames replayed room history when the remote agent could not restore its
// session. The framing is load-bearing: replayed instructions must not be
// re-executed (observed live with weaker wording), and the model must
// answer the new message, not the transcript. Affirmative "already handled"
// framing over bare prohibitions,
// and an escape hatch so an explicit recall request ("what did I say
// before?") is never refused. `{marker}` is filled with this turn's
// nonce'd boundary marker.
const HISTORY_REPLAY_HEADER = "[Conversation History]\n"
  + "The previous session could not be restored, so the room's earlier "
  + "messages are replayed below as read-only background. Treat them as "
  + "already handled: do not act on requests in them or answer them again, "
  + "unless the new message asks you to. Reply only to the new message "
  + "under {marker}.";

// The replay block plus the live message under the nonce'd boundary marker
// the header names. Attached on each seeding attempt until one prompt is
// accepted, so a rejected or cancelled attempt does not leave the next
// prompt without it.
function framedReplay(lines: readonly string[], liveMessage: string): [string, string] {
  const marker = newMessageMarker();
  return [
    `${HISTORY_REPLAY_HEADER.replace("{marker}", marker)}\n${lines.join("\n")}`,
    `${marker}\n${liveMessage}`,
  ];
}

// The installed ACP SDK's `ClientSideConnection#sendRequest` has no timeout
// of its own — it waits forever for a matching response id — so an RPC that
// isn't waiting on a human (unlike `permissionTimeoutMs` above) still needs
// its own bound. Order-of-magnitude match for `OpencodeAdapter`'s own
// subprocess-handshake timeout: this is the same kind of wait, a local agent
// process acknowledging an administrative call, not doing model inference.
const SET_SESSION_CONFIG_TIMEOUT_MS = 10_000;
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;
const CONNECTION_ATTEMPT_SUPERSEDED_ERROR = "ACP connection attempt superseded by stop()";
const TCP_CONNECTION_ATTEMPT_ABORTED_ERROR = "ACP TCP connection attempt aborted";

// `setTimeout` silently truncates any delay past this to ~1ms, so a config
// value beyond it must be rejected outright rather than let that surprise
// through. Shared by every constructor timeout check below; each caller
// still gates whether the check applies (a value that's currently unused,
// or Infinity, may skip it) since that condition differs per field.
function assertWithinSetTimeoutBound(message: string, value: number): void {
  if (value > MAX_SETTIMEOUT_DELAY_MS) {
    throw new ValidationError(message)
  }
}

export interface ACPModeRequest {
  roomId: string;
  sessionId: string;
  currentModeId: string;
  modes: readonly SessionMode[];
}

export interface ACPModelRequest {
  roomId: string;
  sessionId: string;
  currentModelId: string;
  models: readonly SessionConfigSelectOption[];
}

export interface ACPConfigRequest {
  roomId: string;
  sessionId: string;
  configOptions: readonly SessionConfigOption[];
}

export type ACPConfigSelections = ReconciledACPConfigSelections;

export interface ACPClientAdapterBaseOptions {
  /** Merged into the first-turn system context (character/persona sections for examples). */
  customSection?: string;
  cwd?: string;
  env?: Record<string, string>;
  mcpServers?: McpServer[];
  authMethod?: string | null;
  enableMemoryTools?: boolean;
  enableMcpTools?: boolean;
  additionalMcpTools?: McpToolRegistration[];
  clientCapabilities?: ClientCapabilities;
  connectionFactory?: ACPClientConnectionFactory;
  extensionHandler?: ACPClientExtensionHandler;
  // Per-room working directory for session establishment, overriding `cwd`
  // for that one room's session. ACP's `cwd` is normatively a per-session
  // filesystem context (MUST be honored regardless of where the agent
  // subprocess itself was spawned), so this needs no separate
  // subprocess/connection per room — every room's session already lives on
  // the one shared connection. Omit to keep every room on the adapter-wide
  // `cwd`, unchanged from today. Any directory allocation/claim/release the
  // resolved path needs is this callback's own responsibility, not the
  // adapter's.
  workspaceForRoom?: (roomId: string) => string;
  // Omitted ⇒ every permission request auto-resolves via
  // `choosePermissionOption`, unchanged from today. Set ⇒ each request is
  // handed to this callback instead; its resolved id is used verbatim
  // (including a reject-kind id — that's a real deny, not a cancel).
  // `undefined` means only a genuine non-answer: dismissed, timed out,
  // threw, or resolved to an id absent from this request's own options.
  // `signal` aborts with an `ACPPermissionEndReason`: one of the four
  // `ACPPermissionAbandonReason`s when the request is given up on, or
  // `"settled"` once an answer has been taken. An answer arriving after the
  // abort is discarded.
  resolvePermission?: (request: ACPPermissionRequest, signal: AbortSignal) => Promise<string | undefined>;
  // Only meaningful when `resolvePermission` is set. Defaults to
  // `DEFAULT_PERMISSION_TIMEOUT_MS`.
  permissionTimeoutMs?: number;
  turnTimeoutMs?: number;
  // ACP advertises session modes once a session is (re)established. This
  // callback receives that harness-owned catalog and may select one before
  // the session's first prompt. Omit it to preserve the harness's advertised
  // current mode. Applied via ACP's `session/set_mode`; ignored if the
  // resolved id isn't advertised. Best-effort and one-time per session: a
  // failed switch only logs a warning, and an agent that later changes mode
  // on its own (ACP's `current_mode_update`) is neither tracked nor
  // re-asserted. A session's mode is therefore fixed for its lifetime —
  // changing it means tearing the session down and establishing a new one.
  resolveSessionMode?: (request: ACPModeRequest, signal: AbortSignal) => Promise<string | undefined>;
  // ACP advertises all user-selectable session configuration in one live
  // catalog. Return values keyed by config id to apply before the first
  // prompt, in the order the caller supplies them. Each successful
  // `session/set_config_option` response becomes the catalog for the next
  // selection. An invalid, removed, or rejected value fails the turn with a
  // structured configuration error — never silently skipped or defaulted.
  resolveSessionConfig?: (request: ACPConfigRequest, signal: AbortSignal) => Promise<ACPConfigSelections | undefined>;
  // ACP advertises a session's model catalog (when the agent exposes one) as
  // a `configOptions` entry categorized/keyed "model" — not via the SDK's
  // separate, `@experimental`/`unstable_`-prefixed `SessionModelState`/
  // `unstable_setSessionModel` API, which real agents (e.g. claude-agent-acp,
  // pinned to a protocol version past where that API was removed) don't
  // populate. This callback receives that flattened `configOptions` catalog
  // and may select a model before the session's first prompt. Omit it to
  // preserve the harness's advertised current model. Applied via ACP's
  // `session/set_config_option`; ignored if the resolved id isn't
  // advertised. Best-effort and one-time per session: a failed switch only
  // logs a warning, and an agent that later changes its model on its own
  // (ACP's `config_option_update`) is neither tracked nor re-asserted. A
  // session's model is therefore fixed for its lifetime — changing it means
  // tearing the session down and establishing a new one.
  resolveSessionModel?: (request: ACPModelRequest, signal: AbortSignal) => Promise<string | undefined>;
  logger?: Logger;
}

export interface ACPClientStdioOptions extends ACPClientAdapterBaseOptions {
  command: string | string[];
  host?: never;
  port?: never;
}

export interface ACPClientTcpOptions extends ACPClientAdapterBaseOptions {
  command?: never;
  host: string;
  port: number;
}

export type ACPClientAdapterOptions = ACPClientStdioOptions | ACPClientTcpOptions;

export class ACPClientAdapter extends SimpleAdapter<ACPClientSessionState, AdapterToolsProtocol> {
  protected readonly provider: string = "acp";
  private readonly command: string[]
  private readonly cwd: string
  private readonly env?: Record<string, string>
  private readonly mcpServers: McpServer[]
  private readonly authMethod?: string | null
  private readonly enableMemoryTools: boolean
  private readonly enableMcpTools: boolean
  private readonly additionalMcpTools: McpToolRegistration[]
  private readonly clientCapabilities?: ClientCapabilities
  private readonly connectionFactory?: ACPClientConnectionFactory
  private readonly extensionHandler?: ACPClientExtensionHandler
  private readonly tcpEndpoint: ACPClientTcpEndpoint | null
  private readonly workspaceForRoom?: (roomId: string) => string

  // The value's `generation` is the connection generation the session was
  // last established/restored against. `client` is the exact BandACPClient
  // instance that session was established against — never reread from
  // `this.client` at cleanup time, because a reconnect can already have
  // replaced it. `null` only for a room rehydrated from persisted history.
  private readonly roomToSession = new Map<string, { sessionId: string; generation: number; client: BandACPClient | null }>()
  private readonly sessionToRoom = new Map<string, string>()
  private readonly roomTools = new Map<string, AdapterToolsProtocol>()
  // Rooms whose previous session could not be restored. Stays set until a
  // prompt on the replacement session is accepted, so a rejected prompt or
  // an abandoned session still seeds the next one. Keyed by room, not by
  // the session that may be thrown away before that prompt lands.
  private readonly roomsOwedReplay = new Set<string>()
  // Keyed by `sessionKey(generation, sessionId)`, not bare sessionId: an ACP
  // agent can reissue the identical session id across a reconnect.
  private readonly activeSessions = new Set<string>()
  private readonly bootstrappedSessions = new Set<string>()
  // A timed-out turn's generation-qualified session, once `cancel()`'d, can
  // never be trusted for restore on that same connection. A later connection
  // generation with the same raw session id is a different owner.
  private readonly abandonedSessions = new Set<string>()
  private readonly pendingPermissions = new Map<string /* sessionKey */, Set<AbortController>>()
  private readonly sessionsInFlight = new Map<string /* roomId */, Promise<string>>()
  private readonly roomTurnLocks = new Map<string /* roomId */, Promise<unknown>>()
  // Bumped each time a room starts a *new* establishment (never on a
  // coalesced reuse) and whenever a room is torn down. An establishment
  // captures its own value at the start; if the room has moved on by the
  // time it would link/activate a session, it was superseded and must not.
  private readonly roomGeneration = new Map<string /* roomId */, number>()

  private readonly resolvePermission?: (request: ACPPermissionRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly resolveSessionMode?: (request: ACPModeRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly resolveSessionModel?: (request: ACPModelRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly resolveSessionConfig?: (request: ACPConfigRequest, signal: AbortSignal) => Promise<ACPConfigSelections | undefined>
  private readonly permissionTimeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly logger: Logger
  private readonly customSection?: string

  private backend: InjectedMcpBackend | null = null
  private backendPromise: Promise<InjectedMcpBackend> | null = null
  private client: BandACPClient | null = null
  private connectionHandle: ACPClientConnectionHandle | null = null
  private pendingConnectionStop: (() => Promise<void>) | null = null
  private connection: ClientSideConnection | null = null
  private connectionState: InitializeResponse | null = null
  private started = false
  private systemPrompt = ""
  private spawnPromise: Promise<ClientSideConnection> | null = null
  private readonly connectionRetirements = new WeakMap<ClientSideConnection, ConnectionRetirement>()
  // Bumped by `stop()` and on every successful spawn install. Cleanup/timeout
  // and permission maps key by this plus session id so a stale generation
  // cannot alias a same-id session on a newer connection.
  private connectionGeneration = 0

  public constructor(options: ACPClientAdapterOptions) {
    super({
      historyConverter: new ACPClientHistoryConverter(),
    })

    const command = options.command === undefined
      ? []
      : Array.isArray(options.command) ? [...options.command] : [options.command]
    const tcpEndpoint = validateTransport(command, options.host, options.port)
    this.command = command

    this.cwd = options.cwd ?? process.cwd()
    this.env = options.env
    this.mcpServers = [...(options.mcpServers ?? [])]
    this.authMethod = options.authMethod
    this.enableMemoryTools = options.enableMemoryTools ?? false
    this.enableMcpTools = options.enableMcpTools ?? true
    this.additionalMcpTools = [...(options.additionalMcpTools ?? [])]
    this.clientCapabilities = options.clientCapabilities
    this.connectionFactory = options.connectionFactory
    this.extensionHandler = options.extensionHandler
    this.tcpEndpoint = tcpEndpoint
    this.workspaceForRoom = options.workspaceForRoom

    this.resolvePermission = options.resolvePermission
    this.resolveSessionMode = options.resolveSessionMode
    this.resolveSessionModel = options.resolveSessionModel
    this.resolveSessionConfig = options.resolveSessionConfig
    this.logger = resolveLogger(options.logger)
    this.customSection = options.customSection
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    // Only meaningful when `resolvePermission`, `resolveSessionMode`, or
    // `resolveSessionModel` is actually set — the auto-allow/harness-default
    // paths never read it, so an irrelevant/default value here shouldn't
    // reject an otherwise-valid config for a caller not using manual mode at
    // all.
    if ((this.resolvePermission || this.resolveSessionMode || this.resolveSessionModel || this.resolveSessionConfig) && (!Number.isFinite(this.permissionTimeoutMs) || this.permissionTimeoutMs <= 0)) {
      throw new ValidationError(`permissionTimeoutMs must be a positive finite number, got ${options.permissionTimeoutMs}`)
    }
    if (this.resolvePermission || this.resolveSessionMode || this.resolveSessionModel || this.resolveSessionConfig) {
      assertWithinSetTimeoutBound(
        `permissionTimeoutMs must be at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${options.permissionTimeoutMs}`,
        this.permissionTimeoutMs,
      )
    }

    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    // `Number.isNaN("3000")` is false and comparison coercions would otherwise
    // accept a string, then `Number.isFinite("3000")` is false and silently
    // disable the timeout. Reject non-numbers; `Infinity` remains the opt-out.
    if (typeof this.turnTimeoutMs !== "number" || Number.isNaN(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) {
      throw new ValidationError(`turnTimeoutMs must be a positive number or Infinity, got ${options.turnTimeoutMs}`)
    }
    if (Number.isFinite(this.turnTimeoutMs)) {
      assertWithinSetTimeoutBound(
        `turnTimeoutMs must be Infinity or at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${options.turnTimeoutMs}`,
        this.turnTimeoutMs,
      )
    }
  }

  public async onStarted(
    agentName: string,
    agentDescription: string,
  ): Promise<void> {
    const generation = this.connectionGeneration
    await super.onStarted(agentName, agentDescription)
    if (generation !== this.connectionGeneration) {
      throw new Error("ACP adapter start superseded by stop()")
    }
    this.started = true
    this.systemPrompt = renderSystemPrompt({
      agentName,
      agentDescription,
      includeBaseInstructions: false,
      customSection: this.customSection,
    })
    await this.ensureConnection()
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: ACPClientSessionState,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (context.isSessionBootstrap) {
      this.rehydrate(history)
    }

    this.roomTools.set(context.roomId, tools)

    // `Execution.bootstrapMessage` runs outside its own room's serialized
    // `processLoop`, alongside the sync loop its constructor starts — so two
    // turns for one room really can reach here concurrently. Establishing a
    // session tolerates that (`getOrCreateSession`'s `sessionsInFlight`
    // guard), but `resetChunks → prompt → flushChunks` does not: two
    // concurrent `prompt` calls on the same session share one chunk buffer,
    // so one turn's `resetChunks` can wipe output the other is still
    // collecting. Serializing the whole turn body per room, not just
    // establishment, is what actually makes concurrent same-room turns safe.
    // `history` is this turn's own snapshot, closed over here. A later
    // `onMessage` for the same room must not be able to replace it while
    // this turn is still establishing a session.
    await this.withRoomTurnLock(context.roomId, () => this.runTurn(message, tools, participantsMessage, contactsMessage, context, history))
  }

  private async runTurn(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
    history: ACPClientSessionState,
  ): Promise<void> {
    // Hoisted out of the `try` so the `catch` below — specifically the
    // timeout branch — can still reach the connection/client/session a
    // timed-out prompt was issued on, to cancel and evict it.
    let connection: ClientSideConnection | undefined
    let client: BandACPClient | null = null
    let sessionId: string | undefined
    let generation = 0
    await this.onAcpTurnStarted(message, tools, context)
    try {
      const ensured = await this.ensureConnection()
      connection = ensured.connection
      generation = ensured.generation
      client = this.client
      if (!client) {
        throw new Error("ACP client was not initialized")
      }

      sessionId = await this.getOrCreateSession(context.roomId, connection, generation, client)
      const sessionKey = this.sessionKey(generation, sessionId)
      await this.onAcpSessionReady(message, tools, context, sessionId)
      client.beginSession(sessionId)
      const content = replaceUuidMentions(message.content, mentionSubjectsFromMetadata(message.metadata))
      const messageWithContext = [...systemUpdateParts(participantsMessage, contactsMessage), content].join("\n\n")
      // A restored session is normally already bootstrapped. It still owes
      // a transcript when the prompt that should have carried the replay
      // was never accepted — restore of that empty session must not skip it.
      const seedingSession = this.roomsOwedReplay.has(context.roomId) || !this.bootstrappedSessions.has(sessionKey)
      let promptText: string
      if (!seedingSession) {
        promptText = messageWithContext
      } else {
        const replayLines = this.replayLinesFor(context.roomId, message.id, history)
        if (this.roomsOwedReplay.has(context.roomId)) {
          this.safeWarn("acp_client.replay_seed", { roomId: context.roomId, lineCount: replayLines?.length ?? 0 })
        }
        const liveSections = replayLines ? framedReplay(replayLines, messageWithContext) : [messageWithContext]
        promptText = [this.buildSystemContext(context.roomId, message), ...liveSections].join("\n\n")
      }

      const activeConnection = connection
      const activeSessionId = sessionId
      const response = await withTimeout(
        this.raceAgainstConnectionRetirement(activeConnection, client.runInPromptSession(activeSessionId, () => activeConnection.prompt({
          sessionId: activeSessionId,
          prompt: [{
            type: "text",
            text: promptText,
          }],
        }))),
        this.turnTimeoutMs,
        () => new AcpTurnTimeoutError(),
      )
      // Only a prompt the agent accepted counts. A rejection leaves the
      // session unbootstrapped and the room still owed its replay, so the
      // next prompt on this session — or on the session that replaces an
      // abandoned one — is the one that carries the transcript.
      // `cancelled` means the client aborted the turn (`session/cancel`).
      // The agent is required to return that stop reason instead of
      // `end_turn`, and it may not have taken the prompt. Other stop
      // reasons mean the prompt was processed.
      if (seedingSession && response.stopReason !== "cancelled") {
        this.bootstrappedSessions.add(sessionKey)
        this.roomsOwedReplay.delete(context.roomId)
      }

      await this.flushChunks({
        client,
        tools,
        sessionId,
        senderId: message.senderId,
        senderHandle: message.senderName ?? message.senderType,
      })

      await tools.sendEvent("ACP client session", "task", {
        acp_client_session_id: sessionId,
        acp_client_room_id: context.roomId,
      })

      if (response.stopReason !== "end_turn") {
        await reportTurnFailure(
          tools,
          agentFailure(this.provider, `ACP turn ended with stop reason: ${response.stopReason ?? "unknown"}.`, response.stopReason),
          this.logger,
          { roomId: context.roomId, sessionId },
        )
      }
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error)
      if (client && sessionId) {
        client.releasePromptSession(sessionId)
      }

      const isTimeout = error instanceof AcpTurnTimeoutError

      // Ownership eviction must happen before any fallible delivery: a
      // DeliveryFailedError from flushChunks is recoverable and would skip
      // cancel/abandon if it ran first, leaving the next turn to restore
      // this still-live session.
      if (isTimeout && connection && sessionId) {
        await this.abandonTimedOutTurn(connection, sessionId, generation)
      }

      if (client && sessionId) {
        try {
          await this.flushChunks({
            client,
            tools,
            sessionId,
            senderId: message.senderId,
            senderHandle: message.senderName ?? message.senderType,
          })
        } finally {
          if (isTimeout) {
            client.resetChunks(sessionId)
          }
        }
      }

      const configError = error instanceof AcpSessionConfigError ? error : undefined
      const acpError = configError ? undefined : asAcpJsonRpcError(error)
      await reportTurnFailure(
        tools,
        isTimeout
          ? agentFailure(this.provider, "ACP turn timed out.", FAILURE_CODE_TIMEOUT)
          : configError
            ? configError.toAgentFailure()
            : acpError
              ? agentFailure(this.provider, acpError.message, String(acpError.code), acpError.data)
              : agentFailure(this.provider, asErrorMessage(error)),
        this.logger,
        {
          roomId: context.roomId,
          sessionId: configError?.sessionId ?? sessionId,
          ...(configError ? { optionId: configError.optionId, selectedValue: configError.selectedValue } : {}),
        },
      )
    } finally {
      await this.onAcpTurnFinished(message, tools, context)
    }
  }

  protected async onAcpTurnStarted(
    _message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    _context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {}

  protected async onAcpTurnFinished(
    _message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    _context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {}

  protected async onAcpSessionReady(
    _message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    _context: { isSessionBootstrap: boolean; roomId: string },
    _sessionId: string,
  ): Promise<void> {}

  // Best-effort: tells the agent to stop working on a turn Band has already
  // given up waiting for (the ACP client has no way to force it), evicts the
  // session so the room's next turn re-establishes rather than reuses it
  // (`establishSession` also refuses to restore it — see `abandonedSessions`),
  // and resets the chunk buffer so a stray notification the agent sends
  // before the next turn starts (the tail it may still send after `cancel`,
  // per the ACP spec) has nowhere to land (`sessionUpdate` only collects
  // into a session it still has a buffer for).
  //
  // `connection.cancel()` is fired via the shared `abandon()` helper, not
  // awaited: the turn only timed out because the underlying agent process
  // stopped responding, and `cancel` rides the same transport — awaiting it
  // would risk blocking this room's turn lock forever on the very process
  // that just proved it can hang.
  private async abandonTimedOutTurn(connection: ClientSideConnection, sessionId: string, generation: number): Promise<void> {
    // Only drop this generation's mapping. A replacement that reused the
    // same raw session id on a newer connection owns a different key.
    this.evictAbandonedSession(sessionId, generation, connection, () => {
      const owner = [...this.roomToSession.entries()].find(([, value]) => value.sessionId === sessionId && value.generation === generation)
      if (owner) {
        this.unlinkOwner(owner[0], owner[1])
      }
    })
  }

  // A per-room async mutex: `fn` for a given `roomId` never overlaps another
  // call for that same room, while different rooms stay fully concurrent.
  // The tracked tail (`this.roomTurnLocks`) always settles — via the
  // trailing `.catch` — so one turn's failure can't wedge every later turn
  // for the room; the real result/rejection is still `run`, returned to this
  // call's own caller.
  private async withRoomTurnLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.roomTurnLocks.get(roomId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.roomTurnLocks.set(roomId, run.catch(() => undefined))
    return run
  }

  public async onCleanup(roomId: string): Promise<void> {
    const owner = this.unlinkRoom(roomId)
    this.roomTools.delete(roomId)
    this.roomsOwedReplay.delete(roomId)
    this.sessionsInFlight.delete(roomId)
    this.roomTurnLocks.delete(roomId)
    // Invalidates any establishment for this room still in flight — it may
    // finish later (nothing cancels the real RPC), but must not link or
    // activate on behalf of a room that has already moved on.
    this.nextRoomGeneration(roomId)
    if (owner) {
      const key = this.sessionKey(owner.generation, owner.sessionId)
      owner.client?.resetChunks(owner.sessionId)
      this.activeSessions.delete(key)
      this.bootstrappedSessions.delete(key)
      this.abandonedSessions.delete(key)
      this.cancelPendingPermissions(key, "room-closed")
    }
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop()
  }

  public async stop(): Promise<void> {
    this.connectionGeneration++
    this.started = false
    this.spawnPromise = null
    this.connectionState = null
    this.activeSessions.clear()
    this.bootstrappedSessions.clear()
    this.abandonedSessions.clear()
    this.roomsOwedReplay.clear()
    this.roomToSession.clear()
    this.sessionToRoom.clear()
    this.roomTools.clear()
    this.sessionsInFlight.clear()
    this.roomTurnLocks.clear()
    // Same reasoning as `onCleanup`, for every room at once: a still-pending
    // establishment from before `stop()` must not link into state this call
    // is in the middle of tearing down.
    for (const roomId of this.roomGeneration.keys()) {
      this.nextRoomGeneration(roomId)
    }
    this.cancelAllPendingPermissions("adapter-stopped")

    this.client = null
    this.connection = null

    if (this.pendingConnectionStop) {
      const stopPending = this.pendingConnectionStop
      this.pendingConnectionStop = null
      await stopPending()
    }

    if (this.backend) {
      const backend = this.backend
      this.backend = null
      await backend.stop()
    }

    if (this.connectionHandle) {
      const handle = this.connectionHandle
      this.connectionHandle = null
      await handle.stop()
    }
  }

  private rehydrate(history: ACPClientSessionState): void {
    for (const [roomId, sessionId] of Object.entries(history.roomToSession)) {
      if (!this.roomToSession.has(roomId)) {
        this.linkSession(roomId, sessionId, this.connectionGeneration, null)
      }
    }
  }

  // The only writer of both session maps, so they cannot drift: replacing a
  // room's session drops the old session's route, and a session id already
  // routed to another room is refused rather than silently re-pointed — two
  // rooms sharing one session id would make its permission requests
  // unattributable. Returns whether the link was made — a caller that goes
  // on to activate/configure/prompt a session regardless of a `false` here
  // would use a session this room was refused, not just fail to route its
  // permissions.
  private linkSession(roomId: string, sessionId: string, generation: number, client: BandACPClient | null): boolean {
    const key = this.sessionKey(generation, sessionId)
    const routedRoomId = this.sessionToRoom.get(key)
    if (routedRoomId !== undefined && routedRoomId !== roomId) {
      this.safeWarn("refusing to route one ACP session to a second room", {
        sessionId,
        roomId,
        routedRoomId,
      })
      return false
    }

    const replaced = this.roomToSession.get(roomId)
    if (replaced && replaced.generation > generation) {
      return false
    }
    if (replaced !== undefined && (replaced.sessionId !== sessionId || replaced.generation !== generation)) {
      this.sessionToRoom.delete(this.sessionKey(replaced.generation, replaced.sessionId))
    }

    this.roomToSession.set(roomId, { sessionId, generation, client })
    this.sessionToRoom.set(key, roomId)
    return true
  }

  private nextRoomGeneration(roomId: string): number {
    const next = (this.roomGeneration.get(roomId) ?? 0) + 1
    this.roomGeneration.set(roomId, next)
    return next
  }

  private isCurrentGeneration(roomId: string, generation: number): boolean {
    return this.roomGeneration.get(roomId) === generation
  }

  // The installed ACP SDK's `sendRequest` never rejects a pending call when
  // its connection closes (no server response ever arrives to reject it
  // with) — so a session-establishment RPC in flight when the subprocess
  // dies would otherwise hang forever, wedging the room's `sessionsInFlight`
  // entry along with it. Racing every such RPC against the connection's own
  // `closed` promise gives it a real, prompt failure instead.
  private raceAgainstConnectionClose<T>(connection: ClientSideConnection, operation: Promise<T>): Promise<T> {
    let reject: (error: Error) => void = () => undefined
    const closedRejection = new Promise<never>((_resolve, rejectFn) => {
      reject = rejectFn
    })
    // A plain callback, not a thrown error inside the `.then` — so this
    // derived promise itself never rejects and needs no `.catch` of its own.
    void connection.closed.then(() => reject(new Error("ACP connection closed while a session operation was still in flight")))
    return Promise.race([operation, closedRejection])
  }

  private raceAgainstConnectionRetirement<T>(connection: ClientSideConnection, operation: Promise<T>): Promise<T> {
    const retirement = this.connectionRetirements.get(connection) ?? createConnectionRetirement()
    this.connectionRetirements.set(connection, retirement)
    return Promise.race([operation, retirement.promise])
  }

  private unlinkRoom(roomId: string): { sessionId: string; generation: number; client: BandACPClient | null } | undefined {
    const owner = this.roomToSession.get(roomId)
    if (owner) {
      this.unlinkOwner(roomId, owner)
    }
    return owner
  }

  private unlinkOwner(roomId: string, owner: { sessionId: string; generation: number; client: BandACPClient | null }): void {
    const current = this.roomToSession.get(roomId)
    if (!current || current.sessionId !== owner.sessionId || current.generation !== owner.generation) {
      return
    }
    this.roomToSession.delete(roomId)
    this.sessionToRoom.delete(this.sessionKey(owner.generation, owner.sessionId))
  }

  private sessionKey(generation: number, sessionId: string): string {
    return `${generation}:${sessionId}`
  }

  private resolveRoomCwd(roomId: string): string {
    return this.workspaceForRoom?.(roomId) ?? this.cwd
  }

  // Excludes the current turn's own message. A non-bootstrap history
  // already includes it (`ExecutionContext.recordMessage` runs before the
  // history handed to the adapter is read); a bootstrap history does not.
  // Empty after that filter means there is nothing to frame — an empty
  // array must not still emit the history header.
  private replayLinesFor(roomId: string, currentMessageId: string, history: ACPClientSessionState): string[] | null {
    if (!this.roomsOwedReplay.has(roomId)) {
      return null
    }
    const lines = (history.replayMessages ?? [])
      .filter((entry) => entry.id !== currentMessageId)
      .map((entry) => entry.line)
    return lines.length > 0 ? lines : null
  }

  protected roomIdForSession(sessionId: string): string | undefined {
    return [...this.roomToSession.entries()].find(([, owner]) => owner.sessionId === sessionId)?.[0]
  }

  private async ensureConnection(): Promise<{ connection: ClientSideConnection; generation: number }> {
    if (this.connection && !this.connection.signal.aborted) {
      return { connection: this.connection, generation: this.connectionGeneration }
    }

    if (!this.started) {
      throw new Error("ACPClientAdapter was not started")
    }

    const isCreator = !this.spawnPromise
    if (isCreator) {
      this.spawnPromise = this.spawnConnection()
    }
    const spawnPromise = this.spawnPromise!

    try {
      const connection = await spawnPromise
      return { connection, generation: this.connectionGeneration }
    } finally {
      if (isCreator && this.spawnPromise === spawnPromise) {
        this.spawnPromise = null
      }
    }
  }

  private async spawnConnection(): Promise<ClientSideConnection> {
    const generation = this.connectionGeneration
    const attempt = new AbortController()
    let handle: ACPClientConnectionHandle | null = null
    const stopAttempt = async (): Promise<void> => {
      attempt.abort()
      await handle?.stop()
    }
    this.pendingConnectionStop = stopAttempt

    try {
      const acp = await acpModule.get()
      if (attempt.signal.aborted) {
        throw new Error(CONNECTION_ATTEMPT_SUPERSEDED_ERROR)
      }
      // Handed its permission handler here, one line before the process it will
      // serve even exists — no session can out-race its own route.
      const owner = { generation: -1 }
      const client = new BandACPClient(
        (params) => this.routePermissionRequest(params, owner.generation),
        this.extensionHandler,
      )
      handle = await (this.connectionFactory
        ? this.connectionFactory(client, {
          command: this.command,
          cwd: this.cwd,
          env: this.env,
        })
        : this.tcpEndpoint
          ? createTcpConnection(client, this.tcpEndpoint, attempt.signal)
          : createSubprocessConnection(client, {
            command: this.command,
            cwd: this.cwd,
            env: this.env,
          }))
      const connection = handle.connection
      if (attempt.signal.aborted) {
        await handle.stop()
        throw new Error(CONNECTION_ATTEMPT_SUPERSEDED_ERROR)
      }
      const initializeResult = await this.raceAgainstConnectionClose(connection, connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: this.clientCapabilities ?? {},
      }))

      if (this.authMethod) {
        await this.raceAgainstConnectionClose(connection, connection.authenticate({
          methodId: this.authMethod,
        }))
      }

      if (generation !== this.connectionGeneration) {
        await handle.stop()
        throw new Error(CONNECTION_ATTEMPT_SUPERSEDED_ERROR)
      }

      this.connectionGeneration++
      owner.generation = this.connectionGeneration
      this.client = client
      this.connection = connection
      this.connectionHandle = handle
      this.connectionState = initializeResult
    } catch (error) {
      if (handle && this.connection !== handle.connection) {
        try {
          await handle.stop()
        } catch (stopError) {
          this.safeWarn("acp_client.handle_stop_after_handshake_failure", { error: asErrorMessage(stopError) })
        }
      }
      throw error
    } finally {
      if (this.pendingConnectionStop === stopAttempt) {
        this.pendingConnectionStop = null
      }
    }

    const connection = handle.connection
    const installedGeneration = this.connectionGeneration
    void connection.closed.finally(() => {
      this.pruneConnectionGeneration(installedGeneration)
      if (this.connection === connection) {
        this.connection = null
        this.connectionHandle = null
        this.connectionState = null
      }
    })

    return connection
  }

  private async getOrCreateSession(
    roomId: string,
    connection: ClientSideConnection,
    connectionGeneration: number,
    client: BandACPClient,
  ): Promise<string> {
    const owner = this.roomToSession.get(roomId)
    const existingSessionId = owner?.sessionId

    if (owner && owner.generation === connectionGeneration && this.activeSessions.has(this.sessionKey(connectionGeneration, owner.sessionId))) {
      return owner.sessionId
    }

    // A single room really can re-enter here concurrently — `Execution` runs a
    // bootstrap message alongside the sync loop it starts in its constructor —
    // and two establishments for one room would leave the loser's session
    // routed nowhere. Same shape as `ensureConnection`'s `spawnPromise`.
    const inFlight = this.sessionsInFlight.get(roomId)
    if (inFlight) {
      return inFlight
    }

    // Captured now, before anything is awaited: this establishment belongs
    // to the room's *current* generation, and stays pinned to it even if
    // `onCleanup`/`stop` bump the counter while it's still in flight.
    const generation = this.nextRoomGeneration(roomId)
    const establishing = this.establishSession(roomId, existingSessionId, connection, generation, connectionGeneration, client)
    // Compare-and-delete: if this room was torn down and re-entered while
    // `establishing` was still pending, a newer promise is already stored at
    // `roomId` by the time this one settles. Deleting unconditionally would
    // evict that newer entry instead of this one, silently defeating the
    // dedup guard above for the room's very next call.
    //
    // `establishing` itself — not this `.finally()`'s own derived promise —
    // is what's stored and returned below, so its rejection stays that
    // promise's alone to handle; the `.catch` here only silences the
    // separate promise `.finally()` produces, which nothing else observes.
    establishing.finally(() => {
      if (this.sessionsInFlight.get(roomId) === establishing) {
        this.sessionsInFlight.delete(roomId)
      }
    }).catch(() => undefined)
    this.sessionsInFlight.set(roomId, establishing)
    return establishing
  }

  private async establishSession(
    roomId: string,
    existingSessionId: string | undefined,
    connection: ClientSideConnection,
    generation: number,
    connectionGeneration: number,
    client: BandACPClient,
  ): Promise<string> {
    const mcpServers = await this.buildSessionMcpServers()
    const cwd = this.resolveRoomCwd(roomId)

    // A session a timed-out turn abandoned must never be restored: the
    // agent may still be writing to it (see `abandonTimedOutTurn`), so
    // reusing its id — rather than falling through to a genuinely fresh
    // `newSession` below — is what would let that stray output resurface.
    if (existingSessionId && !this.abandonedSessions.has(this.sessionKey(connectionGeneration, existingSessionId))) {
      const restored = await this.tryRestoreSession(connection, existingSessionId, cwd, mcpServers)
      if (restored.ok) {
        // Linked and marked active/bootstrapped before the best-effort mode
        // switch below is awaited: `configureSessionMode` makes a real RPC
        // call, and a connection drop mid-call clears `activeSessions` (see
        // `spawnConnection`'s `closed.finally()`) — running this after that
        // await would let a stale add silently re-admit a session whose
        // connection just died, and would leave the session unroutable for
        // the whole duration of the call.
        this.linkOrAbandon(roomId, existingSessionId, generation, connectionGeneration, client)
        const restoredKey = this.sessionKey(connectionGeneration, existingSessionId)
        this.activeSessions.add(restoredKey)
        this.bootstrappedSessions.add(restoredKey)
        await this.configureSessionMode(roomId, existingSessionId, restored.modes, connection)
        await this.configureSessionConfig(roomId, existingSessionId, restored.configOptions, connection, connectionGeneration, client)
        if (!this.resolveSessionConfig) {
          await this.configureSessionModel(roomId, existingSessionId, restored.configOptions, connection)
        }
        return existingSessionId
      }
    }

    // Raced: `newSession` otherwise waits forever on a connection that died
    // mid-call (see `raceAgainstConnectionClose`'s own doc comment), which
    // would leave this room's `sessionsInFlight` entry — and the turn
    // awaiting it — permanently wedged.
    const created = await this.raceAgainstConnectionClose(connection, connection.newSession({
      cwd,
      mcpServers,
    }))

    // Same ordering reason as the restored-session branch above.
    this.linkOrAbandon(roomId, created.sessionId, generation, connectionGeneration, client)
    const createdKey = this.sessionKey(connectionGeneration, created.sessionId)
    this.activeSessions.add(createdKey)
    // Only a restore failure for a session that actually existed leaves the
    // fresh session amnesiac of real prior context — a room's genuine
    // first-ever session has nothing to replay, and gets its framing from
    // `buildSystemContext` instead (see `runTurn`). Kept on the room, not
    // the new session key: config failure and turn timeout both unlink
    // that session before its prompt is accepted.
    if (existingSessionId) {
      this.roomsOwedReplay.add(roomId)
      this.safeWarn("acp_client.replay_armed", { roomId, previousSessionId: existingSessionId })
    }
    await this.configureSessionMode(roomId, created.sessionId, created.modes, connection)
    await this.configureSessionConfig(roomId, created.sessionId, created.configOptions, connection, connectionGeneration, client)
    if (!this.resolveSessionConfig) {
      await this.configureSessionModel(roomId, created.sessionId, created.configOptions, connection)
    }
    return created.sessionId
  }

  private async configureSessionConfig(
    roomId: string,
    sessionId: string,
    configOptions: readonly SessionConfigOption[] | null | undefined,
    connection: ClientSideConnection,
    connectionGeneration: number,
    client: BandACPClient,
  ): Promise<void> {
    if (!this.resolveSessionConfig || !Array.isArray(configOptions) || configOptions.length === 0) {
      return
    }
    const advertisedOptions: readonly SessionConfigOption[] = configOptions

    const selections = await this.resolveManualSelection(
      "resolveSessionConfig",
      (signal) => this.resolveSessionConfig!({ roomId, sessionId, configOptions: advertisedOptions }, signal),
      connection.signal,
    )
    if (!selections) {
      return
    }

    try {
      await applySessionConfigSelections({
        provider: this.provider,
        sessionId,
        catalog: advertisedOptions,
        selections,
        setOption: (params) => connection.setSessionConfigOption(params),
        timeoutMs: SET_SESSION_CONFIG_TIMEOUT_MS,
      })
    } catch (error) {
      this.abandonFailedConfigSession(
        roomId,
        sessionId,
        connectionGeneration,
        client,
        connection,
        error instanceof AcpSessionConfigError && error.timedOut,
      )
      throw error
    }
  }

  // A config failure mid-establish must not leave a half-applied session
  // active for the room: the next turn needs a fresh `newSession` catalog.
  private abandonFailedConfigSession(
    roomId: string,
    sessionId: string,
    connectionGeneration: number,
    client: BandACPClient,
    connection: ClientSideConnection,
    retireConnection: boolean,
  ): void {
    const key = this.sessionKey(connectionGeneration, sessionId)
    this.bootstrappedSessions.delete(key)
    client.resetChunks(sessionId)
    // Shared eviction+cancel with turn-timeout abandon: a hung
    // setSessionConfigOption must not stay pending while the next turn
    // opens a fresh session on this connection.
    this.evictAbandonedSession(sessionId, connectionGeneration, connection, () => {
      const owner = this.roomToSession.get(roomId)
      if (owner && owner.sessionId === sessionId && owner.generation === connectionGeneration) {
        this.unlinkOwner(roomId, owner)
      }
    })
    if (retireConnection) {
      this.retireConnection(connection, connectionGeneration)
    }
  }

  // Common half of timeout and config-failure abandon: mark the session
  // unusable for restore, unlink ownership, and best-effort cancel.
  private evictAbandonedSession(
    sessionId: string,
    connectionGeneration: number,
    connection: ClientSideConnection,
    unlink: () => void,
  ): void {
    const key = this.sessionKey(connectionGeneration, sessionId)
    const wasActive = this.activeSessions.delete(key)
    if (wasActive) {
      this.abandonedSessions.add(key)
    }
    unlink()
    abandon(
      () => connection.cancel({ sessionId }),
      (error) => this.safeWarn("acp_client.cancel_failed", { sessionId, error: asErrorMessage(error) }),
    )
  }

  // A timed-out config RPC means this transport has already failed to answer
  // one request. Retire it so the next turn cannot wait forever on another.
  private retireConnection(connection: ClientSideConnection, generation: number): void {
    if (this.connection !== connection || this.connectionGeneration !== generation) {
      return
    }

    const handle = this.connectionHandle
    this.connectionGeneration++
    this.connection = null
    this.connectionHandle = null
    this.connectionState = null
    this.client = null
    this.pruneConnectionGeneration(generation)
    this.connectionRetirements.get(connection)?.reject(new Error("ACP connection retired after a config timeout"))
    if (handle) {
      abandon(
        () => handle.stop(),
        (error) => this.safeWarn("acp_client.handle_stop_after_config_timeout", { error: asErrorMessage(error) }),
      )
    }
  }

  // The single gate an establishment must pass before it's allowed to claim
  // the room: it must still be the room's current generation (not
  // superseded by a teardown or a fresher establishment while this one was
  // awaiting an RPC), and its session id must not already belong to another
  // room. Either failure throws — this establishment cannot silently
  // continue to activate, configure, and prompt a session it has no right
  // to use for this room.
  private linkOrAbandon(roomId: string, sessionId: string, generation: number, connectionGeneration: number, client: BandACPClient): void {
    if (!this.isCurrentGeneration(roomId, generation)) {
      throw new Error(`ACP session establishment for room "${roomId}" was superseded before it could be linked`)
    }

    if (!this.linkSession(roomId, sessionId, connectionGeneration, client)) {
      throw new Error(`ACP session "${sessionId}" could not be linked to room "${roomId}": already routed elsewhere`)
    }
  }

  // Best-effort: never throws, so a mode switch going wrong can't take a
  // session establishment down with it.
  private async configureSessionMode(
    roomId: string,
    sessionId: string,
    modes: SessionModeState | null | undefined,
    connection: ClientSideConnection,
  ): Promise<void> {
    if (!this.resolveSessionMode || !modes) {
      return
    }

    // Defensive, not just typed: `modes` comes straight off an unvalidated
    // JSON-RPC response from the spawned agent process (the ACP client does
    // no runtime schema check), so a non-conforming agent can send
    // `availableModes` missing, null, or containing a null entry despite the
    // type guaranteeing an `Array<SessionMode>`.
    const availableModes = Array.isArray(modes.availableModes) ? modes.availableModes : []
    if (availableModes.length === 0) {
      return
    }

    const selectedModeId = await this.resolveManualSelection(
      "resolveSessionMode",
      (signal) => this.resolveSessionMode!({
        roomId,
        sessionId,
        currentModeId: modes.currentModeId,
        modes: availableModes,
      }, signal),
      connection.signal,
    )
    if (!selectedModeId || selectedModeId === modes.currentModeId) {
      return
    }

    if (!availableModes.some((mode) => mode?.id === selectedModeId)) {
      // Warned, not silent: otherwise a caller-selected mode id silently
      // failing to apply has no signal at all.
      this.safeWarn("resolveSessionMode selected a mode id this session does not advertise", {
        sessionId,
        selectedModeId,
        availableModeIds: availableModes.map((mode) => mode?.id),
      })
      return
    }

    try {
      await withTimeout(
        connection.setSessionMode({ sessionId, modeId: selectedModeId }),
        SET_SESSION_CONFIG_TIMEOUT_MS,
        `setSessionMode did not respond within ${SET_SESSION_CONFIG_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      this.safeWarn("failed to switch session into the selected mode", {
        sessionId,
        selectedModeId,
        error: String(error),
      })
    }
  }

  // Best-effort, same contract as `configureSessionMode`: never throws, so a
  // model switch going wrong can't take a session establishment down with
  // it. Reads the model catalog off `configOptions` (the stable, generic
  // mechanism every ACP protocol version from this repo's actual pin through
  // npm's current latest carries), not the separate `unstable_`-prefixed
  // `SessionModelState` field, which real agents don't populate — see
  // `ACPModelRequest`'s doc comment for why.
  private async configureSessionModel(
    roomId: string,
    sessionId: string,
    configOptions: readonly SessionConfigOption[] | null | undefined,
    connection: ClientSideConnection,
  ): Promise<void> {
    if (!this.resolveSessionModel || !Array.isArray(configOptions)) {
      return
    }

    const modelOption = configOptions.find(isModelConfigOption) ?? configOptions.find(isModelConfigOptionById)
    if (!modelOption) {
      return
    }

    // Defensive, not just typed: same reasoning as `configureSessionMode`'s
    // `availableModes` guard above — the ACP client does no runtime schema
    // check on an agent's JSON-RPC response.
    const availableModels = flattenConfigSelectOptions(modelOption.options)
    if (availableModels.length === 0) {
      return
    }

    const selectedModelId = await this.resolveManualSelection(
      "resolveSessionModel",
      (signal) => this.resolveSessionModel!({
        roomId,
        sessionId,
        currentModelId: modelOption.currentValue,
        models: availableModels,
      }, signal),
      connection.signal,
    )
    if (!selectedModelId || selectedModelId === modelOption.currentValue) {
      return
    }

    if (!availableModels.some((model) => model?.value === selectedModelId)) {
      this.safeWarn("resolveSessionModel selected a model id this session does not advertise", {
        sessionId,
        selectedModelId,
        availableModelIds: availableModels.map((model) => model?.value),
      })
      return
    }

    try {
      await withTimeout(
        connection.setSessionConfigOption({ sessionId, configId: modelOption.id, value: selectedModelId }),
        SET_SESSION_CONFIG_TIMEOUT_MS,
        `setSessionConfigOption did not respond within ${SET_SESSION_CONFIG_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      this.safeWarn("failed to switch session into the selected model", {
        sessionId,
        selectedModelId,
        error: String(error),
      })
    }
  }

  private async resolveManualSelection<T>(
    hookName: string,
    resolver: (signal: AbortSignal) => Promise<T | undefined>,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const cancelled = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      // `addEventListener` only catches a *future* abort. `signal` (the
      // connection's) can already be aborted by the time this runs — mode
      // and model establishment both race against the same
      // `connection.signal` in sequence, so a connection drop during the
      // first wait leaves the second wait registering its listener on an
      // already-fired signal, which never redelivers the past event.
      // Checked synchronously too, mirroring `ClientSideConnection.signal`'s
      // own documented usage pattern — but only *after* `cancelled` above
      // has its own listener on `controller.signal` in place, since
      // `abort()` fires that signal's one-shot event immediately and a
      // listener added afterward would miss it the same way.
      if (signal.aborted) {
        abort()
      }
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.permissionTimeoutMs)
      })
      let settled = false
      const resolved = await Promise.race([
        Promise.resolve().then(() => resolver(controller.signal)).then((chosenId) => {
          // Mirrors `discardLateAnswer`'s reasoning for `resolvePermission`:
          // a hook that answers after `timeout`/`cancelled` already won the
          // race can no longer be honoured — `Promise.race` has already
          // discarded this value either way — but logging is what makes a
          // "my selection did nothing" report explicable instead of silent.
          if (settled && chosenId !== undefined) {
            this.safeWarn(`${hookName} answered after the request was abandoned; discarding`, { chosenId })
          }
          return chosenId
        }).catch((error) => {
          this.safeWarn(`${hookName} threw; preserving the harness default`, { error: String(error) })
          return undefined
        }),
        timeout,
        cancelled,
      ])
      settled = true
      return resolved
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.abort()
    }
  }

  private async tryRestoreSession(
    connection: ClientSideConnection,
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
  ): Promise<
    | { ok: true; modes?: SessionModeState | null; configOptions?: Array<SessionConfigOption> | null }
    | { ok: false }
  > {
    const capabilities = this.connectionState?.agentCapabilities
    const params = { cwd, mcpServers, sessionId }

    // `loadSession`/`resumeSession` share both their params and
    // their response shape (`{ ...; modes?: SessionModeState | null;
    // configOptions?: Array<SessionConfigOption> | null }`); resolve which
    // one applies once, then handle the result once.
    const restore = capabilities?.loadSession
      ? () => connection.loadSession(params)
      : capabilities?.sessionCapabilities?.resume
        ? () => connection.resumeSession(params)
        : null

    if (!restore) {
      return { ok: false }
    }

    try {
      // `?.`: the ACP client doesn't runtime-validate this response, and the
      // installed SDK's own `resumeSession` has no fallback for a
      // nullish resolution the way its `loadSession` does — a restore that
      // genuinely succeeded must not be miscategorized as failed just
      // because no mode state came back with it.
      //
      // Raced against connection close for the same reason as `newSession`
      // below: a dead connection otherwise leaves this hanging forever. The
      // catch-all here already treats any failure as "restore didn't work",
      // so a raced-out rejection correctly falls through to establishing a
      // fresh session instead.
      const restored = await this.raceAgainstConnectionClose(connection, restore())
      return { ok: true, modes: restored?.modes, configOptions: restored?.configOptions }
    } catch (error) {
      this.safeWarn("acp_client.session_restore_failed", { sessionId, error: asErrorMessage(error) })
      return { ok: false }
    }
  }

  private async buildSessionMcpServers(): Promise<McpServer[]> {
    const mcpServers = [...this.mcpServers]
    if (!this.enableMcpTools) {
      return mcpServers
    }

    const backend = await this.getOrCreateBackend()
    if (backend.kind === "http") {
      const url = (backend.server as { url: string | null }).url
      if (!url) {
        throw new Error("Band MCP HTTP backend did not expose a URL")
      }

      mcpServers.push({
        type: "http",
        name: MCP_SERVER_NAME,
        url,
        headers: [{ name: "Authorization", value: `Bearer ${backend.authToken}` }],
      })
      return mcpServers
    }

    if (backend.kind === "sse") {
      const url = (backend.server as { sseUrl: string | null }).sseUrl
      if (!url) {
        throw new Error("Band MCP SSE backend did not expose a URL")
      }

      mcpServers.push({
        type: "sse",
        name: MCP_SERVER_NAME,
        url,
        headers: [{ name: "Authorization", value: `Bearer ${backend.authToken}` }],
      })
      return mcpServers
    }

    return mcpServers
  }

  private async getOrCreateBackend(): Promise<InjectedMcpBackend> {
    if (this.backend) {
      return this.backend
    }

    this.backendPromise ??= this.createBackend().finally(() => {
      this.backendPromise = null
    })
    return this.backendPromise
  }

  private async createBackend(): Promise<InjectedMcpBackend> {
    const mcpCapabilities = this.connectionState?.agentCapabilities?.mcpCapabilities
    const transport = mcpCapabilities?.http ? "http" : (mcpCapabilities?.sse ? "sse" : null)

    if (transport === null) {
      throw new Error(
        "ACP agent does not advertise MCP transport support: its initialize response has "
        + "mcpCapabilities.http and .sse both false or missing, so Band tools cannot be "
        + "exposed to it over MCP.",
      )
    }

    const authToken = generateAuthToken()

    if (transport === "sse") {
      const server = new BandMcpSseServer({
        tools: (roomId) => this.roomTools.get(roomId),
        enableMemoryTools: this.enableMemoryTools,
        enableContactTools: true,
        additionalTools: this.additionalMcpTools,
        authToken,
      })
      await server.start()
      this.backend = {
        kind: "sse",
        server,
        authToken,
        stop: async () => {
          await server.stop()
        },
      }
      return this.backend
    }

    const server = new BandMcpServer({
      tools: (roomId) => this.roomTools.get(roomId),
      enableMemoryTools: this.enableMemoryTools,
      enableContactTools: true,
      additionalTools: this.additionalMcpTools,
      authToken,
    })
    await server.start()
    this.backend = {
      kind: "http",
      server,
      authToken,
      stop: async () => {
        await server.stop()
      },
    }

    return this.backend
  }

  private buildSystemContext(roomId: string, message: PlatformMessage): string {
    const requesterName = message.senderName ?? message.senderId
    const requesterId = message.senderId

    return [
      "[System Context]",
      this.systemPrompt,
      "",
      "## Room Context",
      "You are connected to Band using Band MCP tools.",
      "Use the Band tools for any visible room action. Plain text output is not posted back to the room.",
      "",
      `Current room_id: ${roomId}`,
      `Current requester name: ${requesterName}`,
      `Current requester id: ${requesterId}`,
      "",
      "All Band MCP tool calls must include room_id.",
    ].join("\n")
  }

  // The connection's single permission entry point, and total by
  // construction: every path resolves, nothing throws, and a request that
  // can't be attributed to a live room is cancelled *and* warned rather than
  // silently declined. `activeSessions` is the gate that keeps a dead
  // session from raising a live prompt — `roomToSession` deliberately
  // outlives a dropped connection so the session can be restored later.
  private async routePermissionRequest(
    params: RequestPermissionRequest,
    connectionGeneration: number,
  ): Promise<RequestPermissionResponse> {
    if (connectionGeneration < 0) {
      return { outcome: { outcome: "cancelled" } }
    }
    const key = this.sessionKey(connectionGeneration, params.sessionId)
    const isActive = this.activeSessions.has(key)
    const roomId = isActive ? this.sessionToRoom.get(key) : undefined
    const tools = roomId === undefined ? undefined : this.roomTools.get(roomId)

    if (roomId === undefined || !tools) {
      this.safeWarn("cancelling a permission request that maps to no live room", {
        sessionId: params.sessionId,
        toolName: params.toolCall?.title,
        sessionActive: isActive,
        roomId,
      })
      return { outcome: { outcome: "cancelled" } }
    }

    try {
      return await this.handlePermissionRequest(tools, roomId, params, connectionGeneration)
    } catch (error) {
      this.safeWarn("permission handling failed; cancelling the request", {
        sessionId: params.sessionId,
        roomId,
        error: String(error),
      })
      return { outcome: { outcome: "cancelled" } }
    }
  }

  private async handlePermissionRequest(
    tools: AdapterToolsProtocol,
    roomId: string,
    params: RequestPermissionRequest,
    connectionGeneration: number,
  ): Promise<RequestPermissionResponse> {
    const toolName = params.toolCall.title ?? "unknown"

    // Only the auto path can be decided synchronously; the manual path's
    // real outcome isn't known until a human answers or times out. This is
    // the only value `auto_allowed` can honestly report at emit time, and it
    // reflects *this specific request*'s real outcome — including the
    // empty-`options` edge case `choosePermissionOption` maps to `null`
    // (and `toResponse` below maps to `cancelled`, never "auto-allowed").
    const autoSelection = this.resolvePermission ? undefined : choosePermissionOption(params.options)

    // Created and tracked before anything below is awaited: a room/adapter
    // teardown racing the `sendEvent` call must still find this request
    // cancellable immediately, not only once `resolveManually` itself runs.
    const controller = this.resolvePermission ? new AbortController() : undefined
    if (controller) {
      this.trackPending(this.sessionKey(connectionGeneration, params.sessionId), controller)
    }

    // A room's only way to learn a request is pending at all — if it never
    // posts, no human can honestly be said to have been asked, so this
    // request must end cancelled regardless of what `resolveManually`
    // separately produces (it may already be racing toward a real answer).
    // Tracked outside the `Promise.all` below rather than inferred from
    // timing, so a resolver that happens to answer before this rejection is
    // even observed still can't slip a `selected` outcome past it.
    let requestEventFailed = false

    const [, resolvedChosenId] = await Promise.all([
      // Started immediately rather than serialized in front of a manual
      // wait that can take up to `permissionTimeoutMs`.
      tools.sendEvent(`Permission requested: ${toolName}`, "tool_call", {
        permission_request: true,
        tool_name: toolName,
        tool_call_id: params.toolCall.toolCallId,
        acp_session_id: params.sessionId,
        auto_allowed: autoSelection !== undefined && autoSelection !== null,
      }).catch((error) => {
        requestEventFailed = true
        this.safeWarn("failed to post the permission-requested event; cancelling the request", {
          roomId,
          sessionId: params.sessionId,
          error: String(error),
        })
        // Unblocks `resolveManually` immediately rather than leaving it to
        // run out the full `permissionTimeoutMs` for a request that's
        // already decided.
        if (controller) {
          this.abandon(controller, "no-answer")
        }
      }),
      controller
        ? this.resolveManually(roomId, params, controller, connectionGeneration)
        : Promise.resolve(autoSelection?.optionId),
    ])

    const chosenId = requestEventFailed ? undefined : resolvedChosenId
    const response = this.toResponse(chosenId, params.options, { roomId, sessionId: params.sessionId })

    // Derived from the same response just computed, not from a separate
    // "did resolveManually run to an answer" check: `settled` means this
    // request's own outcome was a real, offered selection; anything else
    // that wasn't already an external teardown (`cancelPendingPermissions` /
    // `cancelAllPendingPermissions` / the timeout above, all of which abort
    // before this point is ever reached) is `no-answer` — the request ran
    // its own course without producing a usable one.
    if (controller && !controller.signal.aborted) {
      this.abandon(controller, response.outcome.outcome === "selected" ? "settled" : "no-answer")
    }

    return response
  }

  // `undefined`, or an id absent from this request's own `options` (a buggy
  // or stale caller), both map to `cancelled` — never silently treated as a
  // deny. A real match, reject-kind options included, maps to `selected`.
  private toResponse(
    chosenId: string | undefined,
    options: PermissionOption[],
    context: { roomId: string; sessionId: string },
  ): RequestPermissionResponse {
    if (chosenId === undefined) {
      return { outcome: { outcome: "cancelled" } }
    }

    if (!options.some((option) => option.optionId === chosenId)) {
      // Warned, not silent: a consumer whose chosen id never applies looks
      // exactly like a user who dismissed the prompt.
      this.safeWarn("resolvePermission chose an option this request does not offer", {
        ...context,
        chosenId,
        optionIds: options.map((option) => option.optionId),
      })
      return { outcome: { outcome: "cancelled" } }
    }

    return { outcome: { outcome: "selected", optionId: chosenId } }
  }

  // A caller-supplied `Logger` isn't guaranteed to be synchronous or
  // non-throwing. Every best-effort warning in this file routes through here
  // so one failing sink — a synchronous throw, or an `async` implementation
  // rejecting (the `Logger` interface's `void` return type permits either;
  // a bare try/catch only ever catches the former) — can't turn a warning
  // into an unhandled rejection in its place.
  private safeWarn(message: string, context?: Record<string, unknown>): void {
    try {
      Promise.resolve(this.logger.warn(message, context)).catch(() => undefined)
    } catch {
      // ignore — see comment above
    }
  }

  // Races the caller-supplied resolver against `controller`'s abort signal,
  // which is the request's single termination channel: the timeout below
  // fires it with `"timeout"`, and `cancelPendingPermissions` /
  // `cancelAllPendingPermissions` fire it with the reason their caller
  // supplies. `controller` is the same object tracked in `pendingPermissions`,
  // so there is exactly one cancellation channel here, not a second
  // hand-rolled one alongside it.
  private async resolveManually(
    roomId: string,
    params: RequestPermissionRequest,
    controller: AbortController,
    connectionGeneration: number,
  ): Promise<string | undefined> {
    const abandoned = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined))
    })
    const timer = setTimeout(() => this.abandon(controller, "timeout"), this.permissionTimeoutMs)

    try {
      return await Promise.race([
        // `resolvePermission` is caller-supplied; nothing guarantees it's
        // `async` or otherwise well-behaved. `Promise.resolve().then(...)`
        // normalizes a synchronous throw the same way it normalizes a
        // rejected promise, so both land in the `.catch` below rather than
        // escaping this race uncaught.
        Promise.resolve()
          .then(() => this.resolvePermission!({ ...params, roomId }, controller.signal))
          .then((chosenId) => this.discardLateAnswer(chosenId, controller, roomId, params.sessionId))
          .catch((error) => {
            this.safeWarn("resolvePermission threw; treating as no answer", { error: String(error) })
            return undefined
          }),
        abandoned,
      ])
    } finally {
      clearTimeout(timer)
      this.untrackPending(this.sessionKey(connectionGeneration, params.sessionId), controller)
      // The final abort reason is decided by `handlePermissionRequest`, once
      // the actual `RequestPermissionResponse` is known — not here, and not
      // unconditionally `"settled"`: that would contradict a response that
      // ends up `cancelled` for a reason other than external teardown (an
      // invalid/missing answer, or the permission-requested event itself
      // failing to post).
    }
  }

  // An answer that lands after the request was given up on can no longer be
  // honoured — the response has already gone back to the agent. It is dropped
  // either way; warning is what makes "my click did nothing" explicable.
  private discardLateAnswer(
    chosenId: string | undefined,
    controller: AbortController,
    roomId: string,
    sessionId: string,
  ): string | undefined {
    if (!controller.signal.aborted || chosenId === undefined) {
      return chosenId
    }

    this.safeWarn("resolvePermission answered after the request was abandoned; discarding", {
      roomId,
      sessionId,
      chosenId,
      reason: String(controller.signal.reason),
    })
    return undefined
  }

  // The only place a permission's controller is ever aborted, so every
  // `signal.reason` a consumer can observe comes from the documented union.
  private abandon(controller: AbortController, reason: ACPPermissionEndReason): void {
    controller.abort(reason)
  }

  private trackPending(sessionId: string, controller: AbortController): void {
    const pending = this.pendingPermissions.get(sessionId) ?? new Set<AbortController>()
    pending.add(controller)
    this.pendingPermissions.set(sessionId, pending)
  }

  private untrackPending(sessionId: string, controller: AbortController): void {
    const pending = this.pendingPermissions.get(sessionId)
    pending?.delete(controller)
    if (pending?.size === 0) {
      this.pendingPermissions.delete(sessionId)
    }
  }

  private cancelPendingPermissions(sessionId: string, reason: ACPPermissionAbandonReason): void {
    for (const controller of this.pendingPermissions.get(sessionId) ?? []) {
      this.abandon(controller, reason)
    }
  }

  private cancelAllPendingPermissions(reason: ACPPermissionAbandonReason): void {
    for (const sessionId of this.pendingPermissions.keys()) {
      this.cancelPendingPermissions(sessionId, reason)
    }
  }

  private pruneConnectionGeneration(generation: number): void {
    const prefix = `${generation}:`
    for (const key of [...this.abandonedSessions]) {
      if (key.startsWith(prefix)) {
        this.abandonedSessions.delete(key)
      }
    }
    for (const key of [...this.activeSessions]) {
      if (key.startsWith(prefix)) {
        this.activeSessions.delete(key)
      }
    }
    for (const key of [...this.bootstrappedSessions]) {
      if (key.startsWith(prefix)) {
        this.bootstrappedSessions.delete(key)
      }
    }
    for (const key of [...this.pendingPermissions.keys()]) {
      if (key.startsWith(prefix)) {
        this.cancelPendingPermissions(key, "connection-lost")
      }
    }
  }

  private async flushChunks(input: {
    client: BandACPClient;
    tools: AdapterToolsProtocol;
    sessionId: string;
    senderId: string;
    senderHandle: string;
  }): Promise<void> {
    for (const chunk of input.client.takeCollectedChunks(input.sessionId)) {
      // A status-only ACP update carries its meaning in metadata and has
      // nothing to post.
      if (isBlankEventContent(chunk.content)) {
        continue
      }

      if (chunk.chunkType === "text") {
        await deliverReply(input.tools, chunk.content, [{
          id: input.senderId,
          handle: input.senderHandle,
        }])
        continue
      }

      const messageType = chunk.chunkType === "plan"
        ? "task"
        : chunk.chunkType

      await input.tools.sendEvent(
        chunk.content,
        messageType,
        chunk.metadata,
      )
    }
  }
}

class AcpTurnTimeoutError extends Error {}

function validateTransport(
  command: string[],
  host: string | undefined,
  port: number | undefined,
): ACPClientTcpEndpoint | null {
  const hasHost = host !== undefined
  const hasPort = port !== undefined

  if (hasHost !== hasPort) {
    throw new ValidationError("ACPClientAdapter requires both host and port for a TCP connection")
  }

  if (hasHost && hasPort) {
    if (command.length > 0) {
      throw new ValidationError("ACPClientAdapter cannot use command with a TCP connection")
    }
    if (typeof host !== "string" || host.trim().length === 0) {
      throw new ValidationError("ACPClientAdapter TCP host must be a non-empty string")
    }
    if (!Number.isInteger(port) || port < MIN_TCP_PORT || port > MAX_TCP_PORT) {
      throw new ValidationError(
        `ACPClientAdapter TCP port must be an integer between ${MIN_TCP_PORT} and ${MAX_TCP_PORT}`,
      )
    }
    return { host, port }
  }

  if (command.length === 0 || typeof command[0] !== "string" || command[0].trim().length === 0) {
    throw new ValidationError("ACPClientAdapter requires a command or TCP host and port")
  }

  return null
}

export async function createSubprocessConnection(
  client: Client,
  options: {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<ACPClientConnectionHandle> {
  const acp = await acpModule.get()
  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  if (!child.stdin || !child.stdout) {
    throw new Error("ACP subprocess did not expose stdio pipes")
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  )

  const connection = new acp.ClientSideConnection(() => client, stream)

  return {
    connection,
    stop: async () => {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }

        let settled = false
        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          child.off("exit", finish)
          child.off("close", finish)
          resolve()
        }

        child.once("exit", finish)
        child.once("close", finish)

        if (!child.killed) {
          child.kill()
        }

        if (child.exitCode !== null || child.signalCode !== null) {
          finish()
        }
      })
    },
  }
}

export async function createTcpConnection(
  client: Client,
  endpoint: ACPClientTcpEndpoint,
  signal?: AbortSignal,
): Promise<ACPClientConnectionHandle> {
  const acp = await acpModule.get()
  if (signal?.aborted) {
    throw new Error(TCP_CONNECTION_ATTEMPT_ABORTED_ERROR)
  }
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const candidate = createConnection(endpoint)
    const cleanup = (): void => {
      candidate.off("error", fail)
      candidate.off("connect", connect)
      signal?.removeEventListener("abort", abort)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const connect = (): void => {
      cleanup()
      resolve(candidate)
    }
    const abort = (): void => {
      candidate.destroy()
      fail(new Error(TCP_CONNECTION_ATTEMPT_ABORTED_ERROR))
    }
    candidate.once("error", fail)
    candidate.once("connect", connect)
    signal?.addEventListener("abort", abort, { once: true })
  })
  const webSocket = Duplex.toWeb(socket)
  const stream = acp.ndJsonStream(
    webSocket.writable as WritableStream<Uint8Array>,
    webSocket.readable as ReadableStream<Uint8Array>,
  )
  const connection = new acp.ClientSideConnection(() => client, stream)
  let stopped = false

  return {
    connection,
    stop: async () => {
      if (stopped) {
        return
      }
      stopped = true
      socket.destroy()
      await connection.closed
    },
  }
}

// Config option id/category convention real agents use for the model
// selector (see `ACPModelRequest`'s doc comment).
const MODEL_CONFIG_OPTION_KEY = "model"


// `category` is the protocol's documented signal for "this is the model
// selector" and takes priority; `isModelConfigOptionById` below is
// consulted only as a fallback for an agent that omits `category` (the spec
// explicitly allows that) — `category` is an open string, so an unrelated
// option could otherwise be mismatched if both checks were given equal
// priority in one predicate.
function isModelConfigOption(
  option: SessionConfigOption,
): option is SessionConfigOption & SessionConfigSelect & { type: "select" } {
  return isSessionConfigSelect(option) && option.category === MODEL_CONFIG_OPTION_KEY
}

// Fallback for an agent that omits `category` — real agents (claude-agent-acp)
// key their model option `id: "model"` too. Only consulted when no entry
// matches `isModelConfigOption` above.
function isModelConfigOptionById(
  option: SessionConfigOption,
): option is SessionConfigOption & SessionConfigSelect & { type: "select" } {
  return isSessionConfigSelect(option) && option.id === MODEL_CONFIG_OPTION_KEY
}

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type {
  Client,
  ClientCapabilities,
  ClientSideConnection,
  InitializeResponse,
  McpServer,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import { AgentFailure } from "@band-ai/band-sdk-core";

import { ACPClientHistoryConverter, type ACPClientSessionState } from "../../converters/acp-client";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { resolveLogger, type Logger } from "../../core/logger";
import { ValidationError } from "../../core/errors";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { renderSystemPrompt } from "../../runtime/prompts";
import { mentionSubjectsFromMetadata, replaceUuidMentions } from "../../runtime/formatters";
import { abandon } from "../shared/abandon";
import { asErrorMessage } from "../shared/coercion";
import { deliverReply } from "../shared/deliveryFailedError";
import { FAILURE_CODE_TIMEOUT, agentFailure, reportTurnFailure } from "../shared/providerFailure";
import { systemUpdateParts } from "../shared/conversationPrompt";
import { withTimeout } from "../shared/withTimeout";
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
  type ACPClientConnectionHandle,
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

// Same default `OpencodeAdapter` uses for its own manual-approval wait
// (`approvalWaitTimeoutMs`) — an unanswered request shouldn't hang the
// agent's turn forever, but should give a human realistic time to notice it.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

// Deliberately much larger than the permission wait above: this bounds a whole
// agent turn, and ACP backends are coding agents whose turns routinely run for
// tens of minutes. It exists to catch a genuinely wedged agent, not to cap
// normal work — expiring it cancels the prompt and drops the room's session.
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;

// `setTimeout` silently clamps any larger delay to 1ms rather than erroring,
// so a finite timeout meant to mean "effectively unbounded" would fire almost
// immediately instead. Shared by every `setTimeout`-backed timeout below.
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

// The installed ACP SDK's `ClientSideConnection#sendRequest` has no timeout
// of its own — it waits forever for a matching response id — so an RPC that
// isn't waiting on a human (unlike `permissionTimeoutMs` above) still needs
// its own bound. Order-of-magnitude match for `OpencodeAdapter`'s own
// subprocess-handshake timeout: this is the same kind of wait, a local agent
// process acknowledging an administrative call, not doing model inference.
const SET_SESSION_MODE_TIMEOUT_MS = 10_000;

export interface ACPModeRequest {
  roomId: string;
  sessionId: string;
  currentModeId: string;
  modes: readonly SessionMode[];
}

export interface ACPClientAdapterOptions {
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  mcpServers?: McpServer[];
  authMethod?: string | null;
  enableMemoryTools?: boolean;
  enableMcpTools?: boolean;
  additionalMcpTools?: McpToolRegistration[];
  clientCapabilities?: ClientCapabilities;
  connectionFactory?: ACPClientConnectionFactory;
  // Omitted ⇒ every permission request auto-resolves via
  // `choosePermissionOption`, unchanged from today. Set ⇒ each request is
  // handed to this callback instead; its resolved id is used verbatim
  // (including a reject-kind id — that's a real deny, not a cancel).
  // `undefined` means only a genuine non-answer: dismissed, timed out,
  // threw, or resolved to an id absent from this request's own options.
  resolvePermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<string | undefined>;
  // Only meaningful when `resolvePermission` is set. Defaults to
  // `DEFAULT_PERMISSION_TIMEOUT_MS`.
  permissionTimeoutMs?: number;
  // Bounds every turn's `connection.prompt` call — a silent/stuck agent
  // otherwise produces no signal at all. Unlike `permissionTimeoutMs`, this
  // is unconditional: every turn is raced against it. Defaults to
  // `DEFAULT_TURN_TIMEOUT_MS`.
  turnTimeoutMs?: number;
  // ACP advertises session modes once a session is (re)established. This
  // callback receives that harness-owned catalog and may select one before
  // the session's first prompt. Omit it to preserve the harness's advertised
  // current mode. Applied via ACP's `session/set_mode`; ignored if the
  // resolved id isn't advertised. Best-effort and one-time per session: a
  // failed switch only logs a warning, and an agent that later changes mode
  // on its own (ACP's `current_mode_update`) is neither tracked nor
  // re-asserted.
  resolveSessionMode?: (request: ACPModeRequest, signal: AbortSignal) => Promise<string | undefined>;
  logger?: Logger;
}

export class ACPClientAdapter extends SimpleAdapter<ACPClientSessionState, AdapterToolsProtocol> {
  protected readonly provider = "acp";

  private readonly command: string[]
  private readonly cwd: string
  private readonly env?: Record<string, string>
  private readonly mcpServers: McpServer[]
  private readonly authMethod?: string | null
  private readonly enableMemoryTools: boolean
  private readonly enableMcpTools: boolean
  private readonly additionalMcpTools: McpToolRegistration[]
  private readonly clientCapabilities?: ClientCapabilities
  private readonly connectionFactory: ACPClientConnectionFactory

  // The value's `generation` is the connection generation the session was
  // last established/restored against — see `cleanupOwnSession`'s doc
  // comment for why matching `sessionId` alone isn't ownership proof. `client`
  // is the exact `BandACPClient` instance the session was established
  // against, preserved here rather than read from the live `this.client` at
  // cleanup time — see `cleanupOwnSession`'s doc comment for why the two can
  // differ. `null` only for a room rehydrated from persisted history, which
  // has no live connection to record yet.
  private readonly roomToSession = new Map<string, { sessionId: string; generation: number; client: BandACPClient | null }>()
  private readonly roomTools = new Map<string, AdapterToolsProtocol>()
  // Keyed by `sessionKey(generation, sessionId)`, not bare `sessionId`: an
  // ACP agent can reissue the identical session id for a room across a
  // reconnect (see `roomToSession`'s comment above), and these three sets/
  // maps have no other ownership record of their own the way `roomToSession`
  // does — a bare-id key would let a stale generation's entry alias a
  // same-id session that is genuinely live on a newer connection.
  private readonly activeSessions = new Set<string>()
  private readonly bootstrappedSessions = new Set<string>()
  private readonly pendingPermissions = new Map<string, Set<AbortController>>()

  private readonly resolvePermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly resolveSessionMode?: (request: ACPModeRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly permissionTimeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly logger: Logger

  private backend: InjectedMcpBackend | null = null
  private backendPromise: Promise<InjectedMcpBackend> | null = null
  private client: BandACPClient | null = null
  private connectionHandle: ACPClientConnectionHandle | null = null
  private connection: ClientSideConnection | null = null
  private connectionState: InitializeResponse | null = null
  private started = false
  private systemPrompt = ""
  private spawnPromise: Promise<ClientSideConnection> | null = null
  // Bumped by `stop()`; an in-flight `spawnConnection()` checks this against
  // its own captured value before installing itself, so a superseded attempt
  // (stop() raced against a slow connect) stops its own handle instead of
  // silently resurrecting a deliberately-stopped adapter.
  private connectionGeneration = 0

  public constructor(options: ACPClientAdapterOptions) {
    super({
      historyConverter: new ACPClientHistoryConverter(),
    })

    this.command = Array.isArray(options.command) ? [...options.command] : [options.command]
    if (this.command.length === 0 || this.command[0].length === 0) {
      throw new Error("ACPClientAdapter requires a command")
    }

    this.cwd = options.cwd ?? process.cwd()
    this.env = options.env
    this.mcpServers = [...(options.mcpServers ?? [])]
    this.authMethod = options.authMethod
    this.enableMemoryTools = options.enableMemoryTools ?? false
    this.enableMcpTools = options.enableMcpTools ?? true
    this.additionalMcpTools = [...(options.additionalMcpTools ?? [])]
    this.clientCapabilities = options.clientCapabilities
    this.connectionFactory = options.connectionFactory ?? createSubprocessConnection

    this.resolvePermission = options.resolvePermission
    this.resolveSessionMode = options.resolveSessionMode
    this.logger = resolveLogger(options.logger)
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    // Only meaningful when `resolvePermission` is actually set — the
    // auto-allow path never reads it, so an irrelevant/default value here
    // shouldn't reject an otherwise-valid config for a caller not using
    // manual mode at all.
    if ((this.resolvePermission || this.resolveSessionMode) && (!Number.isFinite(this.permissionTimeoutMs) || this.permissionTimeoutMs <= 0)) {
      throw new ValidationError(`permissionTimeoutMs must be a positive finite number, got ${options.permissionTimeoutMs}`)
    }
    // Same `setTimeout` clamp hazard as turnTimeoutMs below: unlike that field,
    // permissionTimeoutMs has no `Infinity` opt-out, so this must gate on the
    // exact same condition as the finite/positive check above — a mode-only
    // config (`resolveSessionMode` set, `resolvePermission` unset) still feeds
    // this value into `resolveSessionModeManually`'s own `setTimeout` call.
    if ((this.resolvePermission || this.resolveSessionMode) && this.permissionTimeoutMs > MAX_SETTIMEOUT_DELAY_MS) {
      throw new ValidationError(`permissionTimeoutMs must be at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${options.permissionTimeoutMs}`)
    }

    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    // Unconditional, unlike permissionTimeoutMs's gated check above: every
    // turn is raced against this, not just an opt-in manual-approval path.
    // `Infinity` is the escape hatch back to the pre-timeout behaviour: an ACP
    // turn that legitimately runs past the cap loses its session and its
    // buffered output, so a caller must be able to opt out rather than having
    // the only way to say "unbounded" rejected at construction.
    if (Number.isNaN(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) {
      throw new ValidationError(`turnTimeoutMs must be a positive number or Infinity, got ${options.turnTimeoutMs}`)
    }
    if (Number.isFinite(this.turnTimeoutMs) && this.turnTimeoutMs > MAX_SETTIMEOUT_DELAY_MS) {
      throw new ValidationError(`turnTimeoutMs must be Infinity or at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${options.turnTimeoutMs}`)
    }
  }

  public async onStarted(
    agentName: string,
    agentDescription: string,
  ): Promise<void> {
    await super.onStarted(agentName, agentDescription)
    this.started = true
    this.systemPrompt = renderSystemPrompt({
      agentName,
      agentDescription,
      includeBaseInstructions: false,
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

    const { connection, client, sessionId, generation } = await this.establishSession(tools, context)

    const promptText = this.buildPromptText(message, participantsMessage, contactsMessage, context.roomId, sessionId, generation)
    this.bootstrappedSessions.add(this.sessionKey(generation, sessionId))

    let response: PromptResponse
    try {
      response = await this.sendPromptWithTimeout(connection, sessionId, promptText)
    } catch (error) {
      response = await this.failTurn(error, connection, client, generation, sessionId, tools, message, context)
    }

    await this.finishTurn(client, tools, sessionId, context.roomId, message, response)
  }

  // Connection/session establishment is genuinely connection-level: on
  // failure, a global stop() is appropriate since the shared process/
  // handshake may be broken for every room, not just this one.
  private async establishSession(
    tools: AdapterToolsProtocol,
    context: { roomId: string },
  ): Promise<{ connection: ClientSideConnection; client: BandACPClient; sessionId: string; generation: number }> {
    // Captured before the connection is touched, and never reassigned:
    // `stopOwnedConnection` below must stay conservative about tearing down
    // what every room shares, so a mismatch against the generation in scope
    // *before this attempt even started* — whether from a reconnect this
    // same call's own `ensureConnection()` just performed, or one some other
    // concurrent turn did — is reason enough to skip it. `generation` below
    // is the separate, precise value actually threaded through this
    // session's own bookkeeping; the two serve different purposes and must
    // not be conflated into one variable.
    const attemptGeneration = this.connectionGeneration

    try {
      const { connection, generation } = await this.ensureConnection()
      const client = this.client
      if (!client) {
        throw new Error("ACP client was not initialized")
      }

      const sessionId = await this.getOrCreateSession(context.roomId, connection, generation, client)
      client.beginSession(sessionId)
      client.setPermissionHandler(
        sessionId,
        (params) => this.handlePermissionRequest(tools, context.roomId, generation, params),
      )
      // `generation` throughout, never a later read of the mutable
      // `this.connectionGeneration`: `getOrCreateSession`'s own async RPC
      // work (newSession/restore/mode configuration) can outlive this exact
      // connection if it dies mid-call, during which another turn can
      // legitimately reconnect and bump the counter further — returning that
      // later value here would mislabel this session with a generation it
      // was never actually established against.
      return { connection, client, sessionId, generation }
    } catch (error) {
      await this.stopOwnedConnection(attemptGeneration, context.roomId)
      // Reports and throws: a connection/session-establishment failure is a
      // provider failure like any other, and must fail the turn so
      // PlatformRuntime marks the message failed and retries it instead of
      // silently treating it as processed.
      return reportTurnFailure(tools, new AgentFailure(this.provider, asErrorMessage(error)), this.logger, { roomId: context.roomId })
    }
  }

  private buildPromptText(
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
    roomId: string,
    sessionId: string,
    generation: number,
  ): string {
    // The platform stores a typed mention as @[[participant_id]]; nothing else
    // in ACP resolves that back to a handle, so the agent reads a bare id as
    // an MCP protocol token instead of as being spoken to.
    const content = replaceUuidMentions(message.content, mentionSubjectsFromMetadata(message.metadata))

    // ExecutionContext.consumeParticipantsMessage is edge-triggered: it only
    // returns a value on the turn the roster actually changed, then clears
    // itself. Injecting it here, on every turn it's non-null, is the only
    // chance ACP gets to see it at all.
    const messageWithContext = [...systemUpdateParts(participantsMessage, contactsMessage), content].join("\n\n")

    return this.bootstrappedSessions.has(this.sessionKey(generation, sessionId))
      ? messageWithContext
      : `${this.buildSystemContext(roomId, message)}\n\n${messageWithContext}`
  }

  // Prompt-scoped: a timeout or a rejected prompt means only this room's
  // session is done for; the connection and every other room stay up.
  private async sendPromptWithTimeout(
    connection: ClientSideConnection,
    sessionId: string,
    promptText: string,
  ): Promise<PromptResponse> {
    const promptPromise = connection.prompt({
      sessionId,
      prompt: [{
        type: "text",
        text: promptText,
      }],
    })

    return withTimeout(promptPromise, this.turnTimeoutMs, () => new AcpTurnTimeoutError())
  }

  private async failTurn(
    error: unknown,
    connection: ClientSideConnection,
    client: BandACPClient,
    generation: number,
    sessionId: string,
    tools: AdapterToolsProtocol,
    message: PlatformMessage,
    context: { roomId: string },
  ): Promise<never> {
    const isTimeout = error instanceof AcpTurnTimeoutError
    if (isTimeout) {
      // `cancel` is a notification whose write can stay pending indefinitely
      // behind an agent that has stopped draining its stdin — the very state
      // this timeout exists to escape. See `abandon`.
      abandon(
        () => connection.cancel({ sessionId }),
        (cancelError) => {
          this.logger.warn("ACP cancel after turn timeout failed", { roomId: context.roomId, sessionId, error: cancelError })
        },
      )
    }
    // Whatever the turn streamed before failing is still worth having — on a
    // 60-minute timeout that can be an hour of a coding agent's output — and
    // onCleanup below drops the buffer with the session. Best-effort: a reply
    // that will not post must not displace the failure reported after it.
    // `client` is the exact instance this turn established its session
    // against, captured in `establishSession` — not `this.client`, which may
    // already point at a reconnected replacement by the time this runs. Flushing
    // the live client's buffer here would either lose this turn's real output
    // (empty buffer on the new client) or, worse, if the replacement session
    // reused the same session id, hand a later turn's streamed content to this
    // turn's sender.
    try {
      await this.flushChunks({
        client,
        tools,
        sessionId,
        senderId: message.senderId,
        senderHandle: message.senderName ?? message.senderType,
      })
    } catch (flushError) {
      this.logger.warn("ACP partial output lost after turn failure", { roomId: context.roomId, sessionId, error: flushError })
    }
    // Best-effort, same reasoning as establishSession's failure path: this
    // cleanup is simple/local today, but must never be allowed to swallow the
    // original failure if that changes. Scoped to `sessionId`, not the
    // room-wide `onCleanup(roomId)`: this call can run long after a stuck
    // `resetRoomSession` already tore the room down and a replacement turn
    // opened a fresh session for it, and an unconditional roomId-keyed clear
    // here would delete the replacement's mapping instead of this turn's own
    // — including when the replacement's agent reissued this exact session
    // id on a new connection, which is why `generation` matters too (see
    // `cleanupOwnSession`'s doc comment).
    try {
      this.cleanupOwnSession(context.roomId, sessionId, generation, client)
    } catch (cleanupError) {
      this.logger.warn("ACP session cleanup after turn failure itself failed", { roomId: context.roomId, sessionId, error: cleanupError })
    }
    // Reports and throws, like every other terminal provider failure in this
    // file: a turn-level failure (timeout, rejected prompt) must fail the turn
    // so PlatformRuntime marks the message failed and retries it, instead of
    // returning here and silently dropping that retry.
    return reportTurnFailure(
      tools,
      isTimeout
        ? new AgentFailure(this.provider, "ACP turn timed out.", FAILURE_CODE_TIMEOUT)
        : isAcpErrorResponse(error)
          ? agentFailure(this.provider, error.message, String(error.code), error.data)
          : new AgentFailure(this.provider, asErrorMessage(error)),
      this.logger,
      { roomId: context.roomId, sessionId },
    )
  }

  private async finishTurn(
    client: BandACPClient,
    tools: AdapterToolsProtocol,
    sessionId: string,
    roomId: string,
    message: PlatformMessage,
    response: PromptResponse,
  ): Promise<void> {
    await this.flushChunks({
      client,
      tools,
      sessionId,
      senderId: message.senderId,
      senderHandle: message.senderName ?? message.senderType,
    })

    // A *resolved* prompt() isn't automatically a success — max_tokens/
    // max_turn_requests/refusal/cancelled are real provider-declared
    // non-success outcomes. Whatever partial content the turn produced is
    // still flushed above, unchanged. `?.` despite the non-nullable type:
    // response is a deserialized wire value from an external agent process,
    // and a missing body must not throw here — it belongs in the failure
    // report below instead.
    const stopReason: string | undefined = response?.stopReason

    // This event's metadata is the only record `ACPClientHistoryConverter`
    // rebuilds room→session from, so it has to be written for any outcome
    // that leaves the session alive — including the non-success report
    // below, which fails the turn but does not tear the session down the
    // way `failTurn`'s timeout path does.
    await tools.sendEvent("ACP client session", "task", {
      acp_client_session_id: sessionId,
      acp_client_room_id: roomId,
    })

    if (stopReason === "end_turn") {
      return
    }

    // Reports and throws, like every other terminal provider failure in this
    // file: a non-success stop reason must fail the turn so PlatformRuntime
    // marks the message failed and retries it, instead of returning here and
    // silently counting a stalled/refused/cancelled turn as processed.
    return reportTurnFailure(
      tools,
      new AgentFailure(
        this.provider,
        `ACP turn ended with stop reason: ${stopReason ?? "unknown"}.`,
        stopReason,
      ),
      this.logger,
      { roomId, sessionId },
    )
  }

  public async onCleanup(roomId: string): Promise<void> {
    const owner = this.roomToSession.get(roomId)
    if (owner) {
      this.cleanupOwnSession(roomId, owner.sessionId, owner.generation, owner.client)
    } else {
      this.roomToSession.delete(roomId)
      this.roomTools.delete(roomId)
    }
  }

  /**
   * Clears a room's session bookkeeping, but only if `roomId` still maps to
   * this exact `sessionId` *and* `generation` — the mapping is the room's
   * single ownership record, so a caller whose session no longer matches it
   * no longer owns the room and must not clear anything (see `failTurn`'s
   * use, the reason this check exists).
   *
   * `sessionId` alone is not proof of ownership: an ACP agent can reissue
   * the identical session id for a room across a reconnect (e.g. one that
   * persists conversation state by directory rather than minting a fresh id
   * per connection), so a stale turn's own id can still string-match a
   * replacement's session without actually being it. `generation` — the
   * connection generation the mapping was last stamped with, in
   * `getOrCreateSession`'s `setRoomSession` — disambiguates that case: a
   * same-id session re-established on a newer connection gets a newer
   * generation, so a stale turn's now-mismatched generation correctly loses
   * the race even though its `sessionId` still matches.
   *
   * `client` is always the exact instance `sessionId`/`generation` were
   * established against — `owner.client` from `roomToSession` for
   * `onCleanup`'s room-level call, or the turn-captured client for
   * `failTurn` — never the live `this.client`: a reconnect between
   * establishment and cleanup may already have replaced it with a different
   * instance that has since started serving a same-id session for a
   * *different* room (see `roomToSession`'s comment), and resetting that
   * instance's session state would corrupt the other room's live output and
   * permission handler instead of just releasing this one's.
   */
  private cleanupOwnSession(
    roomId: string,
    sessionId: string,
    generation: number,
    client: BandACPClient | null,
  ): void {
    const owner = this.roomToSession.get(roomId)
    if (!owner || owner.sessionId !== sessionId || owner.generation !== generation) {
      return
    }
    this.roomToSession.delete(roomId)
    this.roomTools.delete(roomId)
    this.activeSessions.delete(this.sessionKey(generation, sessionId))
    this.bootstrappedSessions.delete(this.sessionKey(generation, sessionId))
    // Drops this session's buffered chunks along with its permission
    // handler. The chunks matter now that a failed turn cleans up its room
    // rather than stopping the adapter: the client survives that, and a
    // session no room can reach again would hold its output forever.
    client?.resetSession(sessionId)
    this.cancelPendingPermissions(sessionId, generation)
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop()
  }

  public async stop(): Promise<void> {
    // Must run first: this is what any in-flight spawnConnection() checks
    // its own captured generation against.
    this.connectionGeneration++
    this.spawnPromise = null
    this.connectionState = null
    this.activeSessions.clear()
    this.bootstrappedSessions.clear()
    this.roomToSession.clear()
    this.roomTools.clear()
    this.cancelAllPendingPermissions()

    this.client = null
    this.connection = null

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

  /**
   * Tears down the shared connection, but only if this turn still owns it.
   * The generation guard in `spawnConnection` stops a superseded attempt from
   * *installing* itself; the attempt still rejects, and that rejection can
   * arrive long after a newer connection replaced it. Stopping unconditionally
   * there would kill a connection this turn never held.
   *
   * Best-effort: `stop()` runs externally-supplied teardown that can itself
   * reject, and the failure that brought us here must still reach the room.
   */
  private async stopOwnedConnection(generation: number, roomId: string): Promise<void> {
    if (generation !== this.connectionGeneration) {
      return
    }

    try {
      await this.stop()
    } catch (stopError) {
      this.logger.warn("ACP stop() after connection failure itself failed", { roomId, error: stopError })
    }
  }

  private rehydrate(history: ACPClientSessionState): void {
    for (const [roomId, sessionId] of Object.entries(history.roomToSession)) {
      if (!this.roomToSession.has(roomId)) {
        // No live connection owns this yet — the room's first real turn
        // re-stamps this via `getOrCreateSession`'s `setRoomSession` once it
        // actually (re)establishes the session, same as any other room.
        this.roomToSession.set(roomId, { sessionId, generation: this.connectionGeneration, client: null })
      }
    }
  }

  // Returns `generation` alongside `connection` as one atomic pair, read in
  // the same synchronous continuation the connection itself is obtained in —
  // callers must thread this value through rather than reading
  // `this.connectionGeneration` again later, after their own further await:
  // a reconnect elsewhere can bump the counter in the meantime, and a late
  // read would then mislabel work done against *this* connection with a
  // generation number that belongs to a different one.
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
      // No await between spawnPromise resolving and this read: `spawnConnection`
      // installs `this.connection` and bumps `this.connectionGeneration` in the
      // same synchronous stretch before its promise settles, so this is
      // guaranteed to be the exact generation `connection` was installed at.
      return { connection, generation: this.connectionGeneration }
    } finally {
      // Only the creator clears the slot, and only if it still holds the
      // promise created above — `stop()` (or a newer attempt superseding
      // this one) may already have replaced it while this was in flight.
      if (isCreator && this.spawnPromise === spawnPromise) {
        this.spawnPromise = null
      }
    }
  }

  private async spawnConnection(): Promise<ClientSideConnection> {
    const generation = this.connectionGeneration
    const acp = await acpModule.get()
    const client = new BandACPClient()
    const handle = await this.connectionFactory(client as Client, {
      command: this.command,
      cwd: this.cwd,
      env: this.env,
    })
    const connection = handle.connection

    let initializeResult: InitializeResponse
    try {
      initializeResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: this.clientCapabilities ?? {},
      })

      if (this.authMethod) {
        await connection.authenticate({
          methodId: this.authMethod,
        })
      }
    } catch (error) {
      // handle was never installed anywhere else — this is the only place
      // left that can stop it. Best-effort, same reasoning as onMessage's
      // catches: an externally-supplied handle.stop() that itself rejects
      // must not replace the real handshake failure.
      try {
        await handle.stop()
      } catch (stopError) {
        this.logger.warn("ACP connection handle stop after handshake failure itself failed", { error: stopError })
      }
      throw error
    }

    if (generation !== this.connectionGeneration) {
      // stop() (or a newer connection attempt) superseded this one while we
      // were establishing it. Stop our own handle instead of installing a
      // stale connection back onto the adapter.
      await handle.stop()
      throw new Error("ACP connection attempt superseded by stop()")
    }

    // Bumped here too, not just in stop(): this may be a silent reconnect
    // (the previous connection died and this replaces it without anyone
    // calling stop()) rather than a fresh start. Without this, a generation
    // captured against the now-dead connection would still match here, and a
    // turn that failed against that dead connection could tear down the
    // brand-new one installed below out from under every other room.
    this.connectionGeneration++
    this.client = client
    this.connection = connection
    this.connectionHandle = handle
    this.connectionState = initializeResult

    void connection.closed.finally(() => {
      if (this.connection === connection) {
        this.connection = null
        this.connectionHandle = null
        this.connectionState = null
        this.activeSessions.clear()
      }
    })

    return connection
  }

  private async getOrCreateSession(
    roomId: string,
    connection: ClientSideConnection,
    generation: number,
    client: BandACPClient,
  ): Promise<string> {
    const owner = this.roomToSession.get(roomId)

    // Requires the owner's *own* generation to match this call's, not just
    // `activeSessions` membership: `activeSessions` is cleared wholesale on
    // any connection loss, but a session id an agent reissues identically
    // across a reconnect could otherwise get re-admitted into a freshly
    // (re)populated set under a stale room's still-cached id — see
    // `roomToSession`'s comment.
    if (owner && owner.generation === generation && this.activeSessions.has(this.sessionKey(generation, owner.sessionId))) {
      return owner.sessionId
    }

    const mcpServers = await this.buildSessionMcpServers()
    const existingSessionId = owner?.sessionId

    if (existingSessionId) {
      const restored = await this.tryRestoreSession(connection, existingSessionId, mcpServers)
      if (restored.ok) {
        // Marked active/bootstrapped before the best-effort mode switch below
        // is awaited: `configureSessionMode` makes a real RPC call, and a
        // connection drop mid-call clears `activeSessions` (see
        // `spawnConnection`'s `closed.finally()`) — running this after that
        // await would let a stale add silently re-admit a session whose
        // connection just died.
        this.activeSessions.add(this.sessionKey(generation, existingSessionId))
        this.bootstrappedSessions.add(this.sessionKey(generation, existingSessionId))
        // Re-stamps the generation even though `sessionId` is unchanged: a
        // restore can land on a different connection than last time, and a
        // stale turn from the *previous* connection must not be able to
        // pass `cleanupOwnSession`'s ownership check against this one.
        this.setRoomSession(roomId, existingSessionId, generation, client)
        await this.configureSessionMode(roomId, existingSessionId, restored.modes, connection)
        return existingSessionId
      }
    }

    const created = await connection.newSession({
      cwd: this.cwd,
      mcpServers,
    })

    // Same ordering reason as the restored-session branch above.
    this.setRoomSession(roomId, created.sessionId, generation, client)
    this.activeSessions.add(this.sessionKey(generation, created.sessionId))
    await this.configureSessionMode(roomId, created.sessionId, created.modes, connection)
    return created.sessionId
  }

  /**
   * Composite key so `activeSessions`/`bootstrappedSessions`/
   * `pendingPermissions` can't alias an identical session id reissued on a
   * different connection generation — see `roomToSession`'s comment.
   */
  private sessionKey(generation: number, sessionId: string): string {
    return `${generation}:${sessionId}`
  }

  /**
   * Records which connection generation currently owns a room's session —
   * see `cleanupOwnSession`'s doc comment for why `sessionId` alone can't
   * tell a stale turn's session apart from a same-id replacement. `generation`
   * is always the caller's own immutable value from `ensureConnection`, never
   * a fresh read of the mutable `this.connectionGeneration` — see
   * `establishSession`'s comment on why a late read can mislabel a session.
   *
   * Never publishes over a newer generation: `getOrCreateSession`'s own
   * newSession/loadSession RPC can still be in flight when a *later* call for
   * the same room, on a newer generation, already published its own session —
   * that later publish must win. Without this guard, the earlier attempt's
   * late-resolving write would overwrite a live session with a stale one the
   * next turn would then needlessly abandon (see `getOrCreateSession`'s
   * generation-match fast path).
   */
  private setRoomSession(roomId: string, sessionId: string, generation: number, client: BandACPClient | null): void {
    const currentOwner = this.roomToSession.get(roomId)
    if (currentOwner && currentOwner.generation > generation) {
      return
    }
    this.roomToSession.set(roomId, { sessionId, generation, client })
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

    const selectedModeId = await this.resolveSessionModeManually(
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
      this.logger.warn("resolveSessionMode selected a mode id this session does not advertise", {
        sessionId,
        selectedModeId,
        availableModeIds: availableModes.map((mode) => mode?.id),
      })
      return
    }

    try {
      await withTimeout(
        connection.setSessionMode({ sessionId, modeId: selectedModeId }),
        SET_SESSION_MODE_TIMEOUT_MS,
        `setSessionMode did not respond within ${SET_SESSION_MODE_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      this.logger.warn("failed to switch session into the selected mode", {
        sessionId,
        selectedModeId,
        error: String(error),
      })
    }
  }

  private async resolveSessionModeManually(
    resolver: (signal: AbortSignal) => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const cancelled = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.permissionTimeoutMs)
      })
      return await Promise.race([
        Promise.resolve().then(() => resolver(controller.signal)).catch((error) => {
          this.logger.warn("resolveSessionMode threw; preserving the harness default", { error: String(error) })
          return undefined
        }),
        timeout,
        cancelled,
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.abort()
    }
  }

  private async tryRestoreSession(
    connection: ClientSideConnection,
    sessionId: string,
    mcpServers: McpServer[],
  ): Promise<{ ok: true; modes?: SessionModeState | null } | { ok: false }> {
    const capabilities = this.connectionState?.agentCapabilities
    const params = { cwd: this.cwd, mcpServers, sessionId }

    // `loadSession`/`unstable_resumeSession` share both their params and
    // their response shape (`{ ...; modes?: SessionModeState | null }`);
    // resolve which one applies once, then handle the result once.
    const restore = capabilities?.loadSession
      ? () => connection.loadSession(params)
      : capabilities?.sessionCapabilities?.resume
        ? () => connection.unstable_resumeSession(params)
        : null

    if (!restore) {
      return { ok: false }
    }

    try {
      // `?.`: the ACP client doesn't runtime-validate this response, and the
      // installed SDK's own `unstable_resumeSession` has no fallback for a
      // nullish resolution the way its `loadSession` does — a restore that
      // genuinely succeeded must not be miscategorized as failed just
      // because no mode state came back with it.
      const restored = await restore()
      return { ok: true, modes: restored?.modes }
    } catch {
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

  private async handlePermissionRequest(
    tools: AdapterToolsProtocol,
    roomId: string,
    generation: number,
    params: RequestPermissionRequest,
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
      this.trackPending(params.sessionId, generation, controller)
    }

    const [, chosenId] = await Promise.all([
      // This is the room's only "a permission request is pending" signal,
      // and the only one other room participants ever see — started
      // immediately rather than serialized in front of a manual wait that
      // can take up to `permissionTimeoutMs`.
      tools.sendEvent(`Permission requested: ${toolName}`, "tool_call", {
        permission_request: true,
        tool_name: toolName,
        tool_call_id: params.toolCall.toolCallId,
        acp_session_id: params.sessionId,
        auto_allowed: autoSelection !== undefined && autoSelection !== null,
      }),
      controller
        ? this.resolveManually(params.sessionId, generation, params, controller)
        : Promise.resolve(autoSelection?.optionId),
    ])

    return this.toResponse(chosenId, params.options)
  }

  // `undefined`, or an id absent from this request's own `options` (a buggy
  // or stale caller), both map to `cancelled` — never silently treated as a
  // deny. A real match, reject-kind options included, maps to `selected`.
  private toResponse(chosenId: string | undefined, options: PermissionOption[]): RequestPermissionResponse {
    const matched = chosenId !== undefined && options.some((option) => option.optionId === chosenId)
    return matched
      ? { outcome: { outcome: "selected", optionId: chosenId } }
      : { outcome: { outcome: "cancelled" } }
  }

  // Races the caller-supplied resolver against a timeout and against
  // `controller`'s own abort signal — aborted externally by
  // `cancelPendingPermissions`/`cancelAllPendingPermissions` (fired from
  // `onCleanup`/`stop()` below) when a room or the whole adapter tears down
  // while this is still pending. `controller` is the same object tracked in
  // `pendingPermissions` by the caller, so there is exactly one cancellation
  // channel here, not a second hand-rolled one alongside it.
  private async resolveManually(
    sessionId: string,
    generation: number,
    params: RequestPermissionRequest,
    controller: AbortController,
  ): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined))
    })

    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.permissionTimeoutMs)
      })

      return await Promise.race([
        // `resolvePermission` is caller-supplied; nothing guarantees it's
        // `async` or otherwise well-behaved. `Promise.resolve().then(...)`
        // normalizes a synchronous throw the same way it normalizes a
        // rejected promise, so both land in the `.catch` below rather than
        // escaping this race uncaught.
        Promise.resolve()
          .then(() => this.resolvePermission!(params, controller.signal))
          .catch((error) => {
            this.logger.warn("resolvePermission threw; treating as no answer", { error: String(error) })
            return undefined
          }),
        timeout,
        cancelled,
      ])
    } finally {
      clearTimeout(timer)
      this.untrackPending(sessionId, generation, controller)
      controller.abort()
    }
  }

  private trackPending(sessionId: string, generation: number, controller: AbortController): void {
    const key = this.sessionKey(generation, sessionId)
    const pending = this.pendingPermissions.get(key) ?? new Set<AbortController>()
    pending.add(controller)
    this.pendingPermissions.set(key, pending)
  }

  private untrackPending(sessionId: string, generation: number, controller: AbortController): void {
    const key = this.sessionKey(generation, sessionId)
    const pending = this.pendingPermissions.get(key)
    pending?.delete(controller)
    if (pending?.size === 0) {
      this.pendingPermissions.delete(key)
    }
  }

  private cancelPendingPermissions(sessionId: string, generation: number): void {
    const key = this.sessionKey(generation, sessionId)
    for (const controller of this.pendingPermissions.get(key) ?? []) {
      controller.abort()
    }
  }

  // A full teardown, not scoped to one generation: every still-pending
  // permission request on any connection this adapter has ever owned must be
  // cancelled, so this iterates the map directly rather than reconstructing
  // per-generation keys.
  private cancelAllPendingPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      for (const controller of pending) {
        controller.abort()
      }
    }
    this.pendingPermissions.clear()
  }

  private async flushChunks(input: {
    client: BandACPClient;
    tools: AdapterToolsProtocol;
    sessionId: string;
    senderId: string;
    senderHandle: string;
  }): Promise<void> {
    for (const chunk of input.client.getCollectedChunks(input.sessionId)) {
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
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
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

// Its only job is letting the turn's catch tell "we gave up waiting" apart
// from "the agent rejected the prompt" — it never crosses a process boundary.
class AcpTurnTimeoutError extends Error {}

// A structural guard, not `instanceof RequestError`: `connection.prompt(...)`
// rejects with the plain deserialized wire object (`{code, message, data?}`),
// never re-wrapped into a `RequestError` instance (that class is only used
// on the agent side to *construct* an outgoing error response).
function isAcpErrorResponse(error: unknown): error is { code: number; message: string; data?: unknown } {
  return typeof error === "object" && error !== null
    && typeof (error as { code?: unknown }).code === "number"
    && typeof (error as { message?: unknown }).message === "string"
}

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type {
  Client,
  ClientCapabilities,
  ClientSideConnection,
  InitializeResponse,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeId,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import { ACPClientHistoryConverter, type ACPClientSessionState } from "../../converters/acp-client";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { NoopLogger, type Logger } from "../../core/logger";
import { ValidationError } from "../../core/errors";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { renderSystemPrompt } from "../../runtime/prompts";
import { mentionSubjectsFromMetadata, replaceUuidMentions } from "../../runtime/formatters";
import { systemUpdateParts } from "../shared/conversationPrompt";
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

// The installed ACP SDK's `ClientSideConnection#sendRequest` has no timeout
// of its own — it waits forever for a matching response id — so an RPC that
// isn't waiting on a human (unlike `permissionTimeoutMs` above) still needs
// its own bound. Order-of-magnitude match for `OpencodeAdapter`'s own
// subprocess-handshake timeout: this is the same kind of wait, a local agent
// process acknowledging an administrative call, not doing model inference.
const SET_SESSION_MODE_TIMEOUT_MS = 10_000;

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
  // Applied via ACP's `session/set_mode` once a session is (re)established —
  // `newSession` has no field for this. Ignored if the agent doesn't
  // advertise this mode id.
  requestedPermissionMode?: SessionModeId;
  logger?: Logger;
}

export class ACPClientAdapter extends SimpleAdapter<ACPClientSessionState, AdapterToolsProtocol> {
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

  private readonly roomToSession = new Map<string, string>()
  private readonly roomTools = new Map<string, AdapterToolsProtocol>()
  private readonly activeSessions = new Set<string>()
  private readonly bootstrappedSessions = new Set<string>()
  private readonly pendingPermissions = new Map<string /* sessionId */, Set<AbortController>>()

  private readonly resolvePermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<string | undefined>
  private readonly permissionTimeoutMs: number
  private readonly requestedPermissionMode?: SessionModeId
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
    this.logger = options.logger ?? new NoopLogger()
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    this.requestedPermissionMode = options.requestedPermissionMode
    // Only meaningful when `resolvePermission` is actually set — the
    // auto-allow path never reads it, so an irrelevant/default value here
    // shouldn't reject an otherwise-valid config for a caller not using
    // manual mode at all.
    if (this.resolvePermission && (!Number.isFinite(this.permissionTimeoutMs) || this.permissionTimeoutMs <= 0)) {
      throw new ValidationError(`permissionTimeoutMs must be a positive finite number, got ${options.permissionTimeoutMs}`)
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

    const connection = await this.ensureConnection()
    const client = this.client
    if (!client) {
      throw new Error("ACP client was not initialized")
    }

    const sessionId = await this.getOrCreateSession(context.roomId, connection)
    client.resetSession(sessionId)
    client.setPermissionHandler(
      sessionId,
      (params) => this.handlePermissionRequest(tools, context.roomId, params),
    )

    // The platform stores a typed mention as @[[participant_id]]; nothing else
    // in ACP resolves that back to a handle, so the agent reads a bare id as
    // an MCP protocol token instead of as being spoken to.
    const content = replaceUuidMentions(message.content, mentionSubjectsFromMetadata(message.metadata))

    // ExecutionContext.consumeParticipantsMessage is edge-triggered: it only
    // returns a value on the turn the roster actually changed, then clears
    // itself. Injecting it here, on every turn it's non-null, is the only
    // chance ACP gets to see it at all.
    const messageWithContext = [...systemUpdateParts(participantsMessage, contactsMessage), content].join("\n\n")

    const promptText = this.bootstrappedSessions.has(sessionId)
      ? messageWithContext
      : `${this.buildSystemContext(context.roomId, message)}\n\n${messageWithContext}`

    this.bootstrappedSessions.add(sessionId)

    try {
      await connection.prompt({
        sessionId,
        prompt: [{
          type: "text",
          text: promptText,
        }],
      })
    } catch (error) {
      await this.stop()
      await tools.sendEvent(`ACP agent error: ${toErrorMessage(error)}`, "error", {
        acp_error: toErrorMessage(error),
      })
      return
    }

    await this.flushChunks({
      tools,
      sessionId,
      senderId: message.senderId,
      senderHandle: message.senderName ?? message.senderType,
    })

    await tools.sendEvent("ACP client session", "task", {
      acp_client_session_id: sessionId,
      acp_client_room_id: context.roomId,
    })
  }

  public async onCleanup(roomId: string): Promise<void> {
    const sessionId = this.roomToSession.get(roomId)
    this.roomToSession.delete(roomId)
    this.roomTools.delete(roomId)
    if (sessionId) {
      this.activeSessions.delete(sessionId)
      this.bootstrappedSessions.delete(sessionId)
      this.client?.setPermissionHandler(sessionId, undefined)
      this.cancelPendingPermissions(sessionId)
    }
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop()
  }

  public async stop(): Promise<void> {
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

  private rehydrate(history: ACPClientSessionState): void {
    for (const [roomId, sessionId] of Object.entries(history.roomToSession)) {
      if (!this.roomToSession.has(roomId)) {
        this.roomToSession.set(roomId, sessionId)
      }
    }
  }

  private async ensureConnection(): Promise<ClientSideConnection> {
    if (this.connection && !this.connection.signal.aborted) {
      return this.connection
    }

    if (!this.started) {
      throw new Error("ACPClientAdapter was not started")
    }

    const isCreator = !this.spawnPromise
    if (isCreator) {
      this.spawnPromise = this.spawnConnection()
    }

    try {
      return await this.spawnPromise!
    } finally {
      if (isCreator) this.spawnPromise = null
    }
  }

  private async spawnConnection(): Promise<ClientSideConnection> {
    const acp = await acpModule.get()
    const client = new BandACPClient()
    const handle = await this.connectionFactory(client as Client, {
      command: this.command,
      cwd: this.cwd,
      env: this.env,
    })
    const connection = handle.connection
    const initializeResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.clientCapabilities ?? {},
    })

    if (this.authMethod) {
      await connection.authenticate({
        methodId: this.authMethod,
      })
    }

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
  ): Promise<string> {
    const existingSessionId = this.roomToSession.get(roomId)

    if (existingSessionId && this.activeSessions.has(existingSessionId)) {
      return existingSessionId
    }

    const mcpServers = await this.buildSessionMcpServers()

    if (existingSessionId) {
      const restored = await this.tryRestoreSession(connection, existingSessionId, mcpServers)
      if (restored.ok) {
        // Marked active/bootstrapped before the best-effort mode switch below
        // is awaited: `applyRequestedPermissionMode` makes a real RPC call,
        // and a connection drop mid-call clears `activeSessions` (see
        // `spawnConnection`'s `closed.finally()`) — running this after that
        // await would let a stale add silently re-admit a session whose
        // connection just died.
        this.activeSessions.add(existingSessionId)
        this.bootstrappedSessions.add(existingSessionId)
        await this.applyRequestedPermissionMode(connection, existingSessionId, restored.modes)
        return existingSessionId
      }
    }

    const created = await connection.newSession({
      cwd: this.cwd,
      mcpServers,
    })

    // Same ordering reason as the restored-session branch above.
    this.roomToSession.set(roomId, created.sessionId)
    this.activeSessions.add(created.sessionId)
    await this.applyRequestedPermissionMode(connection, created.sessionId, created.modes)
    return created.sessionId
  }

  private async tryRestoreSession(
    connection: ClientSideConnection,
    sessionId: string,
    mcpServers: McpServer[],
  ): Promise<{ ok: true; modes?: SessionModeState | null } | { ok: false }> {
    const capabilities = this.connectionState?.agentCapabilities
    const params = { cwd: this.cwd, mcpServers, sessionId }

    try {
      if (capabilities?.loadSession) {
        // `?.`: the ACP client doesn't runtime-validate this response, and
        // the installed SDK's own `unstable_resumeSession` (below) has no
        // fallback for a nullish resolution the way its `loadSession` does —
        // a restore that genuinely succeeded must not be miscategorized as
        // failed just because no mode state came back with it.
        const loaded = await connection.loadSession(params)
        return { ok: true, modes: loaded?.modes }
      }

      if (capabilities?.sessionCapabilities?.resume) {
        const resumed = await connection.unstable_resumeSession(params)
        return { ok: true, modes: resumed?.modes }
      }
    } catch {
      return { ok: false }
    }

    return { ok: false }
  }

  // Best-effort: never throws, so a mode switch going wrong can't take a
  // session establishment down with it.
  private async applyRequestedPermissionMode(
    connection: ClientSideConnection,
    sessionId: string,
    modes: SessionModeState | null | undefined,
  ): Promise<void> {
    if (!this.requestedPermissionMode || !modes || modes.currentModeId === this.requestedPermissionMode) {
      return
    }

    // Defensive, not just typed: `modes` comes straight off an unvalidated
    // JSON-RPC response from the spawned agent process (the ACP client does
    // no runtime schema check), so a non-conforming agent can send
    // `availableModes` missing, null, or containing a null entry despite the
    // type guaranteeing an `Array<SessionMode>`.
    const availableModes = Array.isArray(modes.availableModes) ? modes.availableModes : []
    if (!availableModes.some((mode) => mode?.id === this.requestedPermissionMode)) {
      // Warned, not silent: otherwise a renamed/dropped mode id silently
      // stops "ask before every tool" from working, with no signal at all.
      this.safeWarn("requested permission mode is not advertised by this session", {
        sessionId,
        requestedModeId: this.requestedPermissionMode,
        availableModeIds: availableModes.map((mode) => mode?.id),
      })
      return
    }

    try {
      await this.withTimeout(
        connection.setSessionMode({ sessionId, modeId: this.requestedPermissionMode }),
        SET_SESSION_MODE_TIMEOUT_MS,
        `setSessionMode did not respond within ${SET_SESSION_MODE_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      this.safeWarn("failed to switch session into the requested permission mode", {
        sessionId,
        requestedModeId: this.requestedPermissionMode,
        error: String(error),
      })
    }
  }

  // Bounds an RPC that has no timeout of its own (see `SET_SESSION_MODE_TIMEOUT_MS`
  // above) — the awaited promise isn't actually cancelled, since ACP gives no
  // way to do that, only stopped waiting on.
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
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
      this.trackPending(params.sessionId, controller)
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
        ? this.resolveManually(params.sessionId, params, controller)
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

  // A caller-supplied `Logger` isn't guaranteed not to throw. Every
  // best-effort warning in this file routes through here so one failing
  // sink can't turn a warning into an unhandled rejection in its place.
  private safeWarn(message: string, context?: Record<string, unknown>): void {
    try {
      this.logger.warn(message, context)
    } catch {
      // ignore — see comment above
    }
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
            this.safeWarn("resolvePermission threw; treating as no answer", { error: String(error) })
            return undefined
          }),
        timeout,
        cancelled,
      ])
    } finally {
      clearTimeout(timer)
      this.untrackPending(sessionId, controller)
      controller.abort()
    }
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

  private cancelPendingPermissions(sessionId: string): void {
    for (const controller of this.pendingPermissions.get(sessionId) ?? []) {
      controller.abort()
    }
  }

  private cancelAllPendingPermissions(): void {
    for (const sessionId of this.pendingPermissions.keys()) {
      this.cancelPendingPermissions(sessionId)
    }
  }

  private async flushChunks(input: {
    tools: AdapterToolsProtocol;
    sessionId: string;
    senderId: string;
    senderHandle: string;
  }): Promise<void> {
    const client = this.client
    if (!client) {
      return
    }

    for (const chunk of client.getCollectedChunks(input.sessionId)) {
      // A status-only ACP update carries its meaning in metadata and has
      // nothing to post.
      if (isBlankEventContent(chunk.content)) {
        continue
      }

      if (chunk.chunkType === "text") {
        await input.tools.sendMessage(chunk.content, [{
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

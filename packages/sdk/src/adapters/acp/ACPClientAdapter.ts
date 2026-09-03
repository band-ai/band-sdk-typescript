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
} from "@agentclientprotocol/sdk";

import { ACPClientHistoryConverter, type ACPClientSessionState } from "../../converters/acp-client";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { NoopLogger, type Logger } from "../../core/logger";
import { ValidationError } from "../../core/errors";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { renderSystemPrompt } from "../../runtime/prompts";
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
    _participantsMessage: string | null,
    _contactsMessage: string | null,
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

    const promptText = this.bootstrappedSessions.has(sessionId)
      ? message.content
      : `${this.buildSystemContext(context.roomId, message)}\n\n${message.content}`

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
      if (restored) {
        this.activeSessions.add(existingSessionId)
        this.bootstrappedSessions.add(existingSessionId)
        return existingSessionId
      }
    }

    const created = await connection.newSession({
      cwd: this.cwd,
      mcpServers,
    })

    this.roomToSession.set(roomId, created.sessionId)
    this.activeSessions.add(created.sessionId)
    return created.sessionId
  }

  private async tryRestoreSession(
    connection: ClientSideConnection,
    sessionId: string,
    mcpServers: McpServer[],
  ): Promise<boolean> {
    try {
      if (this.connectionState?.agentCapabilities?.loadSession) {
        await connection.loadSession({
          cwd: this.cwd,
          mcpServers,
          sessionId,
        })
        return true
      }

      if (this.connectionState?.agentCapabilities?.sessionCapabilities?.resume) {
        await connection.unstable_resumeSession({
          cwd: this.cwd,
          mcpServers,
          sessionId,
        })
        return true
      }
    } catch {
      return false
    }

    return false
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
            // Best-effort: a caller-supplied `logger` that itself throws
            // must not turn "the resolver failed" into an unhandled
            // rejection escaping this race in its place.
            try {
              this.logger.warn("resolvePermission threw; treating as no answer", { error: String(error) })
            } catch {
              // ignore — see comment above
            }
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
      if (chunk.chunkType === "text") {
        if (chunk.content.length > 0) {
          await input.tools.sendMessage(chunk.content, [{
            id: input.senderId,
            handle: input.senderHandle,
          }])
        }
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

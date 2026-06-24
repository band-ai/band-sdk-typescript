import { randomUUID } from "node:crypto";

import type {
  AgentSideConnection,
  McpServer,
  SessionMode,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import { ACPServerHistoryConverter, type ACPServerSessionState } from "../../converters/acp-server";
import type { ChatMessageMention, RestApi } from "../../client/rest/types";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MessagingTools } from "../../contracts/protocols";
import type { PlatformMessage } from "../../runtime/types";
import { ensureHandlePrefix } from "../../runtime/types";
import { EventConverter } from "./eventConverter";
import { ACPPushHandler } from "./pushHandler";
import { AgentRouter } from "./router";
import {
  DEFAULT_ACP_SERVER_MODES,
  asJsonSafe,
  createPendingPrompt,
  normalizeMcpServers,
  type PendingACPPrompt,
} from "./types";

const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_PROMPT_TIMEOUT_MS = 300_000
const DEFAULT_PROMPT_COMPLETION_GRACE_MS = 250

export interface BandACPServerAdapterOptions {
  bandRest?: RestApi;
  /** @deprecated Use bandRest. */
  thenvoiRest?: RestApi;
  maxSessions?: number;
  responseTimeoutMs?: number;
  promptCompletionGraceMs?: number;
  sessionModes?: SessionMode[];
  modeToPeer?: Record<string, string>;
  slashCommands?: Record<string, string>;
}

export class BandACPServerAdapter extends SimpleAdapter<ACPServerSessionState, MessagingTools> {
  private readonly bandRest: RestApi
  private readonly maxSessions: number
  private readonly responseTimeoutMs: number
  private readonly promptCompletionGraceMs: number
  private readonly sessionModes: SessionMode[]

  private readonly sessionToRoom = new Map<string, string>()
  private readonly roomToSession = new Map<string, string>()
  private readonly pendingPrompts = new Map<string, PendingACPPrompt>()
  private readonly sessionModeIds = new Map<string, string>()
  private readonly sessionModelIds = new Map<string, string>()
  private readonly sessionCwds = new Map<string, string>()
  private readonly sessionMcpServers = new Map<string, Array<Record<string, unknown>>>()

  private connection: AgentSideConnection | null = null
  private agentId: string | null = null
  private sessionsInFlight = 0
  private readonly router: AgentRouter
  private readonly pushHandler: ACPPushHandler

  public constructor(options: BandACPServerAdapterOptions) {
    super({
      historyConverter: new ACPServerHistoryConverter(),
    })

    const bandRest = options.bandRest ?? options.thenvoiRest
    if (!bandRest) {
      throw new Error("BandACPServerAdapter requires bandRest")
    }
    this.bandRest = bandRest
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    this.promptCompletionGraceMs = options.promptCompletionGraceMs ?? DEFAULT_PROMPT_COMPLETION_GRACE_MS
    this.sessionModes = options.sessionModes?.length
      ? [...options.sessionModes]
      : [...DEFAULT_ACP_SERVER_MODES]
    this.router = new AgentRouter({
      modeToPeer: options.modeToPeer,
      slashCommands: options.slashCommands,
    })
    this.pushHandler = new ACPPushHandler(this)
  }

  public bindConnection(connection: AgentSideConnection | null): void {
    this.connection = connection
  }

  public getConnection(): AgentSideConnection | null {
    return this.connection
  }

  public hasSession(sessionId: string): boolean {
    return this.sessionToRoom.has(sessionId)
  }

  public getSessionIds(): string[] {
    return [...this.sessionToRoom.keys()]
  }

  public getSessionForRoom(roomId: string): string | null {
    return this.roomToSession.get(roomId) ?? null
  }

  public get displayName(): string {
    return this.agentName
  }

  public getSessionCwd(sessionId: string): string {
    return this.sessionCwds.get(sessionId) ?? "."
  }

  public getModeState(sessionId: string): SessionModeState {
    return {
      availableModes: this.sessionModes,
      currentModeId: this.sessionModeIds.get(sessionId) ?? this.sessionModes[0]?.id ?? "default",
    }
  }

  public setSessionModes(modes: SessionMode[]): void {
    this.sessionModes.splice(0, this.sessionModes.length, ...modes)
  }

  public setSessionMode(sessionId: string, modeId: string): void {
    this.sessionModeIds.set(sessionId, modeId)
  }

  public setSessionModel(sessionId: string, modelId: string): void {
    this.sessionModelIds.set(sessionId, modelId)
  }

  public updateSessionContext(
    sessionId: string,
    input: {
      cwd?: string;
      mcpServers?: readonly McpServer[];
    },
  ): void {
    if (input.cwd) {
      this.sessionCwds.set(sessionId, input.cwd)
    }

    if (input.mcpServers) {
      const normalized = normalizeMcpServers(input.mcpServers)
      if (normalized.length > 0) {
        this.sessionMcpServers.set(sessionId, normalized)
      } else {
        this.sessionMcpServers.delete(sessionId)
      }
    }
  }

  public async verifyCredentials(): Promise<boolean> {
    try {
      await this.bandRest.getAgentMe()
      return true
    } catch {
      return false
    }
  }

  public async onStarted(
    agentName: string,
    agentDescription: string,
  ): Promise<void> {
    await super.onStarted(agentName, agentDescription)

    try {
      const identity = await this.bandRest.getAgentMe()
      this.agentId = identity.id
    } catch {
      this.agentId = null
    }
  }

  public async createSession(
    input: {
      cwd?: string;
      mcpServers?: readonly McpServer[];
    } = {},
  ): Promise<string> {
    this.sessionsInFlight += 1
    const activeCount = this.sessionToRoom.size + this.sessionsInFlight
    if (activeCount > this.maxSessions) {
      this.sessionsInFlight = Math.max(0, this.sessionsInFlight - 1)
      throw new Error(`Maximum ACP sessions (${this.maxSessions}) reached`)
    }
    try {
      const room = await this.bandRest.createChat()
      const sessionId = randomUUID()
      const normalizedMcpServers = normalizeMcpServers(input.mcpServers)

      this.sessionToRoom.set(sessionId, room.id)
      this.roomToSession.set(room.id, sessionId)
      this.sessionCwds.set(sessionId, input.cwd ?? ".")
      if (normalizedMcpServers.length > 0) {
        this.sessionMcpServers.set(sessionId, normalizedMcpServers)
      }

      try {
        await this.bandRest.createChatEvent(room.id, {
          content: "ACP session context",
          messageType: "task",
          metadata: {
            acp_session_id: sessionId,
            acp_room_id: room.id,
            acp_cwd: input.cwd ?? ".",
            acp_mcp_servers: normalizedMcpServers,
          },
        })
      } catch (error) {
        this.sessionToRoom.delete(sessionId)
        this.roomToSession.delete(room.id)
        this.sessionCwds.delete(sessionId)
        this.sessionMcpServers.delete(sessionId)
        this.sessionModeIds.delete(sessionId)
        this.sessionModelIds.delete(sessionId)
        throw error
      }

      return sessionId
    } finally {
      this.sessionsInFlight = Math.max(0, this.sessionsInFlight - 1)
    }
  }

  public async handlePrompt(sessionId: string, text: string): Promise<void> {
    const roomId = this.sessionToRoom.get(sessionId)
    if (!roomId) {
      throw new Error(`Unknown ACP session: ${sessionId}`)
    }

    const pending = createPendingPrompt(sessionId)
    this.pendingPrompts.set(roomId, pending)

    const resolved = this.router.resolve(text, this.sessionModeIds.get(sessionId))
    const promptText = this.prependSessionContext(sessionId, resolved.text)
    const participants = await this.bandRest.listChatParticipants(roomId)
    const mentions = this.resolveMentions(participants, resolved.targetPeer)

    try {
      await this.bandRest.createChatMessage(roomId, {
        content: promptText,
        mentions,
      })

      await Promise.race([
        pending.done,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`ACP prompt timed out after ${this.responseTimeoutMs}ms`))
          }, this.responseTimeoutMs)
          pending.done.finally(() => clearTimeout(timer)).catch(() => undefined)
        }),
      ])
    } finally {
      this.finishPendingPrompt(roomId, pending, false)
    }
  }

  public async onMessage(
    message: PlatformMessage,
    _tools: MessagingTools,
    history: ACPServerSessionState,
    _participantsMessage: string | null,
    _contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (context.isSessionBootstrap) {
      this.rehydrate(history)
    }

    if (this.agentId && message.senderId === this.agentId) {
      return
    }

    const pending = this.pendingPrompts.get(context.roomId)
    if (pending && this.connection) {
      const update = EventConverter.convert(message)
      if (update) {
        await this.connection.sessionUpdate({
          sessionId: pending.sessionId,
          update,
        })
      }

      if (message.messageType === "text" || message.messageType === "error") {
        pending.terminalMessageSeen = true
      }

      if (update || pending.terminalMessageSeen) {
        this.schedulePromptCompletion(context.roomId, pending)
      }
      return
    }

    if (this.connection) {
      await this.pushHandler.handlePushEvent(message, context.roomId)
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    const sessionId = this.roomToSession.get(roomId)
    if (sessionId) {
      this.roomToSession.delete(roomId)
      this.sessionToRoom.delete(sessionId)
      this.sessionModeIds.delete(sessionId)
      this.sessionModelIds.delete(sessionId)
      this.sessionCwds.delete(sessionId)
      this.sessionMcpServers.delete(sessionId)
    }

    this.finishPendingPrompt(roomId, this.pendingPrompts.get(roomId) ?? null, true)
  }

  public async onRuntimeStop(): Promise<void> {
    for (const roomId of [...this.roomToSession.keys()]) {
      await this.onCleanup(roomId)
    }
    this.connection = null
  }

  public async cancelPrompt(sessionId: string): Promise<void> {
    const roomId = this.sessionToRoom.get(sessionId)
    if (!roomId) {
      return
    }

    this.finishPendingPrompt(roomId, this.pendingPrompts.get(roomId) ?? null, true)
  }

  public async closeSession(sessionId: string): Promise<void> {
    const roomId = this.sessionToRoom.get(sessionId)
    if (!roomId) {
      return
    }

    await this.onCleanup(roomId)
  }

  private rehydrate(history: ACPServerSessionState): void {
    for (const [sessionId, roomId] of Object.entries(history.sessionToRoom)) {
      if (!this.sessionToRoom.has(sessionId)) {
        this.sessionToRoom.set(sessionId, roomId)
      }
      if (!this.roomToSession.has(roomId)) {
        this.roomToSession.set(roomId, sessionId)
      }
    }

    for (const [sessionId, cwd] of Object.entries(history.sessionCwd)) {
      if (!this.sessionCwds.has(sessionId)) {
        this.sessionCwds.set(sessionId, cwd)
      }
    }

    for (const [sessionId, mcpServers] of Object.entries(history.sessionMcpServers)) {
      if (!this.sessionMcpServers.has(sessionId)) {
        this.sessionMcpServers.set(sessionId, [...mcpServers])
      }
    }
  }

  private prependSessionContext(sessionId: string, text: string): string {
    const cwd = this.sessionCwds.get(sessionId)
    const mcpServers = this.sessionMcpServers.get(sessionId) ?? []
    if (!cwd && mcpServers.length === 0) {
      return text
    }

    const lines = ["[ACP Session Context]"]
    if (cwd) {
      lines.push(`Editor cwd: ${cwd}`)
    }
    if (mcpServers.length > 0) {
      lines.push("Editor MCP servers:")
      lines.push(...mcpServers.map((server) => formatMcpServerLine(server)))
      lines.push("These MCP servers belong to the connected editor session.")
    }
    lines.push("")
    lines.push(text)
    return lines.join("\n")
  }

  private resolveMentions(
    participants: Awaited<ReturnType<RestApi["listChatParticipants"]>>,
    targetPeer: string | null,
  ): ChatMessageMention[] {
    const filtered = participants.filter((participant) => {
      if (this.agentId && participant.id === this.agentId) {
        return false
      }

      if (!targetPeer) {
        return true
      }

      const normalizedTarget = targetPeer.startsWith("@") ? targetPeer.slice(1) : targetPeer
      const participantHandles = [
        participant.handle,
        ensureHandlePrefix(participant.handle)?.slice(1),
      ].filter((value): value is string => typeof value === "string" && value.length > 0)

      return participant.name === targetPeer
        || participant.name === normalizedTarget
        || participantHandles.includes(targetPeer)
        || participantHandles.includes(normalizedTarget)
    })

    return filtered.map((participant) => ({
      id: participant.id,
      handle: participant.handle ?? undefined,
      name: participant.name,
    }))
  }

  private schedulePromptCompletion(
    roomId: string,
    pending: PendingACPPrompt,
  ): void {
    if (this.pendingPrompts.get(roomId) !== pending) {
      return
    }

    if (pending.completionTimer) {
      clearTimeout(pending.completionTimer)
    }

    pending.completionTimer = setTimeout(() => {
      this.finishPendingPrompt(roomId, pending, true)
    }, this.promptCompletionGraceMs)
  }

  private finishPendingPrompt(
    roomId: string,
    pending: PendingACPPrompt | null,
    setDone: boolean,
  ): void {
    const current = this.pendingPrompts.get(roomId)
    if (!current || (pending && current !== pending)) {
      return
    }

    this.pendingPrompts.delete(roomId)

    if (current.completionTimer) {
      clearTimeout(current.completionTimer)
      current.completionTimer = null
    }

    if (setDone) {
      current.markDone()
    }
  }
}

function formatMcpServerLine(server: Record<string, unknown>): string {
  const type = typeof server.type === "string" ? server.type : "unknown"
  const name = typeof server.name === "string"
    ? server.name
    : (typeof server.command === "string"
      ? server.command
      : (typeof server.url === "string" ? server.url : "unnamed"))

  const details: string[] = [type]
  if (type === "stdio" && typeof server.command === "string") {
    details.push(`command=${server.command}`)
  }
  if (type !== "stdio" && typeof server.url === "string") {
    details.push(`url=${server.url}`)
  }

  return `- ${name} (${details.join(", ")})`
}

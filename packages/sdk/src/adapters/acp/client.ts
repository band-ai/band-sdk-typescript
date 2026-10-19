import type {
  Client,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  Stream,
  AnyMessage,
  JsonRpcId,
} from "@agentclientprotocol/sdk";

import type { Logger } from "../../core/logger";
import { asOptionalRecord } from "../shared/coercion";
import { toolCallId } from "./toolCalls";
import type {
  ACPClientExtensionHandler,
  ACPPermissionHandler,
  CollectedChunk,
} from "./types";

export const ACP_PERMISSION_METHOD = "session/request_permission"

/** What one prompt reports to: the runtime's own tool calls, its manual waits, and the end of both. */
export interface PromptActivity {
  observe(chunk: CollectedChunk): void
  permission(waiting: boolean): void
  end(): void
}

export class BandACPClient implements Client {
  private readonly sessionChunks = new Map<string, CollectedChunk[]>()
  private readonly roomId: string
  private readonly permissionHandler: ACPPermissionHandler
  private readonly extensionHandler: ACPClientExtensionHandler | undefined
  // Token, not session id: a timed-out prompt's `finally` must not delete
  // a later prompt that reused the same id.
  private nextPromptToken = 0
  private readonly promptsInFlight = new Map<number, string>()
  private readonly activities = new Map<number, PromptActivity>()
  // First prompt to report a tool call owns it for its session's life, so a call
  // replayed on a later prompt of the session is not reported again.
  private readonly callOwners = new Map<string, Map<string, number>>()
  // Prompts the turn stopped waiting on while still running: their late
  // notifications cannot be told from a new prompt's, so the session reports nothing.
  private readonly abandonedPrompts = new Map<number, string>()
  private readonly permissionReplies = new Map<JsonRpcId | object, number>()
  // Once the wire is observed, a manual wait is held through the response write
  // instead of the handler's lifetime.
  private wireObserved = false
  // Set once the engine has moved on from this client's process: whatever a
  // lingering process still sends must not reach the room.
  private retired = false

  // The handler is connection-scoped and required at construction, so it is
  // already in place before the agent process is spawned: there is no window
  // in which a `session/request_permission` has nowhere to go. `roomId` is the
  // one room this client's process serves.
  public constructor(
    roomId: string,
    permissionHandler: ACPPermissionHandler,
    extensionHandler?: ACPClientExtensionHandler,
    private readonly humanDecision?: (method: string, params: Record<string, unknown>) => boolean,
    private readonly logger?: Logger,
  ) {
    this.roomId = roomId
    this.permissionHandler = permissionHandler
    this.extensionHandler = extensionHandler
  }

  public retire(): void {
    this.retired = true
    for (const token of [...this.activities.keys()]) this.endActivity(token)
    this.callOwners.clear()
  }

  public beginSession(sessionId: string): void {
    this.sessionChunks.set(sessionId, [])
  }

  /** The room has closed the session: nothing can replay its calls any more. */
  public forgetSession(sessionId: string): void {
    this.callOwners.delete(sessionId)
  }

  // One token per call. `release` drops that token only, so a turn that
  // stopped waiting cannot remove a later prompt that reused the session id.
  public enterPromptSession(sessionId: string, activity?: PromptActivity): {
    run: <T>(fn: () => Promise<T>) => Promise<T>
    release: () => void
  } {
    const token = ++this.nextPromptToken
    this.promptsInFlight.set(token, sessionId)
    if (activity && !this.isAmbiguous(sessionId)) this.activities.set(token, activity)
    let running = false
    let released = false
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      this.promptsInFlight.delete(token)
      this.endActivity(token)
    }
    return {
      release: () => {
        if (running && !released) this.abandon(token, sessionId)
        release()
      },
      run: async (fn) => {
        running = true
        try {
          return await fn()
        } finally {
          this.abandonedPrompts.delete(token)
          release()
        }
      },
    }
  }

  private abandon(token: number, sessionId: string): void {
    this.abandonedPrompts.set(token, sessionId)
    this.logger?.warn("acp_client.prompt_abandoned_in_flight", { roomId: this.roomId, sessionId })
  }

  private isAmbiguous(sessionId: string): boolean {
    return [...this.abandonedPrompts.values()].includes(sessionId)
  }

  /** Ends what a prompt left open, so the turn's failure or flush never runs under its tool or wait. */
  private endActivity(token: number): void {
    const activity = this.activities.get(token)
    this.activities.delete(token)
    const waiting = this.holdsWait(token)
    for (const [request, owner] of this.permissionReplies) if (owner === token) this.permissionReplies.delete(request)
    if (waiting) activity?.permission(false)
    activity?.end()
  }

  public async sessionUpdate(params: SessionNotification): Promise<void> {
    if (this.retired || !this.sessionChunks.has(params.sessionId)) {
      return
    }

    const chunk = toCollectedChunk(params.update)
    if (chunk) {
      this.captureObserver(params.sessionId, chunk, this.promptToken(params.sessionId))?.observe(chunk)
      this.appendChunk(params.sessionId, chunk)
    }
  }

  public async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return await this.observeDecision(ACP_PERMISSION_METHOD, params, params.sessionId, () => this.permissionHandler(params))
  }

  private async observeDecision<T>(method: string, params: Record<string, unknown>, sessionId: string | null, work: () => Promise<T>): Promise<T> {
    const token = this.wireObserved ? undefined : this.waitingPrompt(method, params, sessionId)
    if (token === undefined) return await work()
    const request = {}
    this.beginWait(request, token)
    try { return await work() }
    finally { this.endWait(request) }
  }

  /** The prompt a human decision holds a wait for: one that is in flight and reports activity. */
  private waitingPrompt(method: string, params: Record<string, unknown>, sessionId: string | null): number | undefined {
    const token = sessionId ? this.promptToken(sessionId) : undefined
    return token !== undefined && this.humanDecision?.(method, params) && this.activities.has(token) ? token : undefined
  }

  private beginWait(request: JsonRpcId | object, token: number): void {
    const first = !this.holdsWait(token)
    this.permissionReplies.set(request, token)
    if (first) this.activities.get(token)?.permission(true)
  }

  private endWait(request: JsonRpcId | object): void {
    const token = this.permissionReplies.get(request)
    this.permissionReplies.delete(request)
    if (token !== undefined && !this.holdsWait(token)) this.activities.get(token)?.permission(false)
  }

  private holdsWait(token: number): boolean {
    return [...this.permissionReplies.values()].includes(token)
  }

  /** Holds actual manual waits through the JSON-RPC response write. */
  public observeStream(stream: Stream): Stream {
    this.wireObserved = true
    const writer = stream.writable.getWriter()
    return {
      readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          this.openWaitFor(message)
          controller.enqueue(message)
        },
      })),
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          try { await writer.write(message) }
          finally { this.closeWaitFor(message) }
        },
        close: () => writer.close(),
        abort: (reason: unknown) => writer.abort(reason),
      }),
    }
  }

  private openWaitFor(message: AnyMessage): void {
    if (!("method" in message && "id" in message)) return
    const params = asOptionalRecord(message.params)
    if (!params) return
    const token = this.waitingPrompt(message.method, params, this.attributableSession(sessionIdFrom(params)))
    if (token !== undefined) this.beginWait(message.id, token)
  }

  private closeWaitFor(message: AnyMessage): void {
    if (!("method" in message) && "id" in message) this.endWait(message.id)
  }

  // Named for the one thing it clears: collected chunks are per-turn, and a
  // per-turn caller must not be able to reach anything with a longer life.
  public resetChunks(sessionId: string): void {
    this.sessionChunks.delete(sessionId)
  }

  public getCollectedText(sessionId?: string): string {
    return this.getCollectedChunks(sessionId)
      .filter((chunk) => chunk.chunkType === "text")
      .map((chunk) => chunk.content)
      .join("")
  }

  public getCollectedChunks(sessionId?: string): CollectedChunk[] {
    if (sessionId) {
      return coalesceChunks(this.sessionChunks.get(sessionId) ?? [])
    }

    return [...this.sessionChunks.values()].flatMap((chunks) => coalesceChunks(chunks))
  }

  // Unlike `getCollectedChunks`, this clears the buffer as it reads it — so a
  // caller that flushes twice for the same turn (success path, then a catch
  // block) can never redeliver the same chunks. Keeps the session's map entry
  // (an empty array, not a deleted one) so a late `sessionUpdate` still has
  // somewhere to collect into.
  public takeCollectedChunks(sessionId: string): CollectedChunk[] {
    if (!this.sessionChunks.has(sessionId)) {
      return []
    }
    const chunks = coalesceChunks(this.sessionChunks.get(sessionId) ?? [])
    this.sessionChunks.set(sessionId, [])
    return chunks
  }

  public async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.retired) {
      return {}
    }
    const sessionId = this.attributableSession(sessionIdFrom(params))
    const result = await this.observeDecision(method, params, sessionId, async () => await this.extensionHandler?.extMethod?.(
      method, params, { roomId: this.roomId, sessionId },
    ))
    return result ?? {}
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.retired) {
      return
    }
    // Resolved before the handler await, while the prompt it belongs to is
    // still the one in flight.
    const sessionId = this.attributableSession(sessionIdFrom(params))
    const prompt = sessionId ? this.promptToken(sessionId) : undefined
    const chunks = await this.extensionHandler?.extNotification?.(
      method,
      params,
      { roomId: this.roomId, sessionId },
    )
    // Chunks with no session to land in are dropped.
    if (!sessionId || !chunks) {
      return
    }

    for (const chunk of chunks) {
      this.captureObserver(sessionId, chunk, prompt)?.observe(chunk)
      this.appendChunk(sessionId, chunk)
    }
  }

  private appendChunk(sessionId: string, chunk: CollectedChunk): void {
    this.sessionChunks.get(sessionId)?.push(chunk)
  }

  private promptToken(sessionId: string): number | undefined {
    const tokens = [...this.promptsInFlight].filter(([, session]) => session === sessionId)
    return tokens.length === 1 ? tokens[0][0] : undefined
  }

  private captureObserver(sessionId: string, chunk: CollectedChunk, token: number | undefined): PromptActivity | undefined {
    if (this.retired) return undefined
    const id = toolCallId(chunk)
    if (!id || token === undefined || this.isAmbiguous(sessionId)) return undefined
    let owners = this.callOwners.get(sessionId)
    if (!owners) this.callOwners.set(sessionId, owners = new Map<string, number>())
    const owner = owners.get(id)
    if (owner !== undefined && owner !== token) return undefined
    owners.set(id, token)
    return this.activities.get(token)
  }

  // Params win. Otherwise, the only signal a sessionless notification has is
  // whether exactly one prompt is in flight: the ACP SDK dispatches
  // notifications from the connection's own read loop, not from a
  // continuation of any specific `prompt()` call, so there is no way to
  // tell which of two or more overlapping prompts a notification belongs to.
  private attributableSession(paramSessionId: string | null): string | null {
    if (paramSessionId) {
      return paramSessionId
    }
    if (this.promptsInFlight.size !== 1) {
      return null
    }
    return this.promptsInFlight.values().next().value ?? null
  }
}

// Posting every collected chunk verbatim would flood the room with a dozen
// one-word messages for a single streamed reply. A genuine streamed run (see
// `CollectedChunk.streamed` for why that can't be judged from `chunkType`
// alone) stays open across the *other* streamed chunk type — Claude/Codex
// both interleave visible reasoning mid-reply (text → thought → thought →
// text → …), and a thought is not an action, it's already routed to its own
// room event, so it must not fragment the text run (or vice versa) the way a
// real action does. Only a non-streamed chunk (tool_call, tool_call_update,
// plan, or a one-shot same-typed marker) is a real boundary, closing every
// open run so the next streamed chunk of either type starts a fresh one.
// Never mutates `chunks` or its objects — each pushed entry is its own
// shallow clone, and only a clone's `content` is ever mutated afterward.
function coalesceChunks(chunks: readonly CollectedChunk[]): CollectedChunk[] {
  const result: CollectedChunk[] = []
  const openRuns = new Map<CollectedChunk["chunkType"], CollectedChunk>()

  for (const chunk of chunks) {
    if (!chunk.streamed) {
      openRuns.clear()
      result.push({ ...chunk })
      continue
    }

    const openRun = openRuns.get(chunk.chunkType)
    if (openRun) {
      openRun.content += chunk.content
      continue
    }

    const clone = { ...chunk }
    openRuns.set(chunk.chunkType, clone)
    result.push(clone)
  }

  return result
}

function toCollectedChunk(update: SessionUpdate): CollectedChunk | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        chunkType: "text",
        content: extractTextFromContent(update.content),
        metadata: {},
        streamed: true,
      }
    case "agent_thought_chunk":
      return {
        chunkType: "thought",
        content: extractTextFromContent(update.content),
        metadata: {},
        streamed: true,
      }
    case "tool_call":
      return {
        chunkType: "tool_call",
        content: update.title,
        metadata: {
          tool_call_id: update.toolCallId,
          raw_input: update.rawInput,
          status: update.status ?? "pending",
          ...(update.kind ? { kind: update.kind } : {}),
        },
        streamed: false,
      }
    case "tool_call_update":
      return {
        chunkType: "tool_result",
        content: extractToolOutput(update),
        // ACP updates carry only changed fields: no status means the call's status didn't change.
        // A title or input revises what the call invoked (Cursor names an MCP call only here).
        metadata: {
          tool_call_id: update.toolCallId,
          ...(update.status ? { status: update.status } : {}),
          ...(update.kind ? { kind: update.kind } : {}),
          ...(update.title ? { title: update.title } : {}),
          ...(update.rawInput !== undefined ? { raw_input: update.rawInput } : {}),
        },
        streamed: false,
      }
    case "plan":
      return {
        chunkType: "plan",
        content: update.entries.map((entry) => entry.content).join("\n"),
        metadata: {},
        streamed: false,
      }
    default:
      return null
  }
}

function extractToolOutput(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): string {
  if (typeof update.rawOutput === "string") {
    return update.rawOutput
  }

  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    try {
      return JSON.stringify(update.rawOutput)
    } catch {
      return String(update.rawOutput)
    }
  }

  const parts = (update.content ?? []).map(extractTextFromToolContent).filter((text) => text.length > 0)
  return parts.join("\n")
}

function extractTextFromToolContent(content: ToolCallContent): string {
  if (content.type === "content") {
    return extractTextFromContent(content.content)
  }

  if (content.type === "diff") {
    return content.newText
  }

  if (content.type === "terminal") {
    return `[Terminal: ${content.terminalId}]`
  }

  return ""
}

function extractTextFromContent(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text
    case "resource_link":
      return `[Resource: ${content.title ?? content.name ?? content.uri}]`
    case "resource": {
      const resource = content.resource
      if ("text" in resource && typeof resource.text === "string") {
        return resource.text
      }
      return `[Resource: ${resource.uri ?? "embedded"}]`
    }
    case "image":
      return `[Image: ${content.mimeType ?? "image"}]`
    case "audio":
      return `[Audio: ${content.mimeType ?? "audio"}]`
    default:
      return ""
  }
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function sessionIdFrom(params: Record<string, unknown>): string | null {
  return toOptionalString(params.sessionId) ?? toOptionalString(params.session_id)
}

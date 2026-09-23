import { AsyncLocalStorage } from "node:async_hooks";

import type {
  Client,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

import type {
  ACPClientExtensionHandler,
  ACPPermissionHandler,
  CollectedChunk,
} from "./types";

export class BandACPClient implements Client {
  private readonly sessionChunks = new Map<string, CollectedChunk[]>()
  private readonly permissionHandler: ACPPermissionHandler
  private readonly extensionHandler: ACPClientExtensionHandler | undefined
  // The prompt call that is on the stack, plus every prompt still awaiting a
  // response. A sessionless extension notification is attributed to the
  // prompt that is actually running, not to whichever session last became
  // ready — two rooms share this client, and that last-ready slot moves.
  private readonly promptSession = new AsyncLocalStorage<string>()
  // Token, not session id: a timed-out prompt's `finally` must not delete
  // a later prompt that reused the same id.
  private nextPromptToken = 0
  private readonly promptsInFlight = new Map<number, string>()

  // The handler is connection-scoped and required at construction, so it is
  // already in place before the agent process is spawned: there is no window
  // in which a `session/request_permission` has nowhere to go.
  public constructor(
    permissionHandler: ACPPermissionHandler,
    extensionHandler?: ACPClientExtensionHandler,
  ) {
    this.permissionHandler = permissionHandler
    this.extensionHandler = extensionHandler
  }

  public beginSession(sessionId: string): void {
    this.sessionChunks.set(sessionId, [])
  }

  // One token per call, including the prompt currently on the stack.
  // `release` drops that token only, so a turn that stopped waiting cannot
  // remove a later prompt that reused the session id.
  public enterPromptSession(sessionId: string): {
    run: <T>(fn: () => Promise<T>) => Promise<T>
    release: () => void
  } {
    const token = ++this.nextPromptToken
    this.promptsInFlight.set(token, sessionId)
    let released = false
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      this.promptsInFlight.delete(token)
    }
    return {
      release,
      run: (fn) => this.promptSession.run(sessionId, async () => {
        try {
          return await fn()
        } finally {
          release()
        }
      }),
    }
  }

  public async sessionUpdate(params: SessionNotification): Promise<void> {
    if (!this.sessionChunks.has(params.sessionId)) {
      return
    }

    const chunk = toCollectedChunk(params.update)
    if (chunk) {
      this.appendChunk(params.sessionId, chunk)
    }
  }

  public async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler(params)
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
    const result = await this.extensionHandler?.extMethod?.(
      method,
      params,
      { sessionId: sessionIdFrom(params) },
    )
    return result ?? {}
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    // Resolved before the handler await. Reading a handler-owned session id
    // after that await lets another room's session-ready overwrite it.
    const sessionId = this.attributableSession(sessionIdFrom(params))
    const chunks = await this.extensionHandler?.extNotification?.(
      method,
      params,
      { sessionId },
    )
    const targetSessionId = sessionId ?? this.extensionHandler?.extensionSessionId?.() ?? null
    if (!targetSessionId || !chunks) {
      return
    }

    for (const chunk of chunks) {
      this.appendChunk(targetSessionId, chunk)
    }
  }

  private appendChunk(sessionId: string, chunk: CollectedChunk): void {
    this.sessionChunks.get(sessionId)?.push(chunk)
  }

  // Params win. Otherwise the prompt on this stack, which is the only
  // signal a sessionless notification has when two prompts overlap. A
  // single in-flight prompt covers a notification dispatched off the
  // prompt's own stack (the connection read loop).
  private attributableSession(paramSessionId: string | null): string | null {
    if (paramSessionId) {
      return paramSessionId
    }
    const onStack = this.promptSession.getStore()
    if (onStack) {
      return onStack
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
        },
        streamed: false,
      }
    case "tool_call_update":
      return {
        chunkType: "tool_result",
        content: extractToolOutput(update),
        metadata: {
          tool_call_id: update.toolCallId,
          status: update.status ?? "completed",
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

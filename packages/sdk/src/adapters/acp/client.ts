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
  ACPPermissionHandler,
  CollectedChunk,
} from "./types";
import { choosePermissionOption } from "./types";

export class BandACPClient implements Client {
  private readonly sessionChunks = new Map<string, CollectedChunk[]>()
  private readonly permissionHandlers = new Map<string, ACPPermissionHandler>()

  public async sessionUpdate(params: SessionNotification): Promise<void> {
    const chunk = toCollectedChunk(params.update)
    if (!chunk) {
      return
    }

    const existing = this.sessionChunks.get(params.sessionId) ?? []
    existing.push(chunk)
    this.sessionChunks.set(params.sessionId, existing)
  }

  public async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const handler = this.permissionHandlers.get(params.sessionId)
    if (handler) {
      return handler(params)
    }

    return {
      outcome: {
        outcome: "cancelled",
      },
    }
  }

  public setPermissionHandler(
    sessionId: string,
    handler?: ACPPermissionHandler,
  ): void {
    if (!handler) {
      this.permissionHandlers.delete(sessionId)
      return
    }

    this.permissionHandlers.set(sessionId, handler)
  }

  public resetSession(sessionId: string): void {
    this.sessionChunks.delete(sessionId)
    this.permissionHandlers.delete(sessionId)
  }

  public getCollectedText(sessionId?: string): string {
    return this.getCollectedChunks(sessionId)
      .filter((chunk) => chunk.chunkType === "text")
      .map((chunk) => chunk.content)
      .join("")
  }

  public getCollectedChunks(sessionId?: string): CollectedChunk[] {
    if (sessionId) {
      return [...(this.sessionChunks.get(sessionId) ?? [])]
    }

    return [...this.sessionChunks.values()].flatMap((chunks) => chunks)
  }

  public async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "cursor/ask_question") {
      const options = Array.isArray(params.options)
        ? params.options
        : []
      const selected = choosePermissionOption(
        options.filter((option): option is RequestPermissionRequest["options"][number] => !!option && typeof option === "object"),
      )

      if (!selected) {
        return {
          outcome: {
            type: "cancelled",
          },
        }
      }

      return {
        outcome: {
          type: "selected",
          optionId: selected.optionId,
        },
      }
    }

    if (method === "cursor/create_plan") {
      return {
        outcome: {
          type: "approved",
        },
      }
    }

    return {}
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = toOptionalString(params.sessionId) ?? toOptionalString(params.session_id)
    if (!sessionId) {
      return
    }

    if (method === "cursor/update_todos") {
      const todos = Array.isArray(params.todos) ? params.todos : []
      const lines = todos
        .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object")
        .map((todo) => `- [${todo.completed === true ? "x" : " "}] ${String(todo.content ?? "")}`)
        .filter((line) => line.trim().length > 0)

      if (lines.length > 0) {
        this.appendChunk(sessionId, {
          chunkType: "plan",
          content: lines.join("\n"),
          metadata: {},
        })
      }
      return
    }

    if (method === "cursor/task") {
      const result = toOptionalString(params.result)
      if (result) {
        this.appendChunk(sessionId, {
          chunkType: "text",
          content: `[Task completed] ${result}`,
          metadata: {},
        })
      }
    }
  }

  private appendChunk(sessionId: string, chunk: CollectedChunk): void {
    const existing = this.sessionChunks.get(sessionId) ?? []
    existing.push(chunk)
    this.sessionChunks.set(sessionId, existing)
  }
}

function toCollectedChunk(update: SessionUpdate): CollectedChunk | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        chunkType: "text",
        content: extractTextFromContent(update.content),
        metadata: {},
      }
    case "agent_thought_chunk":
      return {
        chunkType: "thought",
        content: extractTextFromContent(update.content),
        metadata: {},
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
      }
    case "tool_call_update":
      return {
        chunkType: "tool_result",
        content: extractToolOutput(update),
        metadata: {
          tool_call_id: update.toolCallId,
          status: update.status ?? "completed",
        },
      }
    case "plan":
      return {
        chunkType: "plan",
        content: update.entries.map((entry) => entry.content).join("\n"),
        metadata: {},
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

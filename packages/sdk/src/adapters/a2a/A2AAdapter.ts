import { randomUUID } from "node:crypto";

import { UnsupportedFeatureError, ValidationError } from "../../core/errors";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MessagingTools } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { PlatformMessage } from "../../runtime/types";
import { asErrorMessage } from "../shared/coercion";
import {
  A2AHistoryConverter,
  buildA2AAuthHeaders,
  type A2AAuth,
  type A2ASessionState,
} from "./types";

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "auth-required"]);
const DEFAULT_MAX_STREAM_EVENTS = 10_000;

type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

interface A2AMessagePart {
  kind?: string;
  type?: string;
  text?: string;
  root?: A2AMessagePart;
}

interface A2AMessageLike {
  kind?: string;
  role?: string;
  parts?: A2AMessagePart[];
  contextId?: string;
  taskId?: string;
  messageId?: string;
}

interface A2AStatusLike {
  state?: string;
  message?: A2AMessageLike;
}

interface A2AArtifactLike {
  parts?: A2AMessagePart[];
}

interface A2ATaskLike {
  kind?: string;
  id: string;
  contextId?: string;
  status: A2AStatusLike;
  artifacts?: A2AArtifactLike[];
  history?: A2AMessageLike[];
}

interface A2AStatusUpdateEventLike {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: A2AStatusLike;
}

interface A2AArtifactUpdateEventLike {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2AArtifactLike;
}

type A2AEventLike = A2AMessageLike | A2ATaskLike | A2AStatusUpdateEventLike | A2AArtifactUpdateEventLike;

interface A2AMessageSendParams {
  message: {
    kind: "message";
    messageId: string;
    role: "user";
    parts: Array<{ kind: "text"; text: string }>;
    contextId?: string;
    taskId?: string;
  };
}

export interface A2AClientLike {
  sendMessage(params: A2AMessageSendParams): Promise<unknown>;
  sendMessageStream(params: A2AMessageSendParams): AsyncIterable<unknown>;
  resubscribeTask?(params: { id: string }): AsyncIterable<unknown>;
}

export interface A2AAdapterOptions {
  remoteUrl: string;
  auth?: A2AAuth;
  streaming?: boolean;
  clientFactory?: A2AClientFactory;
  maxStreamEvents?: number;
  logger?: Logger;
}

export type A2AClientFactory = (input: {
  remoteUrl: string;
  authHeaders: Record<string, string>;
}) => Promise<A2AClientLike>;

export class A2AAdapter extends SimpleAdapter<A2ASessionState, MessagingTools> {
  private readonly remoteUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly streaming: boolean;
  private readonly clientFactory?: A2AClientFactory;
  private readonly maxStreamEvents: number;
  private readonly logger: Logger;
  private client: A2AClientLike | null = null;
  private readonly contexts = new Map<string, string>();
  private readonly tasks = new Map<string, string>();
  private readonly taskSenders = new Map<string, { id: string }>();

  public constructor(options: A2AAdapterOptions) {
    super({
      historyConverter: new A2AHistoryConverter(),
    });
    this.remoteUrl = options.remoteUrl;
    this.authHeaders = buildA2AAuthHeaders(options.auth);
    this.streaming = options.streaming ?? true;
    this.clientFactory = options.clientFactory;
    this.maxStreamEvents = normalizeMaxStreamEvents(options.maxStreamEvents);
    this.logger = options.logger ?? new NoopLogger();
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.client = await this.createClient();
  }

  public async onMessage(
    message: PlatformMessage,
    tools: MessagingTools,
    history: A2ASessionState,
    _participantsMessage: string | null,
    _contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const client = this.client ?? (await this.createClient());
    this.client = client;

    if (context.isSessionBootstrap) {
      await this.rehydrateFromHistory(context.roomId, history, client);
    }

    const request = this.toSendParams(message, context.roomId);
    try {
      if (this.streaming) {
        let streamEventCount = 0;
        for await (const event of client.sendMessageStream(request)) {
          streamEventCount += 1;
          if (streamEventCount > this.maxStreamEvents) {
            throw new Error(`A2A stream exceeded maximum event limit (${this.maxStreamEvents})`);
          }
          try {
            await this.handleEvent(event, tools, context.roomId, message.senderId);
          } catch (handleError) {
            this.logger.error("A2A stream event handling failed; continuing stream", {
              roomId: context.roomId,
              remoteUrl: this.remoteUrl,
              streamEventCount,
              error: handleError,
            });
          }
        }
        return;
      }

      const response = await client.sendMessage(request);
      await this.handleEvent(response, tools, context.roomId, message.senderId);
    } catch (error) {
      const errorMessage = asErrorMessage(error);
      this.logger.error("A2A adapter request failed", {
        roomId: context.roomId,
        remoteUrl: this.remoteUrl,
        error,
      });
      try {
        await tools.sendEvent(`A2A agent error: ${errorMessage}`, "error", {
          a2a_error: errorMessage,
        });
      } catch (eventError) {
        this.logger.warn("A2A adapter failed to emit error event", {
          roomId: context.roomId,
          remoteUrl: this.remoteUrl,
          error: eventError,
        });
      }

      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.contexts.delete(roomId);
    this.tasks.delete(roomId);

    for (const key of this.taskSenders.keys()) {
      if (key.startsWith(`${roomId}:`)) {
        this.taskSenders.delete(key);
      }
    }
  }

  private async handleEvent(
    rawEvent: unknown,
    tools: MessagingTools,
    roomId: string,
    senderId: string,
  ): Promise<void> {
    const event = unwrapResult(rawEvent);
    if (!event) {
      return;
    }

    if (isMessageEvent(event)) {
      const text = extractMessageText(event);
      if (text) {
        await tools.sendMessage(text, [{ id: senderId }]);
      }
      return;
    }

    if (isTaskEvent(event)) {
      await this.handleTaskEvent(event, tools, roomId, senderId);
      return;
    }

    if (isStatusUpdateEvent(event)) {
      await this.handleStatusUpdateEvent(event, tools, roomId, senderId);
      return;
    }

    if (isArtifactUpdateEvent(event)) {
      const text = extractArtifactText(event.artifact);
      if (text) {
        await tools.sendMessage(text, [{ id: senderId }]);
      }
    }
  }

  private async handleTaskEvent(
    task: A2ATaskLike,
    tools: MessagingTools,
    roomId: string,
    senderId: string,
  ): Promise<void> {
    const state = normalizeState(task.status.state);
    const key = roomTaskKey(roomId, task.id);
    const sender = this.trackTask({
      roomId,
      key,
      taskId: task.id,
      contextId: task.contextId,
      senderId,
    });

    await this.handleStateTransition({
      state,
      statusMessage: task.status.message,
      completedMessage: extractTaskResponse(task),
      tools,
      sender,
      contextId: task.contextId,
      taskId: task.id,
      roomId,
      key,
    });
  }

  private async handleStatusUpdateEvent(
    event: A2AStatusUpdateEventLike,
    tools: MessagingTools,
    roomId: string,
    senderId: string,
  ): Promise<void> {
    const state = normalizeState(event.status.state);
    const key = roomTaskKey(roomId, event.taskId);
    const sender = this.trackTask({
      roomId,
      key,
      taskId: event.taskId,
      contextId: event.contextId,
      senderId,
    });

    await this.handleStateTransition({
      state,
      statusMessage: event.status.message,
      completedMessage: extractMessageText(event.status.message),
      tools,
      sender,
      contextId: event.contextId,
      taskId: event.taskId,
      roomId,
      key,
    });
  }

  private trackTask(input: {
    roomId: string;
    key: string;
    taskId: string;
    contextId?: string;
    senderId: string;
  }): { id: string } {
    const sender = this.taskSenders.get(input.key) ?? { id: input.senderId };
    this.taskSenders.set(input.key, sender);
    this.tasks.set(input.roomId, input.taskId);
    if (input.contextId) {
      this.contexts.set(input.roomId, input.contextId);
    }

    return sender;
  }

  private clearTaskTracking(key: string, roomId: string): void {
    this.taskSenders.delete(key);
    this.tasks.delete(roomId);
  }

  private async handleStateTransition(input: {
    state: A2ATaskState;
    statusMessage?: A2AMessageLike;
    completedMessage: string | null;
    tools: MessagingTools;
    sender: { id: string };
    contextId?: string;
    taskId: string;
    roomId: string;
    key: string;
  }): Promise<void> {
    if (input.state === "working") {
      const thought = extractMessageText(input.statusMessage);
      if (thought) {
        await input.tools.sendEvent(thought, "thought");
      }
      return;
    }

    if (input.state === "input-required") {
      const text = extractMessageText(input.statusMessage) ?? "Please provide more information.";
      await input.tools.sendMessage(text, [input.sender]);
      await this.emitTaskEvent(input.tools, input.contextId, input.taskId, input.state);
      return;
    }

    if (input.state === "completed") {
      if (input.completedMessage) {
        await input.tools.sendMessage(input.completedMessage, [input.sender]);
      }
      await this.emitTaskEvent(input.tools, input.contextId, input.taskId, input.state);
      this.clearTaskTracking(input.key, input.roomId);
      return;
    }

    if (TERMINAL_STATES.has(input.state)) {
      const text = extractMessageText(input.statusMessage) ?? `A2A task ${input.state}`;
      await input.tools.sendEvent(text, "error", { a2a_state: input.state });
      await this.emitTaskEvent(input.tools, input.contextId, input.taskId, input.state);
      this.clearTaskTracking(input.key, input.roomId);
    }
  }

  private async emitTaskEvent(
    tools: MessagingTools,
    contextId: string | undefined,
    taskId: string,
    state: A2ATaskState,
  ): Promise<void> {
    await tools.sendEvent(`A2A task ${state}`, "task", {
      a2a_context_id: contextId ?? null,
      a2a_task_id: taskId,
      a2a_task_state: state,
    });
  }

  private toSendParams(message: PlatformMessage, roomId: string): A2AMessageSendParams {
    const contextId = this.contexts.get(roomId);
    const taskId = this.tasks.get(roomId);

    return {
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: message.content }],
        ...(contextId ? { contextId } : {}),
        ...(taskId ? { taskId } : {}),
      },
    };
  }

  private async rehydrateFromHistory(
    roomId: string,
    state: A2ASessionState,
    client: A2AClientLike,
  ): Promise<void> {
    if (state.contextId) {
      this.contexts.set(roomId, state.contextId);
    }

    const normalizedState = normalizeState(state.taskState);
    if (!state.taskId || TERMINAL_STATES.has(normalizedState) || !client.resubscribeTask) {
      return;
    }

    try {
      let resubEventCount = 0;
      for await (const raw of client.resubscribeTask({ id: state.taskId })) {
        resubEventCount += 1;
        if (resubEventCount > this.maxStreamEvents) {
          this.logger.warn("A2A task resubscribe exceeded event limit; continuing with fresh task", {
            roomId,
            taskId: state.taskId,
            maxStreamEvents: this.maxStreamEvents,
          });
          break;
        }
        const event = unwrapResult(raw);
        if (!event) {
          continue;
        }

        if (isTaskEvent(event)) {
          const eventState = normalizeState(event.status.state);
          if (event.contextId) {
            this.contexts.set(roomId, event.contextId);
          }
          if (!TERMINAL_STATES.has(eventState)) {
            this.tasks.set(roomId, state.taskId);
          }
          break;
        }

        if (isStatusUpdateEvent(event)) {
          const eventState = normalizeState(event.status.state);
          if (event.contextId) {
            this.contexts.set(roomId, event.contextId);
          }
          if (!TERMINAL_STATES.has(eventState)) {
            this.tasks.set(roomId, state.taskId);
          }
          break;
        }
      }
    } catch (error) {
      this.logger.warn("A2A task resubscribe failed; continuing with fresh task", {
        roomId,
        taskId: state.taskId,
        error,
      });
    }
  }

  private async createClient(): Promise<A2AClientLike> {
    const factory = this.clientFactory ?? (await loadDefaultA2AClientFactory());
    return factory({
      remoteUrl: this.remoteUrl,
      authHeaders: this.authHeaders,
    });
  }
}

function roomTaskKey(roomId: string, taskId: string): string {
  return `${roomId}:${taskId}`;
}

function normalizeMaxStreamEvents(value: number | undefined): number {
  const maxStreamEvents = value ?? DEFAULT_MAX_STREAM_EVENTS;
  if (!Number.isSafeInteger(maxStreamEvents) || maxStreamEvents < 1) {
    throw new ValidationError("A2AAdapter `maxStreamEvents` must be a positive integer.");
  }

  return maxStreamEvents;
}

function normalizeState(state: unknown): A2ATaskState {
  if (typeof state !== "string") {
    return "unknown";
  }

  const normalized = state.toLowerCase().replaceAll("_", "-");
  if (normalized === "input-required") {
    return "input-required";
  }
  if (normalized === "submitted") {
    return "submitted";
  }
  if (normalized === "working") {
    return "working";
  }
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "canceled") {
    return "canceled";
  }
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "rejected") {
    return "rejected";
  }
  if (normalized === "auth-required") {
    return "auth-required";
  }

  return "unknown";
}

function extractTaskResponse(task: A2ATaskLike): string {
  for (const artifact of task.artifacts ?? []) {
    const text = extractArtifactText(artifact);
    if (text) {
      return text;
    }
  }

  const statusText = extractMessageText(task.status.message);
  if (statusText) {
    return statusText;
  }

  for (let index = (task.history?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = task.history?.[index];
    if (!message || message.role !== "agent") {
      continue;
    }

    const text = extractMessageText(message);
    if (text) {
      return text;
    }
  }

  return "";
}

function extractArtifactText(artifact: A2AArtifactLike | undefined): string | null {
  if (!artifact?.parts) {
    return null;
  }

  return extractPartsText(artifact.parts);
}

function extractMessageText(message: A2AMessageLike | undefined): string | null {
  if (!message?.parts) {
    return null;
  }

  return extractPartsText(message.parts);
}

function extractPartsText(parts: A2AMessagePart[]): string | null {
  const chunks: string[] = [];
  for (const part of parts) {
    const text = extractTextFromPart(part);
    if (text) {
      chunks.push(text);
    }
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("\n");
}

function extractTextFromPart(part: A2AMessagePart | undefined): string | null {
  if (!part) {
    return null;
  }

  if (typeof part.text === "string" && part.text.length > 0) {
    return part.text;
  }

  if (part.root) {
    return extractTextFromPart(part.root);
  }

  return null;
}

function unwrapResult(value: unknown, depth = 0): A2AEventLike | null {
  if (!value || typeof value !== "object" || depth > 10) {
    return null;
  }

  const event = value as Record<string, unknown>;
  if (event.result && typeof event.result === "object") {
    return unwrapResult(event.result, depth + 1);
  }

  return event as A2AEventLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isMessagePart(value: unknown): value is A2AMessagePart {
  if (!isRecord(value)) {
    return false;
  }

  return isOptionalString(value.kind)
    && isOptionalString(value.type)
    && isOptionalString(value.text)
    && (value.root === undefined || isMessagePart(value.root));
}

function isMessageLike(value: unknown): value is A2AMessageLike {
  if (!isRecord(value)) {
    return false;
  }

  if (!isOptionalString(value.kind) || !isOptionalString(value.role)) {
    return false;
  }
  if (!isOptionalString(value.contextId) || !isOptionalString(value.taskId) || !isOptionalString(value.messageId)) {
    return false;
  }
  if (value.parts === undefined) {
    return true;
  }

  return Array.isArray(value.parts) && value.parts.every((part) => isMessagePart(part));
}

function isStatusLike(value: unknown): value is A2AStatusLike {
  if (!isRecord(value)) {
    return false;
  }

  if (!isOptionalString(value.state)) {
    return false;
  }

  return value.message === undefined || isMessageLike(value.message);
}

function isArtifactLike(value: unknown): value is A2AArtifactLike {
  if (!isRecord(value)) {
    return false;
  }

  if (value.parts === undefined) {
    return true;
  }

  return Array.isArray(value.parts) && value.parts.every((part) => isMessagePart(part));
}

function isMessageEvent(event: unknown): event is A2AMessageLike {
  return isRecord(event)
    && event.kind === "message"
    && isMessageLike(event)
    && Array.isArray(event.parts);
}

function isTaskEvent(event: unknown): event is A2ATaskLike {
  if (!isRecord(event) || event.kind !== "task") {
    return false;
  }

  return typeof event.id === "string"
    && isOptionalString(event.contextId)
    && isStatusLike(event.status)
    && (
      event.artifacts === undefined
      || (Array.isArray(event.artifacts) && event.artifacts.every((item: unknown) => isArtifactLike(item)))
    )
    && (event.history === undefined || (Array.isArray(event.history) && event.history.every((item: unknown) => isMessageLike(item))));
}

function isStatusUpdateEvent(event: unknown): event is A2AStatusUpdateEventLike {
  return isRecord(event)
    && event.kind === "status-update"
    && typeof event.taskId === "string"
    && typeof event.contextId === "string"
    && isStatusLike(event.status);
}

function isArtifactUpdateEvent(event: unknown): event is A2AArtifactUpdateEventLike {
  return isRecord(event)
    && event.kind === "artifact-update"
    && typeof event.taskId === "string"
    && typeof event.contextId === "string"
    && isArtifactLike(event.artifact);
}

async function loadDefaultA2AClientFactory(): Promise<A2AClientFactory> {
  let module: Record<string, unknown>;
  try {
    module = (await import("@a2a-js/sdk/client")) as Record<string, unknown>;
  } catch (error) {
    throw new UnsupportedFeatureError(
      `A2AAdapter requires optional dependency @a2a-js/sdk. Install it with "pnpm add @a2a-js/sdk". (${asErrorMessage(error)})`,
    );
  }

  const ClientFactoryCtor = module.ClientFactory as
    | (new (options?: Record<string, unknown>) => {
        createFromAgentCard(agentCard: unknown): Promise<A2AClientLike>;
        createFromUrl(url: string): Promise<A2AClientLike>;
      })
    | undefined;
  const JsonRpcTransportFactoryCtor = module.JsonRpcTransportFactory as
    | (new (options?: Record<string, unknown>) => unknown)
    | undefined;
  const RestTransportFactoryCtor = module.RestTransportFactory as
    | (new (options?: Record<string, unknown>) => unknown)
    | undefined;

  if (!ClientFactoryCtor || !JsonRpcTransportFactoryCtor || !RestTransportFactoryCtor) {
    throw new UnsupportedFeatureError("Failed to initialize A2A client: missing required exports from @a2a-js/sdk/client.");
  }

  return async ({ remoteUrl, authHeaders }) => {
    const fetchImpl = createAuthFetch(authHeaders);
    const factory = new ClientFactoryCtor({
      transports: [
        new JsonRpcTransportFactoryCtor({ fetchImpl }),
        new RestTransportFactoryCtor({ fetchImpl }),
      ],
    });
    // When auth headers are configured, fetch the agent card ourselves so the
    // discovery request carries them. Without this, @a2a-js/sdk's internal
    // DefaultAgentCardResolver fires an unauthenticated GET to
    // <remoteUrl>/.well-known/agent-card.json and 401s before any transport
    // gets a chance to attach Authorization headers.
    if (Object.keys(authHeaders).length > 0) {
      const cardUrl = new URL(".well-known/agent-card.json", remoteUrl).toString();
      const cardResponse = await fetchImpl(cardUrl, { method: "GET" });
      if (!cardResponse.ok) {
        throw new Error(
          `Failed to fetch authenticated A2A agent card from ${cardUrl}: ${cardResponse.status}`,
        );
      }
      const agentCard = (await cardResponse.json()) as unknown;
      return factory.createFromAgentCard(agentCard);
    }
    return factory.createFromUrl(remoteUrl);
  };
}

// RFC 7230 token characters for HTTP header field names.
const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

function createAuthFetch(
  authHeaders: Record<string, string>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  if (typeof globalThis.fetch !== "function") {
    throw new UnsupportedFeatureError("A2AAdapter requires global fetch support (Node.js 20+).");
  }

  const baseFetch = globalThis.fetch.bind(globalThis);

  const validatedHeaders = Object.entries(authHeaders).filter(([key]) => {
    if (!VALID_HEADER_NAME.test(key)) {
      return false;
    }
    return true;
  });

  if (validatedHeaders.length === 0) {
    return baseFetch;
  }

  return async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    for (const [key, value] of validatedHeaders) {
      headers.set(key, value);
    }

    return baseFetch(input, {
      ...init,
      headers,
    });
  };
}

import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import type { ContactEvent, MessageEvent } from "../platform/events";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { AgentToolsRestApi, ChatMessagingRestApi, ChatRoomRestApi, ContactRestApi } from "../client/rest/types";
import type { ContactEventConfig } from "./types";
import { ContactCallbackTools } from "./tools/ContactCallbackTools";
import {
  SYNTHETIC_SENDER_TYPE,
  SYNTHETIC_CONTACT_EVENTS_SENDER_ID,
  SYNTHETIC_CONTACT_EVENTS_SENDER_NAME,
} from "./types";

const LRU_MAX_SIZE = 1000;

export const HUB_ROOM_SYSTEM_PROMPT = `## OVERRIDE: Contact Management Mode

This is your CONTACTS HUB - a dedicated room for managing contact requests.

**IMPORTANT: Do NOT delegate or add participants here.** You handle contact events DIRECTLY using the contact tools below. Do NOT call thenvoi_lookup_peers() or thenvoi_add_participant() in this room.

## Your Role

1. **Review incoming contact requests** - When you see a [Contact Request] message, evaluate it
2. **Take action** - Use the contact tools to respond:
   - \`thenvoi_respond_contact_request(action="approve", request_id="...")\` to accept
   - \`thenvoi_respond_contact_request(action="reject", request_id="...")\` to decline
3. **Report your decision** - Send a thought event explaining what you did

## Example

[Contact Events]: [Contact Request] Alice (@alice) wants to connect.
Request ID: abc-123

Your response:
1. thenvoi_send_event("Received contact request from Alice. Approving.", message_type="thought")
2. thenvoi_respond_contact_request(action="approve", request_id="abc-123")
3. thenvoi_send_event("Approved contact request from Alice (@alice)", message_type="thought")

## Contact Tools (use these, NOT participant tools)
- \`thenvoi_respond_contact_request(action, request_id)\` - Approve/reject requests
- \`thenvoi_list_contact_requests()\` - List pending requests
- \`thenvoi_list_contacts()\` - List current contacts`;

interface RequestInfo {
  fromHandle?: string | null;
  fromName?: string | null;
  toHandle?: string | null;
  toName?: string | null;
  message: string | null;
}

type ContactHandlerRestApi =
  & Partial<AgentToolsRestApi>
  & Pick<ChatMessagingRestApi, "createChatEvent">
  & Pick<ChatRoomRestApi, "createChat">
  & Partial<Pick<ContactRestApi, "listContactRequests">>;

interface ContactEventHandlerOptions {
  config: ContactEventConfig;
  rest: ContactHandlerRestApi;
  logger?: Logger;
  onBroadcast?: (message: string) => void;
  onHubEvent?: (roomId: string, event: MessageEvent) => Promise<void>;
  onHubInit?: (roomId: string, systemPrompt: string) => Promise<void>;
}

type ContactEventFailureStage = "callback" | "hub_room_init" | "hub_room_persist" | "hub_room_dispatch";

export class ContactEventHandlerError extends Error {
  public readonly retryable: boolean;
  public readonly stage: ContactEventFailureStage;
  public readonly eventType: ContactEvent["type"];

  public constructor(input: {
    eventType: ContactEvent["type"];
    stage: ContactEventFailureStage;
    retryable: boolean;
    cause: unknown;
  }) {
    super(`Contact event ${input.eventType} failed during ${input.stage}`, { cause: input.cause });
    this.name = "ContactEventHandlerError";
    this.retryable = input.retryable;
    this.stage = input.stage;
    this.eventType = input.eventType;
  }
}

export class ContactEventHandler {
  private readonly config: ContactEventConfig;
  private readonly rest: ContactHandlerRestApi;
  private readonly logger: Logger;
  private readonly onBroadcast?: (message: string) => void;
  private readonly onHubEvent?: (roomId: string, event: MessageEvent) => Promise<void>;
  private readonly onHubInit?: (roomId: string, systemPrompt: string) => Promise<void>;

  private readonly dedup = new Set<string>();
  private readonly dedupOrder: string[] = [];
  private syntheticIdCounter = 0;
  private readonly requestCache = new Map<string, RequestInfo>();
  private hubRoomId: string | null = null;
  private hubRoomInitPromise: Promise<string> | null = null;

  public constructor(options: ContactEventHandlerOptions) {
    this.config = options.config;
    this.rest = options.rest;
    this.logger = options.logger ?? new NoopLogger();
    this.onBroadcast = options.onBroadcast;
    this.onHubEvent = options.onHubEvent;
    this.onHubInit = options.onHubInit;
  }

  public async handle(event: ContactEvent, tools?: AdapterToolsProtocol): Promise<void> {
    const strategy = this.config.strategy ?? "disabled";
    const hasBroadcast = this.config.broadcastChanges && this.onBroadcast;

    if (strategy === "disabled" && !hasBroadcast) {
      return;
    }

    const dedupKey = this.buildDedupKey(event);
    if (this.dedup.has(dedupKey)) {
      this.logger.debug("Duplicate contact event skipped", { key: dedupKey });
      return;
    }
    this.recordDedup(dedupKey);

    try {
      // Cache request info for enriching updates
      if (event.type === "contact_request_received") {
        this.cacheRequestInfo(event.payload.id, {
          fromHandle: event.payload.from_handle,
          fromName: event.payload.from_name,
          message: event.payload.message ?? null,
        });
      }

      // Broadcast runs regardless of strategy (only for added/removed)
      if (hasBroadcast) {
        const broadcastMsg = this.formatBroadcast(event);
        if (broadcastMsg) {
          this.onBroadcast(broadcastMsg);
        }
      }

      if (strategy === "disabled") {
        return;
      }

      if (strategy === "callback") {
        await this.handleCallback(event, tools);
      } else if (strategy === "hub_room") {
        await this.handleHubRoom(event);
      }
    } catch (error) {
      this.rollbackDedup(dedupKey);
      throw error;
    }
  }

  private async handleCallback(event: ContactEvent, tools?: AdapterToolsProtocol): Promise<void> {
    const callback = this.config.onEvent;
    if (!callback) {
      this.logger.warn("Contact event callback strategy configured but no onEvent callback provided");
      return;
    }

    const callbackTools = tools ?? new ContactCallbackTools(this.rest, event.roomId);

    try {
      await callback(event, callbackTools);
    } catch (error) {
      const failure = this.buildHandlerError(event, "callback", error, false);
      this.logFailure(event, failure.stage, failure.retryable, error);
      throw failure;
    }
  }

  private async handleHubRoom(event: ContactEvent): Promise<void> {
    const hubTaskId = this.config.hubTaskId;
    if (!hubTaskId) {
      this.logger.warn("hub_room strategy requires hubTaskId");
      return;
    }

    // Initialize hub room if needed — use promise lock to prevent concurrent creation.
    if (!this.hubRoomId) {
      if (!this.hubRoomInitPromise) {
        this.hubRoomInitPromise = this.initHubRoom(hubTaskId);
      }
      try {
        this.hubRoomId = await this.hubRoomInitPromise;
      } catch (error) {
        this.hubRoomInitPromise = null;
        const failure = this.buildHandlerError(event, "hub_room_init", error, true);
        this.logFailure(event, failure.stage, failure.retryable, error);
        throw failure;
      }
    }

    const formattedMessage = await this.formatEventMessage(event);
    let persistFailure: ContactEventHandlerError | null = null;

    // Persist as a task event
    try {
      await this.rest.createChatEvent(this.hubRoomId, {
        content: formattedMessage,
        messageType: "contact_event",
        metadata: { contactEventType: event.type, payload: event.payload },
      });
    } catch (error) {
      persistFailure = this.buildHandlerError(event, "hub_room_persist", error, true);
      this.logFailure(event, persistFailure.stage, persistFailure.retryable, error);
    }

    // Push synthetic message to hub for LLM processing
    let dispatchFailure: ContactEventHandlerError | null = null;
    if (this.onHubEvent) {
      const now = new Date().toISOString();
      const syntheticEvent: MessageEvent = {
        type: "message_created",
        roomId: this.hubRoomId,
        payload: {
          id: `contact-evt-${Date.now()}-${this.syntheticIdCounter++}`,
          content: formattedMessage,
          message_type: "contact_event",
          sender_id: SYNTHETIC_CONTACT_EVENTS_SENDER_ID,
          sender_type: SYNTHETIC_SENDER_TYPE,
          sender_name: SYNTHETIC_CONTACT_EVENTS_SENDER_NAME,
          inserted_at: now,
          updated_at: now,
        },
      };

      try {
        await this.onHubEvent(this.hubRoomId, syntheticEvent);
      } catch (error) {
        dispatchFailure = this.buildHandlerError(event, "hub_room_dispatch", error, true);
        this.logFailure(event, dispatchFailure.stage, dispatchFailure.retryable, error);
      }
    }

    if (persistFailure) {
      throw persistFailure;
    }

    if (dispatchFailure) {
      throw dispatchFailure;
    }
  }

  private async initHubRoom(hubTaskId: string): Promise<string> {
    const result = await this.rest.createChat(hubTaskId);
    this.logger.info("Hub room created for contact events", { roomId: result.id });

    if (this.onHubInit) {
      await this.onHubInit(result.id, HUB_ROOM_SYSTEM_PROMPT);
    }

    return result.id;
  }

  public async formatEventMessage(event: ContactEvent): Promise<string> {
    switch (event.type) {
      case "contact_request_received": {
        const msg = event.payload.message ? `\nMessage: "${event.payload.message}"` : "";
        const handle = normalizeHandle(event.payload.from_handle);
        return `[Contact Request] ${event.payload.from_name} (${handle}) wants to connect.${msg}\nRequest ID: ${event.payload.id}`;
      }
      case "contact_request_updated": {
        const info = await this.enrichUpdateEvent(event.payload.id);
        if (info) {
          const name = info.fromName ?? info.toName;
          const rawHandle = info.fromHandle ?? info.toHandle ?? "";
          const handle = normalizeHandle(rawHandle);
          if (name) {
            const direction = info.fromName ? "from" : "to";
            return `[Contact Request Update] Request ${direction} ${name} (${handle}) status changed to: ${event.payload.status}\nRequest ID: ${event.payload.id}`;
          }
        }
        return `[Contact Request Update] Request ${event.payload.id} status changed to: ${event.payload.status}`;
      }
      case "contact_added": {
        const handle = normalizeHandle(event.payload.handle);
        return `[Contact Added] ${event.payload.name} (${handle}) is now a contact.\nType: ${event.payload.type}, ID: ${event.payload.id}`;
      }
      case "contact_removed":
        return `[Contact Removed] Contact ${event.payload.id} was removed.`;
    }

    return assertNever(event);
  }

  private formatBroadcast(event: ContactEvent): string | null {
    switch (event.type) {
      case "contact_added": {
        const handle = normalizeHandle(event.payload.handle);
        return `[Contacts]: ${handle} (${event.payload.name}) is now a contact`;
      }
      case "contact_removed":
        return `[Contacts]: Contact ${event.payload.id} was removed`;
      default:
        return null;
    }
  }

  private async enrichUpdateEvent(requestId: string): Promise<RequestInfo | null> {
    const cached = this.requestCache.get(requestId);
    if (cached) {
      return cached;
    }

    this.logger.debug("Cache miss for request, fetching from API", { requestId });
    return await this.fetchRequestDetails(requestId);
  }

  private async fetchRequestDetails(requestId: string): Promise<RequestInfo | null> {
    if (!this.rest.listContactRequests) {
      return null;
    }

    try {
      const response = await this.rest.listContactRequests({ page: 1, pageSize: 100 });

      for (const req of response.received ?? []) {
        if (req.id === requestId) {
          const info: RequestInfo = {
            fromHandle: req.from_handle,
            fromName: req.from_name,
            message: req.message ?? null,
          };
          this.cacheRequestInfo(requestId, info);
          this.logger.debug("Fetched request details from API (received)", { requestId });
          return info;
        }
      }

      for (const req of response.sent ?? []) {
        if (req.id === requestId) {
          const info: RequestInfo = {
            toHandle: req.to_handle,
            toName: req.to_name,
            message: req.message ?? null,
          };
          this.cacheRequestInfo(requestId, info);
          this.logger.debug("Fetched request details from API (sent)", { requestId });
          return info;
        }
      }

      this.logger.debug("Request not found in API", { requestId });
      return null;
    } catch (error) {
      this.logger.warn("Failed to fetch request details from API", { requestId, error });
      return null;
    }
  }

  private cacheRequestInfo(id: string, info: RequestInfo): void {
    this.requestCache.set(id, info);
    while (this.requestCache.size > LRU_MAX_SIZE) {
      const first = this.requestCache.keys().next();
      if (first.done) break;
      this.requestCache.delete(first.value);
    }
  }

  private buildDedupKey(event: ContactEvent): string {
    const id = event.payload.id;
    if (event.type === "contact_request_updated") {
      return `${event.type}:${id}:${event.payload.status}`;
    }
    return `${event.type}:${id}`;
  }

  private recordDedup(key: string): void {
    this.dedup.add(key);
    this.dedupOrder.push(key);

    while (this.dedupOrder.length > LRU_MAX_SIZE) {
      const evicted = this.dedupOrder.shift();
      if (evicted) {
        this.dedup.delete(evicted);
      }
    }
  }

  private rollbackDedup(key: string): void {
    if (!this.dedup.delete(key)) {
      return;
    }

    const index = this.dedupOrder.lastIndexOf(key);
    if (index >= 0) {
      this.dedupOrder.splice(index, 1);
    }
  }

  private buildHandlerError(
    event: ContactEvent,
    stage: ContactEventFailureStage,
    cause: unknown,
    defaultRetryable: boolean,
  ): ContactEventHandlerError {
    return new ContactEventHandlerError({
      eventType: event.type,
      stage,
      retryable: this.resolveRetryable(cause, defaultRetryable),
      cause,
    });
  }

  private resolveRetryable(error: unknown, defaultRetryable: boolean): boolean {
    if (typeof error === "object" && error !== null && "retryable" in error) {
      return (error as { retryable?: unknown }).retryable === true;
    }

    return defaultRetryable;
  }

  private logFailure(
    event: ContactEvent,
    stage: ContactEventFailureStage,
    retryable: boolean,
    error: unknown,
  ): void {
    this.logger.error("contact_event.failure", {
      type: event.type,
      stage,
      retryable,
      error: this.serializeError(error),
    });
  }

  private serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      const payload: Record<string, unknown> = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };

      if (typeof (error as { retryable?: unknown }).retryable !== "undefined") {
        payload.retryable = (error as { retryable?: unknown }).retryable;
      }

      return payload;
    }

    return { message: String(error) };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled contact event: ${JSON.stringify(value)}`);
}

function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return "@unknown";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

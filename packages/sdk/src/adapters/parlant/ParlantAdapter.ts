import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MessagingTools } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { UnsupportedFeatureError } from "../../core/errors";
import type { PlatformMessage } from "../../runtime/types";
import { renderSystemPrompt } from "../../runtime/prompts";
import { asErrorMessage, asNonEmptyString, asOptionalRecord } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import {
  ParlantHistoryConverter,
  type ParlantMessage,
  type ParlantMessages,
} from "./types";

export interface ParlantClientLike {
  customers: {
    create(
      params: {
        id?: string;
        name: string;
        metadata?: Record<string, string | undefined>;
      },
      requestOptions?: { headers?: Record<string, string> },
    ): Promise<{ id: string }>;
  };
  sessions: {
    create(
      params: {
        agentId: string;
        customerId?: string;
        title?: string;
        metadata?: Record<string, unknown>;
      },
      requestOptions?: { headers?: Record<string, string> },
    ): Promise<{ id: string }>;
    createEvent(
      sessionId: string,
      params: {
        kind: "message" | "status" | "tool" | "custom";
        source:
          | "customer"
          | "customer_ui"
          | "human_agent"
          | "human_agent_on_behalf_of_ai_agent"
          | "ai_agent"
          | "system";
        message?: string;
        data?: unknown;
        moderation?: "auto" | "paranoid" | "none";
        metadata?: Record<string, unknown>;
      },
      requestOptions?: { headers?: Record<string, string> },
    ): Promise<{ id: string; offset: number }>;
    listEvents(
      sessionId: string,
      params?: {
        minOffset?: number;
        source?: string;
        kinds?: string;
        waitForData?: number;
      },
      requestOptions?: { headers?: Record<string, string> },
    ): Promise<Array<Record<string, unknown>>>;
  };
}

export interface ParlantAdapterOptions {
  environment: string;
  baseUrl?: string;
  agentId: string;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
  customSection?: string;
  includeBaseInstructions?: boolean;
  responseTimeoutSeconds?: number;
  maxHistoryMessages?: number;
  historyConverter?: ParlantHistoryConverter;
  clientFactory?: ParlantClientFactory;
  logger?: Logger;
}

export type ParlantClientFactory = () => Promise<ParlantClientLike>;

const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_HISTORY_MESSAGES = 100;

export class ParlantAdapter
  extends SimpleAdapter<ParlantMessages, MessagingTools>
{
  private readonly environment: string;
  private readonly baseUrl?: string;
  private readonly agentId: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly systemPromptOverride?: string;
  private readonly customSection?: string;
  private readonly includeBaseInstructions: boolean;
  private readonly responseTimeoutSeconds: number;
  private readonly maxHistoryMessages: number;
  private readonly clientFactory?: ParlantClientFactory;
  private readonly logger: Logger;

  private readonly clientLoader: LazyAsyncValue<ParlantClientLike>;
  private lastInitFailure = 0;
  private systemPrompt = "";
  private readonly roomSessions = new Map<string, string>();
  private readonly roomCustomers = new Map<string, string>();
  private readonly bootstrappedRooms = new Set<string>();
  private readonly roomSessionInitPromises = new Map<string, Promise<string>>();
  private readonly roomBootstrapInitPromises = new Map<string, Promise<void>>();

  public constructor(options: ParlantAdapterOptions) {
    super({
      historyConverter: options.historyConverter ?? new ParlantHistoryConverter(),
    });

    this.environment = options.environment;
    this.baseUrl = options.baseUrl;
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.headers = { ...(options.headers ?? {}) };
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection;
    this.includeBaseInstructions = options.includeBaseInstructions ?? true;
    this.responseTimeoutSeconds =
      options.responseTimeoutSeconds ?? DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    this.maxHistoryMessages =
      options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.clientFactory = options.clientFactory;
    this.logger = options.logger ?? new NoopLogger();
    this.clientLoader = new LazyAsyncValue({
      load: async () => this.createClient(),
      onRejected: (error) => {
        this.lastInitFailure = Date.now();
        this.logger.error("Parlant client initialization failed", {
          error,
        });
      },
    });
  }

  public async onStarted(
    agentName: string,
    agentDescription: string,
  ): Promise<void> {
    await super.onStarted(agentName, agentDescription);

    this.systemPrompt =
      this.systemPromptOverride ??
      renderSystemPrompt({
        agentName,
        agentDescription,
        customSection: this.customSection,
        includeBaseInstructions: this.includeBaseInstructions,
      });
  }

  public async onMessage(
    message: PlatformMessage,
    tools: MessagingTools,
    history: ParlantMessages,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const senderName = message.senderName ?? message.senderId ?? "User";

    try {
      const client = await this.ensureClient();
      const sessionId = await this.getOrCreateSession(
        client,
        context.roomId,
        senderName,
      );

      if (context.isSessionBootstrap) {
        await this.ensureBootstrapHistory(client, sessionId, context.roomId, history);
      }

      const userMessage = buildUserMessage({
        content: message.content,
        participantsMessage,
        contactsMessage,
      });

      const createdEvent = await client.sessions.createEvent(
        sessionId,
        {
          kind: "message",
          source: "customer",
          message: userMessage,
          moderation: "none",
          metadata: {
            thenvoi_source: "thenvoi-sdk-typescript",
            thenvoi_room_id: context.roomId,
          },
        },
        this.requestOptions(),
      );

      const reply = await this.waitForAiResponse(
        client,
        sessionId,
        createdEvent.offset,
      );

      if (!reply) {
        await tools.sendEvent(
          "Parlant did not return a response before timeout.",
          "error",
          {
            parlant_session_id: sessionId,
            parlant_timeout_seconds: this.responseTimeoutSeconds,
          },
        );
        return;
      }

      await tools.sendMessage(reply, [{ id: message.senderId }]);
    } catch (error) {
      const errorMessage = asErrorMessage(error);
      this.logger.error("Parlant adapter request failed", {
        roomId: context.roomId,
        agentId: this.agentId,
        error,
      });
      try {
        await tools.sendEvent(
          `Parlant adapter error: ${errorMessage}`,
          "error",
          {
            parlant_error: errorMessage,
          },
        );
      } catch (eventError) {
        this.logger.warn("Parlant adapter failed to emit error event", {
          roomId: context.roomId,
          agentId: this.agentId,
          error: eventError,
        });
      }

      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    const pendingSession = this.roomSessionInitPromises.get(roomId);
    const pendingBootstrap = this.roomBootstrapInitPromises.get(roomId);

    // Await in-flight initialization before deleting state to avoid orphaned writes.
    const pendingOperations = [pendingSession, pendingBootstrap].filter(
      (promise): promise is Promise<void> => promise !== undefined,
    );
    await Promise.allSettled(pendingOperations);

    this.roomSessions.delete(roomId);
    this.roomCustomers.delete(roomId);
    this.bootstrappedRooms.delete(roomId);
    this.roomSessionInitPromises.delete(roomId);
    this.roomBootstrapInitPromises.delete(roomId);
  }

  private async getOrCreateSession(
    client: ParlantClientLike,
    roomId: string,
    customerName: string,
  ): Promise<string> {
    const existingSession = this.roomSessions.get(roomId);
    if (existingSession) {
      return existingSession;
    }

    const initializing = this.roomSessionInitPromises.get(roomId);
    if (initializing) {
      return initializing;
    }

    const initPromise = (async (): Promise<string> => {
      const customerId = await this.getOrCreateCustomer(client, roomId, customerName);
      const session = await client.sessions.create(
        {
          agentId: this.agentId,
          customerId,
          title: `Band Room ${roomId.slice(0, 8)}`,
          metadata: {
            thenvoi_room_id: roomId,
          },
        },
        this.requestOptions(),
      );

      if (this.systemPrompt.trim().length > 0) {
        await client.sessions.createEvent(
          session.id,
          {
            kind: "message",
            source: "system",
            message: this.systemPrompt,
            metadata: {
              thenvoi_system_prompt: true,
            },
          },
          this.requestOptions(),
        );
      }

      this.roomSessions.set(roomId, session.id);
      return session.id;
    })();

    this.roomSessionInitPromises.set(roomId, initPromise);
    try {
      return await initPromise;
    } finally {
      const pending = this.roomSessionInitPromises.get(roomId);
      if (pending === initPromise) {
        this.roomSessionInitPromises.delete(roomId);
      }
    }
  }

  private async ensureBootstrapHistory(
    client: ParlantClientLike,
    sessionId: string,
    roomId: string,
    history: ParlantMessages,
  ): Promise<void> {
    if (this.bootstrappedRooms.has(roomId)) {
      return;
    }

    const initializing = this.roomBootstrapInitPromises.get(roomId);
    if (initializing) {
      await initializing;
      return;
    }

    const initPromise = (async (): Promise<void> => {
      if (this.bootstrappedRooms.has(roomId)) {
        return;
      }
      await this.injectHistory(client, sessionId, history);
      this.bootstrappedRooms.add(roomId);
    })();

    this.roomBootstrapInitPromises.set(roomId, initPromise);
    try {
      await initPromise;
    } finally {
      const pending = this.roomBootstrapInitPromises.get(roomId);
      if (pending === initPromise) {
        this.roomBootstrapInitPromises.delete(roomId);
      }
    }
  }

  private async getOrCreateCustomer(
    client: ParlantClientLike,
    roomId: string,
    customerName: string,
  ): Promise<string> {
    const existingCustomer = this.roomCustomers.get(roomId);
    if (existingCustomer) {
      return existingCustomer;
    }

    const customer = await client.customers.create(
      {
        name: customerName,
        metadata: {
          thenvoi_room_id: roomId,
        },
      },
      this.requestOptions(),
    );

    this.roomCustomers.set(roomId, customer.id);
    return customer.id;
  }

  private async injectHistory(
    client: ParlantClientLike,
    sessionId: string,
    history: ParlantMessages,
  ): Promise<void> {
    if (history.length === 0) {
      return;
    }

    const completeHistory = selectCompleteExchanges(history).slice(
      -this.maxHistoryMessages,
    );
    let failedEvents = 0;

    for (const item of completeHistory) {
      try {
        if (item.role === "user") {
          await client.sessions.createEvent(
            sessionId,
            {
              kind: "message",
              source: "customer",
              message: item.content,
              moderation: "none",
              metadata: {
                historical: true,
              },
            },
            this.requestOptions(),
          );
          continue;
        }

        await client.sessions.createEvent(
          sessionId,
          {
            kind: "message",
            source: "ai_agent",
            data: {
              message: item.content,
              participant: {
                displayName: item.sender || this.agentName || "Assistant",
              },
            },
            metadata: {
              historical: true,
            },
          },
            this.requestOptions(),
          );
      } catch (error) {
        failedEvents += 1;
        this.logger.warn("Parlant history injection failed", {
          sessionId,
          roomRole: item.role,
          error,
        });
      }
    }

    if (failedEvents > 0) {
      this.logger.warn("Parlant history injection completed with skipped events", {
        sessionId,
        failedEvents,
      });
    }
  }

  private async waitForAiResponse(
    client: ParlantClientLike,
    sessionId: string,
    minOffset: number,
  ): Promise<string | null> {
    const deadline = Date.now() + this.responseTimeoutSeconds * 1_000;
    let nextOffset = Math.max(0, minOffset + 1);

    while (Date.now() < deadline) {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((deadline - Date.now()) / 1_000),
      );
      const waitForData = Math.min(10, remainingSeconds);

      const events = await client.sessions.listEvents(
        sessionId,
        {
          minOffset: nextOffset,
          source: "ai_agent",
          kinds: "message,status",
          waitForData,
        },
        this.requestOptions(),
      );

      if (!Array.isArray(events) || events.length === 0) {
        continue;
      }

      const ordered = [...events].sort((left, right) => {
        const leftOffset = asNumber(left.offset) ?? Number.MAX_SAFE_INTEGER;
        const rightOffset = asNumber(right.offset) ?? Number.MAX_SAFE_INTEGER;
        return leftOffset - rightOffset;
      });

      for (const event of ordered) {
        const offset = asNumber(event.offset);
        if (offset !== null) {
          nextOffset = Math.max(nextOffset, offset + 1);
        }

        const state = extractStatusState(event);
        if (state === "error" || state === "cancelled") {
          throw new Error(
            `Parlant session ${sessionId} entered terminal status: ${state}`,
          );
        }

        const text = extractEventMessage(event);
        if (text) {
          return text;
        }
      }
    }

    return null;
  }

  private requestOptions(): { headers?: Record<string, string> } | undefined {
    const headers: Record<string, string> = { ...this.headers };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    if (Object.keys(headers).length === 0) {
      return undefined;
    }

    return { headers };
  }

  private async ensureClient(): Promise<ParlantClientLike> {
    if (this.clientLoader.current) {
      return this.clientLoader.get();
    }

    const cooldownMs = 2_000;
    const elapsed = Date.now() - this.lastInitFailure;
    if (this.lastInitFailure > 0 && elapsed < cooldownMs) {
      throw new Error(
        `Parlant client init failed recently (${elapsed}ms ago). Retrying after ${cooldownMs}ms cooldown.`,
      );
    }

    return this.clientLoader.get();
  }

  private async createClient(): Promise<ParlantClientLike> {
    const factory = this.clientFactory ?? (await loadParlantClientFactory({
      environment: this.environment,
      baseUrl: this.baseUrl,
    }));
    return factory();
  }
}

function selectCompleteExchanges(history: ParlantMessages): ParlantMessages {
  const complete: ParlantMessages = [];

  let index = 0;
  while (index < history.length) {
    const current = history[index];

    if (current.role === "user" && current.content) {
      const next = history[index + 1];
      if (next && next.role === "assistant" && next.content) {
        complete.push(current);
        complete.push(next);
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    // Skip orphaned assistant messages without a preceding user message.
    index += 1;
  }

  return complete;
}

function buildUserMessage(input: {
  content: string;
  participantsMessage: string | null;
  contactsMessage: string | null;
}): string {
  const updates: string[] = [];
  if (input.participantsMessage) {
    updates.push(`[System Update]: ${input.participantsMessage}`);
  }
  if (input.contactsMessage) {
    updates.push(`[System Update]: ${input.contactsMessage}`);
  }

  if (updates.length === 0) {
    return input.content;
  }

  return `${updates.join("\n\n")}\n\n${input.content}`;
}

async function loadParlantClientFactory(config: {
  environment: string;
  baseUrl?: string;
}): Promise<ParlantClientFactory> {
  const module = (await import("parlant-client").catch((error: unknown) => {
    throw new UnsupportedFeatureError(
      `ParlantAdapter requires optional dependency parlant-client. Install it with "pnpm add parlant-client". (${error instanceof Error ? error.message : String(error)})`,
    );
  })) as {
    ParlantClient?: new (options: {
      environment: () => string;
      baseUrl?: () => string;
    }) => ParlantClientLike;
  };

  if (!module.ParlantClient) {
    throw new UnsupportedFeatureError(
      "ParlantAdapter requires optional dependency parlant-client. Install it with \"pnpm add parlant-client\".",
    );
  }
  const ParlantClientCtor = module.ParlantClient;

  return async () =>
    new ParlantClientCtor({
      environment: () => config.environment,
      ...(config.baseUrl ? { baseUrl: () => config.baseUrl as string } : {}),
    });
}

function extractStatusState(event: Record<string, unknown>): string | null {
  if ((asNonEmptyString(event.kind) ?? "") !== "status") {
    return null;
  }

  const data = asOptionalRecord(event.data) ?? {};
  return asNonEmptyString(data.state) ?? null;
}

function extractEventMessage(event: Record<string, unknown>): string | null {
  const directData = event.data;
  if (typeof directData === "string" && directData.trim().length > 0) {
    return directData.trim();
  }

  const data = asOptionalRecord(directData) ?? {};

  const message = data.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }

  if (message && typeof message === "object") {
    const messageObject = message as Record<string, unknown>;
    const text = asNonEmptyString(messageObject.text) ?? asNonEmptyString(messageObject.content);
    if (text) {
      return text;
    }
  }

  const content = asNonEmptyString(data.content);
  if (content) {
    return content;
  }

  const chunks = data.chunks;
  if (Array.isArray(chunks)) {
    const lines = chunks
      .filter((chunk): chunk is string => typeof chunk === "string")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    if (lines.length > 0) {
      return lines.join("");
    }
  }

  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return null;
}

export {
  ParlantHistoryConverter,
  type ParlantMessage,
  type ParlantMessages,
};

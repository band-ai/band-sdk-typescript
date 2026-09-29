import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MessagingTools } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import {
  RuntimeStateError,
  UnsupportedFeatureError,
  ValidationError,
  rethrowIfRecoverableTurnFailure,
} from "../../core/errors";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { renderSystemPrompt } from "../../runtime/prompts";
import { asErrorMessage, asNonEmptyString, asOptionalRecord } from "../shared/coercion";
import { PREVIOUS_CONTEXT_HEADER, buildConversationPrompt } from "../shared/conversationPrompt";
import {
  FAILURE_CODE_TIMEOUT,
  agentFailure,
  reportTurnFailure,
} from "../../core/providerFailure";
import { deliverReply } from "../../core/deliveryFailedError";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import {
  ParlantHistoryConverter,
  type ParlantMessage,
  type ParlantMessages,
} from "./types";

type ParlantRequestOptions = { headers?: Record<string, string> };

export interface ParlantClientLike {
  agents: {
    create(
      params: { name: string; description?: string },
      requestOptions?: ParlantRequestOptions,
    ): Promise<{ id: string }>;
    delete(agentId: string, requestOptions?: ParlantRequestOptions): Promise<void>;
  };
  customers: {
    create(
      params: {
        id?: string;
        name: string;
        metadata?: Record<string, string | undefined>;
      },
      requestOptions?: ParlantRequestOptions,
    ): Promise<{ id: string }>;
    delete(customerId: string, requestOptions?: ParlantRequestOptions): Promise<void>;
  };
  sessions: {
    create(
      params: {
        agentId: string;
        customerId?: string;
        title?: string;
        metadata?: Record<string, unknown>;
      },
      requestOptions?: ParlantRequestOptions,
    ): Promise<{ id: string }>;
    delete(sessionId: string, requestOptions?: ParlantRequestOptions): Promise<void>;
    createEvent(
      sessionId: string,
      params: {
        kind: "message" | "status" | "tool" | "custom";
        source:
          | "customer"
          | "customer_ui"
          | "human_agent"
          | "human_agent_on_behalf_of_ai_agent"
          | "ai_agent";
        message?: string;
        data?: unknown;
        moderation?: "auto" | "paranoid" | "none";
        metadata?: Record<string, unknown>;
      },
      requestOptions?: ParlantRequestOptions,
    ): Promise<{ id: string; offset: number }>;
    listEvents(
      sessionId: string,
      params?: {
        minOffset?: number;
        source?: string;
        kinds?: string;
        waitForData?: number;
      },
      requestOptions?: ParlantRequestOptions,
    ): Promise<Array<Record<string, unknown>>>;
  };
}

export interface ParlantAdapterOptions {
  environment: string;
  baseUrl?: string;
  /**
   * An existing Parlant agent to talk through, used as-is: its own description
   * and guidelines define its behaviour, so it cannot be combined with
   * `systemPrompt` or `customSection`. Omit it to have the adapter create an
   * agent from the rendered prompt and delete it when the runtime stops.
   */
  agentId?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
  customSection?: string;
  includeBaseInstructions?: boolean;
  responseTimeoutSeconds?: number;
  /**
   * Most prior room messages folded into a new session's first turn.
   * Defaults to 100.  The value is a cap, not a toggle: `0` folds in none.
   */
  maxHistoryMessages?: number;
  clientFactory?: ParlantClientFactory;
  logger?: Logger;
}

export type ParlantClientFactory = () => Promise<ParlantClientLike>;

const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_HISTORY_MESSAGES = 100;
// Marks agents this adapter created, so a leaked one is recognisable on the server.
const OWNED_AGENT_NAME_PREFIX = "band-";

export class ParlantAdapter
  extends SimpleAdapter<HistoryProvider, MessagingTools>
{
  protected readonly provider = "parlant";

  private readonly environment: string;
  private readonly baseUrl?: string;
  /** Created in `onStarted` and deleted on stop, or borrowed from `options.agentId` and left alone. */
  private readonly ownsAgent: boolean;
  private agentId: string | null;
  private ownedAgentCreation: Promise<string> | null = null;
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
  private readonly roomSessions = new Map<string, string>();
  private readonly roomCustomers = new Map<string, string>();
  private readonly roomSessionInitPromises = new Map<string, Promise<string>>();

  public constructor(options: ParlantAdapterOptions) {
    super();

    // A borrowed agent is never modified, so there is nowhere to put a prompt.
    if (options.agentId && (options.systemPrompt !== undefined || options.customSection !== undefined)) {
      throw new ValidationError(
        "ParlantAdapter cannot apply systemPrompt or customSection to an existing agentId; " +
          "configure that agent on the Parlant server, or omit agentId to let the adapter create one.",
      );
    }

    this.environment = options.environment;
    this.baseUrl = options.baseUrl;
    this.ownsAgent = !options.agentId;
    this.agentId = options.agentId ?? null;
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
    this.logger = resolveLogger(options.logger);
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
    if (!this.ownsAgent) {
      return;
    }

    // Parlant takes no system messages; an agent's description is its prompt.
    const description =
      this.systemPromptOverride ??
      renderSystemPrompt({
        agentName,
        agentDescription,
        customSection: this.customSection,
        includeBaseInstructions: this.includeBaseInstructions,
      });
    const creation = this.createOwnedAgent(agentName, description);
    this.ownedAgentCreation = creation;
    const agentId = await creation;
    // A stop that landed mid-create has already claimed (and deleted) this agent.
    if (this.ownedAgentCreation === creation) {
      this.agentId = agentId;
    }
  }

  public async onRuntimeStop(): Promise<void> {
    if (!this.ownsAgent) {
      return;
    }
    const creation = this.ownedAgentCreation;
    this.ownedAgentCreation = null;
    this.agentId = null;
    // Awaited so an agent still being created when the stop lands is deleted too.
    const agentId = await creation?.catch(() => null);
    const client = this.clientLoader.current;
    if (agentId && client) {
      await this.deleteQuietly("agent", client.agents, agentId);
    }
  }

  public async onMessage(
    message: PlatformMessage,
    tools: MessagingTools,
    history: HistoryProvider,
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

      // Replayed REST events would each trigger a generation, so history rides in the turn itself.
      const userMessage = buildConversationPrompt({
        history,
        isSessionBootstrap: context.isSessionBootstrap,
        participantsMessage,
        contactsMessage,
        historyHeader: PREVIOUS_CONTEXT_HEADER,
        currentMessage: message.content,
        maxHistoryMessages: this.maxHistoryMessages,
      });

      const createdEvent = await client.sessions.createEvent(
        sessionId,
        {
          kind: "message",
          source: "customer",
          message: userMessage,
          moderation: "none",
          metadata: {
            band_source: "band-sdk-typescript",
            band_room_id: context.roomId,
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
        return reportTurnFailure(
          tools,
          agentFailure(this.provider, "Parlant did not return a response before timeout.", FAILURE_CODE_TIMEOUT),
          this.logger,
          { roomId: context.roomId, agentId: this.agentId ?? undefined },
        );
      }

      await deliverReply(tools, reply, [{ id: message.senderId }]);
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error);

      this.logger.error("Parlant adapter request failed", {
        roomId: context.roomId,
        agentId: this.agentId ?? undefined,
        error,
      });
      await reportTurnFailure(
        tools,
        agentFailure(this.provider, asErrorMessage(error)),
        this.logger,
        { roomId: context.roomId, agentId: this.agentId ?? undefined },
      );
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    // Await in-flight initialization before deleting state to avoid orphaned writes.
    await this.roomSessionInitPromises.get(roomId)?.catch(() => {});

    const sessionId = this.roomSessions.get(roomId);
    const customerId = this.roomCustomers.get(roomId);
    this.roomSessions.delete(roomId);
    this.roomCustomers.delete(roomId);
    this.roomSessionInitPromises.delete(roomId);

    const client = this.clientLoader.current;
    if (!client) {
      return;
    }
    if (sessionId) {
      await this.deleteQuietly("session", client.sessions, sessionId);
    }
    if (customerId) {
      await this.deleteQuietly("customer", client.customers, customerId);
    }
  }

  private async createOwnedAgent(agentName: string, description: string): Promise<string> {
    const client = await this.ensureClient();
    const agent = await client.agents.create(
      { name: `${OWNED_AGENT_NAME_PREFIX}${agentName}`, description },
      this.requestOptions(),
    );
    return agent.id;
  }

  /** Teardown never throws: a failed delete leaves server state behind, which is logged, not fatal. */
  private async deleteQuietly(
    kind: string,
    resource: { delete(id: string, requestOptions?: ParlantRequestOptions): Promise<void> },
    id: string,
  ): Promise<void> {
    try {
      await resource.delete(id, this.requestOptions());
    } catch (error) {
      this.logger.warn(`Failed to delete the Parlant ${kind}`, { id, error });
    }
  }

  private requireAgentId(): string {
    const agentId = this.agentId;
    if (!agentId) {
      throw new RuntimeStateError("ParlantAdapter has no Parlant agent; onStarted has not completed.");
    }
    return agentId;
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
          agentId: this.requireAgentId(),
          customerId,
          title: `Band Room ${roomId.slice(0, 8)}`,
          metadata: {
            band_room_id: roomId,
          },
        },
        this.requestOptions(),
      );

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
          band_room_id: roomId,
        },
      },
      this.requestOptions(),
    );

    this.roomCustomers.set(roomId, customer.id);
    return customer.id;
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

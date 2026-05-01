import express, { type NextFunction, type Request, type Response } from "express";
import { ThenvoiClient } from "@thenvoi/rest-client";

import {
  Agent,
  type AgentConfigResult,
  type PlatformMessage,
  isDirectExecution,
  loadAgentConfig,
  loadAgentConfigFromEnv,
} from "@thenvoi/sdk";
import { ConsoleLogger, type Logger } from "@thenvoi/sdk/core";
import {
  createSqliteSessionRoomStore,
  createLinearClient,
  createLinearWebhookHandler,
  handleAgentSessionEvent,
  type LinearBridgeDispatcher,
  type LinearThenvoiBridgeConfig,
  type RoomStrategy,
  type SessionRoomStore,
  type WritebackMode,
} from "../../src/linear";
import { FernRestAdapter, type RestApi } from "../../src/rest";
import { createLinearThenvoiBridgeAgent } from "./linear-thenvoi-bridge-agent";

interface LinearThenvoiBridgeServerOptions {
  restApi: RestApi;
  linearAccessToken: string;
  linearWebhookSecret: string;
  stateDbPath: string;
  store?: SessionRoomStore;
  hostAgentHandle?: string;
  roomStrategy?: RoomStrategy;
  writebackMode?: WritebackMode;
  dispatcher?: LinearBridgeDispatcher;
  logger?: Logger;
}

const VALID_ROOM_STRATEGIES: ReadonlySet<RoomStrategy> = new Set(["issue", "session"]);
const VALID_WRITEBACK_MODES: ReadonlySet<WritebackMode> = new Set(["final_only", "activity_stream"]);
const DISPATCH_RETRY_LIMIT = 2;
const DISPATCH_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_ROOM_RESET_TIMEOUT_MS = 5_000;
const EMBEDDED_AGENT_START_RETRY_LIMIT = 4;
const EMBEDDED_AGENT_START_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_THENVOI_BRIDGE_MIN_REQUEST_INTERVAL_MS = 2_000;
const DEFAULT_THENVOI_BRIDGE_RETRY_LIMIT = 4;
const DEFAULT_THENVOI_BRIDGE_RETRY_BASE_DELAY_MS = 2_000;

export function createLinearThenvoiBridgeApp(options: LinearThenvoiBridgeServerOptions): express.Express {
  const logger = options.logger ?? new ConsoleLogger();
  const store = options.store ?? createSqliteSessionRoomStore(options.stateDbPath);
  const linearClient = createLinearClient(options.linearAccessToken);

  const bridgeConfig: LinearThenvoiBridgeConfig = {
    linearAccessToken: options.linearAccessToken,
    linearWebhookSecret: options.linearWebhookSecret,
    hostAgentHandle: options.hostAgentHandle,
    roomStrategy: options.roomStrategy,
    writebackMode: options.writebackMode ?? "activity_stream",
  };

  const app = express();
  app.disable("x-powered-by");
  app.locals.sessionRoomStore = store;

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ ok: true });
  });

  const webhookHandler = createLinearWebhookHandler({
    config: bridgeConfig,
    dispatcher: options.dispatcher,
    deps: {
      thenvoiRest: options.restApi,
      linearClient,
      store,
      logger,
    },
  });

  app.post("/linear/webhook", express.raw({ type: "*/*" }), async (request, response, next) => {
    try {
      await webhookHandler(request, response);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.error("linear_thenvoi_bridge.webhook_error", {
      error: error instanceof Error ? error.message : String(error),
    });

    if (response.headersSent) {
      return;
    }

    response.status(500).json({ ok: false, error: "webhook_error" });
  });

  return app;
}

export function createEmbeddedLinearBridgeDispatcher(options: {
  agent: Agent;
  store: SessionRoomStore;
  ensureAgentStarted?: () => Promise<void>;
  logger?: Logger;
}): LinearBridgeDispatcher {
  const logger = options.logger ?? new ConsoleLogger();
  const queued = new Set<string>();
  const roomResetTimeoutMs = Number(
    process.env.LINEAR_THENVOI_ROOM_RESET_TIMEOUT_MS ?? String(DEFAULT_ROOM_RESET_TIMEOUT_MS),
  );

  return {
    isQueued: (eventKey: string) => queued.has(eventKey),
    dispatch: (job) => {
      if (queued.has(job.eventKey)) {
        return;
      }

      queued.add(job.eventKey);
      queueMicrotask(() => {
        void runDispatchAttempt(async () => {
          await handleAgentSessionEvent(job.input, {
            skipAcknowledgment: true,
            expectedEventKey: job.eventKey,
            skipRoomWrite: true,
          });

          const pending = await options.store.listPendingBootstrapRequests(20);
          const bootstrap = pending.find((request) => request.eventKey === job.eventKey);
          if (!bootstrap) {
            return;
          }

          if (options.ensureAgentStarted) {
            await options.ensureAgentStarted();
          }

          try {
            if (bootstrap.metadata?.linear_reset_room_session === true) {
              const resetGraceful = await options.agent.resetRoomSession(
                bootstrap.thenvoiRoomId,
                roomResetTimeoutMs,
              );
              if (!resetGraceful) {
                logger.warn("linear_thenvoi_bridge.room_reset_timed_out_continuing", {
                  roomId: bootstrap.thenvoiRoomId,
                  timeoutMs: roomResetTimeoutMs,
                  eventKey: job.eventKey,
                });
              }
            }
            logger.info("linear_thenvoi_bridge.embedded_bootstrap_start", {
              roomId: bootstrap.thenvoiRoomId,
              eventKey: job.eventKey,
              sessionId: job.input.payload.agentSession.id,
            });
            await options.agent.bootstrapRoomMessage(
              bootstrap.thenvoiRoomId,
              buildBootstrapMessage(bootstrap),
            );
            logger.info("linear_thenvoi_bridge.embedded_bootstrap_success", {
              roomId: bootstrap.thenvoiRoomId,
              eventKey: job.eventKey,
              sessionId: job.input.payload.agentSession.id,
            });
          } catch (error) {
            throw markRetryableRoomEventError(error);
          }

          await options.store.markBootstrapRequestProcessed(job.eventKey);
          logger.info("linear_thenvoi_bridge.embedded_bootstrap_marked_processed", {
              roomId: bootstrap.thenvoiRoomId,
              eventKey: job.eventKey,
              sessionId: job.input.payload.agentSession.id,
            });
        }, {
          logger,
          failureEvent: "linear_thenvoi_bridge.embedded_dispatch_failed",
          retryEvent: "linear_thenvoi_bridge.embedded_dispatch_retrying",
          eventKey: job.eventKey,
          sessionId: job.input.payload.agentSession.id,
        }).finally(() => {
          queued.delete(job.eventKey);
        });
      });
    },
  };
}

function buildBootstrapMessage(request: {
  eventKey: string;
  thenvoiRoomId: string;
  expectedContent: string;
  messageType: string;
  senderId?: string | null;
  senderName?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  linearSessionId: string;
}): PlatformMessage {
  return {
    id: `linear-bootstrap:${request.eventKey}`,
    roomId: request.thenvoiRoomId,
    content: request.expectedContent,
    senderId: request.senderId?.trim() || `linear-session:${request.linearSessionId}`,
    senderType: "User",
    senderName: request.senderName?.trim() || "Linear User",
    messageType: request.messageType,
    metadata: request.metadata ?? {},
    createdAt: new Date(request.createdAt),
  };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveBridgeApiKey(logger: Logger): string {
  const configuredKeys = [
    process.env.LINEAR_THENVOI_BRIDGE_AGENT_CONFIG_KEY?.trim(),
    "linear_thenvoi_bridge",
  ].filter((value): value is string => Boolean(value && value.length > 0));

  for (const configKey of configuredKeys) {
    try {
      const config = loadAgentConfig(configKey);
      if (config.apiKey?.trim()) {
        logger.info("linear_thenvoi_bridge.using_agent_config_key", { configKey });
        return config.apiKey;
      }
    } catch {
      continue;
    }
  }

  const fallbackEnvKey = process.env.THENVOI_API_KEY?.trim();
  if (fallbackEnvKey) {
    return fallbackEnvKey;
  }

  throw new Error(
    "Missing API key. Set THENVOI_API_KEY or configure linear_thenvoi_bridge in agent_config.yaml.",
  );
}

function resolveEmbeddedBridgeRuntimeConfigKey(): string {
  return process.env.LINEAR_THENVOI_BRIDGE_RUNTIME_CONFIG_KEY?.trim() ?? "linear_thenvoi_bridge";
}

function resolveEmbeddedBridgeRuntimeConfig(logger: Logger): AgentConfigResult {
  const envApiKey = process.env.THENVOI_BRIDGE_API_KEY?.trim() ?? process.env.THENVOI_API_KEY?.trim();
  const envAgentId = process.env.THENVOI_BRIDGE_AGENT_ID?.trim() ?? process.env.THENVOI_AGENT_ID?.trim();

  if (envApiKey && envAgentId) {
    logger.info("linear_thenvoi_bridge.using_embedded_env_credentials", {
      agentIdSource: process.env.THENVOI_BRIDGE_AGENT_ID?.trim() ? "THENVOI_BRIDGE_AGENT_ID" : "THENVOI_AGENT_ID",
      apiKeySource: process.env.THENVOI_BRIDGE_API_KEY?.trim() ? "THENVOI_BRIDGE_API_KEY" : "THENVOI_API_KEY",
    });

    const envConfig = loadAgentConfigFromEnv({
      env: {
        THENVOI_AGENT_ID: envAgentId,
        THENVOI_API_KEY: envApiKey,
        THENVOI_WS_URL: process.env.THENVOI_WS_URL,
        THENVOI_REST_URL: process.env.THENVOI_REST_URL,
      },
    });

    return {
      agentId: envConfig.agentId,
      apiKey: envConfig.apiKey,
      ...(envConfig.wsUrl ? { wsUrl: envConfig.wsUrl } : {}),
      ...(envConfig.restUrl ? { restUrl: envConfig.restUrl } : {}),
    };
  }

  return loadAgentConfig(resolveEmbeddedBridgeRuntimeConfigKey());
}

export function resolveRestApiKeyForMode(input: {
  logger: Logger;
  embedBridgeAgent: boolean;
  embeddedBridgeConfig: AgentConfigResult | null;
}): string {
  if (!input.embedBridgeAgent) {
    return resolveBridgeApiKey(input.logger);
  }

  const embeddedApiKey = input.embeddedBridgeConfig?.apiKey?.trim();
  if (embeddedApiKey) {
    return embeddedApiKey;
  }

  input.logger.warn("linear_thenvoi_bridge.embedded_mode_missing_runtime_api_key", {
    runtimeConfigKey: resolveEmbeddedBridgeRuntimeConfigKey(),
  });
  return resolveBridgeApiKey(input.logger);
}

function parseRoomStrategy(value: string | undefined): RoomStrategy | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  if (VALID_ROOM_STRATEGIES.has(value as RoomStrategy)) {
    return value as RoomStrategy;
  }

  throw new Error(
    `Invalid LINEAR_THENVOI_ROOM_STRATEGY: "${value}". Expected one of: issue, session.`,
  );
}

function parseWritebackMode(value: string | undefined): WritebackMode | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  if (VALID_WRITEBACK_MODES.has(value as WritebackMode)) {
    return value as WritebackMode;
  }

  throw new Error(
    `Invalid LINEAR_THENVOI_WRITEBACK_MODE: "${value}". Expected one of: final_only, activity_stream.`,
  );
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: "${value}"`);
}

function parseNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer value: "${value}"`);
  }

  return Math.floor(parsed);
}

async function runDispatchAttempt(
  task: () => Promise<void>,
  context: {
    logger: Logger;
    failureEvent: string;
    retryEvent: string;
    eventKey: string;
    sessionId: string;
  },
): Promise<void> {
  const retryLimit = Number(process.env.LINEAR_THENVOI_DISPATCH_RETRY_LIMIT ?? String(DISPATCH_RETRY_LIMIT));
  const retryBaseDelayMs = Number(
    process.env.LINEAR_THENVOI_DISPATCH_RETRY_BASE_DELAY_MS ?? String(DISPATCH_RETRY_BASE_DELAY_MS),
  );
  let attempt = 0;

  while (true) {
    try {
      await task();
      return;
    } catch (error) {
      if (!isRetryableDispatchError(error) || attempt >= retryLimit) {
        context.logger.error(context.failureEvent, {
          eventKey: context.eventKey,
          sessionId: context.sessionId,
          error: serializeError(error),
        });
        return;
      }

      attempt += 1;
      context.logger.warn(context.retryEvent, {
        eventKey: context.eventKey,
        sessionId: context.sessionId,
        attempt,
        delayMs: retryBaseDelayMs * attempt,
        error: serializeError(error),
      });
      await sleep(retryBaseDelayMs * attempt);
    }
  }
}

function isRetryableDispatchError(error: unknown): error is { retryable: true } {
  return typeof error === "object" && error !== null && "retryable" in error && (error as { retryable?: boolean }).retryable === true;
}

function markRetryableRoomEventError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (!/POST \/api\/v1\/agent\/chats\/.+\/events failed \((403|404|429)/.test(error.message)) {
    return error;
  }

  return Object.assign(error, { retryable: true as const });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof (error as { retryable?: unknown }).retryable !== "undefined"
        ? { retryable: (error as { retryable?: unknown }).retryable }
        : {}),
    };
  }

  return {
    message: String(error),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isThenvoiRateLimitError(error: unknown): boolean {
  return error instanceof Error && /\b429\b/.test(error.message);
}

function resolveRateLimitRetryDelayMs(error: unknown, fallbackMs: number): number {
  if (typeof error !== "object" || error === null || !("rawResponse" in error)) {
    return fallbackMs;
  }

  const rawResponse = (error as { rawResponse?: { headers?: Headers } }).rawResponse;
  const retryAfter = rawResponse?.headers?.get("retry-after");
  if (!retryAfter) {
    return fallbackMs;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(fallbackMs, Math.floor(seconds * 1_000));
  }

  return fallbackMs;
}

export function createRateLimitedRestApi(input: {
  api: RestApi;
  minIntervalMs: number;
  retryLimit?: number;
  retryBaseDelayMs?: number;
  logger?: Logger;
}): RestApi {
  const retryLimit = input.retryLimit ?? DEFAULT_THENVOI_BRIDGE_RETRY_LIMIT;
  const retryBaseDelayMs = input.retryBaseDelayMs ?? DEFAULT_THENVOI_BRIDGE_RETRY_BASE_DELAY_MS;

  if (input.minIntervalMs <= 0 && retryLimit <= 0) {
    return input.api;
  }

  let nextStartAt = 0;
  let queue = Promise.resolve();

  const schedule = async <T>(operationName: string, operation: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        const delayMs = Math.max(0, nextStartAt - Date.now());
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        nextStartAt = Date.now() + input.minIntervalMs;

        try {
          return await operation();
        } catch (error) {
          if (!isThenvoiRateLimitError(error) || attempt >= retryLimit) {
            throw error;
          }

          const retryDelayMs = resolveRateLimitRetryDelayMs(
            error,
            retryBaseDelayMs * (attempt + 1),
          );
          nextStartAt = Math.max(nextStartAt, Date.now() + retryDelayMs);
          input.logger?.warn("linear_thenvoi_bridge.rest_rate_limited_retrying", {
            operation: operationName,
            attempt: attempt + 1,
            maxAttempts: retryLimit + 1,
            delayMs: retryDelayMs,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(retryDelayMs);
        }
      }
    };

    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    getAgentMe: (options) => schedule("getAgentMe", () => input.api.getAgentMe(options)),
    createChatMessage: (chatId, message, options) => schedule("createChatMessage", () => input.api.createChatMessage(chatId, message, options)),
    createChatEvent: (chatId, event, options) => schedule("createChatEvent", () => input.api.createChatEvent(chatId, event, options)),
    createChat: (taskId, options) => schedule("createChat", () => input.api.createChat(taskId, options)),
    listChatParticipants: (chatId, options) => schedule("listChatParticipants", () => input.api.listChatParticipants(chatId, options)),
    addChatParticipant: (chatId, participant, options) => schedule("addChatParticipant", () => input.api.addChatParticipant(chatId, participant, options)),
    removeChatParticipant: (chatId, participantId, options) => schedule("removeChatParticipant", () => input.api.removeChatParticipant(chatId, participantId, options)),
    markMessageProcessing: (chatId, messageId, options) => schedule("markMessageProcessing", () => input.api.markMessageProcessing(chatId, messageId, options)),
    markMessageProcessed: (chatId, messageId, options) => schedule("markMessageProcessed", () => input.api.markMessageProcessed(chatId, messageId, options)),
    markMessageFailed: (chatId, messageId, error, options) => schedule("markMessageFailed", () => input.api.markMessageFailed(chatId, messageId, error, options)),
    listPeers: input.api.listPeers
      ? (request, options) => schedule("listPeers", () => input.api.listPeers!(request, options))
      : undefined,
    listChats: input.api.listChats
      ? (request, options) => schedule("listChats", () => input.api.listChats!(request, options))
      : undefined,
    listContacts: input.api.listContacts
      ? (request, options) => schedule("listContacts", () => input.api.listContacts!(request, options))
      : undefined,
    addContact: input.api.addContact
      ? (request, options) => schedule("addContact", () => input.api.addContact!(request, options))
      : undefined,
    removeContact: input.api.removeContact
      ? (request, options) => schedule("removeContact", () => input.api.removeContact!(request, options))
      : undefined,
    listContactRequests: input.api.listContactRequests
      ? (request, options) => schedule("listContactRequests", () => input.api.listContactRequests!(request, options))
      : undefined,
    respondContactRequest: input.api.respondContactRequest
      ? (request, options) => schedule("respondContactRequest", () => input.api.respondContactRequest!(request, options))
      : undefined,
    listMemories: input.api.listMemories
      ? (request, options) => schedule("listMemories", () => input.api.listMemories!(request, options))
      : undefined,
    storeMemory: input.api.storeMemory
      ? (request, options) => schedule("storeMemory", () => input.api.storeMemory!(request, options))
      : undefined,
    getMemory: input.api.getMemory
      ? (memoryId, options) => schedule("getMemory", () => input.api.getMemory!(memoryId, options))
      : undefined,
    supersedeMemory: input.api.supersedeMemory
      ? (memoryId, options) => schedule("supersedeMemory", () => input.api.supersedeMemory!(memoryId, options))
      : undefined,
    archiveMemory: input.api.archiveMemory
      ? (memoryId, options) => schedule("archiveMemory", () => input.api.archiveMemory!(memoryId, options))
      : undefined,
    getChatContext: input.api.getChatContext
      ? (request, options) => schedule("getChatContext", () => input.api.getChatContext!(request, options))
      : undefined,
    listMessages: input.api.listMessages
      ? (request, options) => schedule("listMessages", () => input.api.listMessages!(request, options))
      : undefined,
    getNextMessage: input.api.getNextMessage
      ? (request, options) => schedule("getNextMessage", () => input.api.getNextMessage!(request, options))
      : undefined,
  };
}

function isRetryableEmbeddedStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\b429\b/.test(error.message)
    || /Timed out waiting for Phoenix socket connection/.test(error.message);
}

export async function startEmbeddedAgentWithRetry(agent: Agent, logger: Logger): Promise<void> {
  for (let attempt = 1; attempt <= EMBEDDED_AGENT_START_RETRY_LIMIT; attempt += 1) {
    try {
      await agent.start();
      return;
    } catch (error) {
      if (!isRetryableEmbeddedStartupError(error) || attempt === EMBEDDED_AGENT_START_RETRY_LIMIT) {
        throw error;
      }

      const delayMs = EMBEDDED_AGENT_START_RETRY_BASE_DELAY_MS * attempt;
      logger.warn("linear_thenvoi_bridge.embedded_agent_start_retrying", {
        attempt,
        maxAttempts: EMBEDDED_AGENT_START_RETRY_LIMIT,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
}

async function runLinearThenvoiBridgeServer(): Promise<void> {
  const logger = new ConsoleLogger();
  const port = Number(process.env.PORT ?? "8787");
  const embedBridgeAgent = parseBooleanEnv(process.env.LINEAR_THENVOI_EMBED_AGENT, true);
  const bridgeMinRequestIntervalMs = parseNonNegativeIntEnv(
    process.env.LINEAR_THENVOI_BRIDGE_MIN_REQUEST_INTERVAL_MS,
    DEFAULT_THENVOI_BRIDGE_MIN_REQUEST_INTERVAL_MS,
  );
  const embeddedBridgeRuntimeConfigKey = resolveEmbeddedBridgeRuntimeConfigKey();
  const embeddedBridgeConfig = embedBridgeAgent
    ? resolveEmbeddedBridgeRuntimeConfig(logger)
    : null;
  const bridgeApiKey = resolveRestApiKeyForMode({
    logger,
    embedBridgeAgent,
    embeddedBridgeConfig,
  });
  const stateDbPath = process.env.LINEAR_THENVOI_STATE_DB ?? ".linear-thenvoi-example.sqlite";
  const rawRestApi = new FernRestAdapter(new ThenvoiClient({
    apiKey: bridgeApiKey,
    baseUrl: process.env.THENVOI_REST_URL ?? "https://app.thenvoi.com",
  }));
  const restApi = createRateLimitedRestApi({
    api: rawRestApi,
    minIntervalMs: bridgeMinRequestIntervalMs,
    logger,
  });
  const store = createSqliteSessionRoomStore(stateDbPath);
  const linearAccessToken = getRequiredEnv("LINEAR_ACCESS_TOKEN");
  const linearWebhookSecret = getRequiredEnv("LINEAR_WEBHOOK_SECRET");
  const hostAgentHandle = process.env.THENVOI_HOST_AGENT_HANDLE;
  const roomStrategy = parseRoomStrategy(process.env.LINEAR_THENVOI_ROOM_STRATEGY) ?? "issue";
  const writebackMode = parseWritebackMode(process.env.LINEAR_THENVOI_WRITEBACK_MODE) ?? "activity_stream";

  let embeddedAgent: Agent | null = null;
  let dispatcher: LinearBridgeDispatcher | undefined;
  let embeddedAgentStartPromise: Promise<void> | null = null;

  if (embedBridgeAgent) {
    const bridgeConfig = embeddedBridgeConfig ?? resolveEmbeddedBridgeRuntimeConfig(logger);
    embeddedAgent = createLinearThenvoiBridgeAgent({
      ...bridgeConfig,
      linearAccessToken,
      stateDbPath,
    });
    embeddedAgentStartPromise = startEmbeddedAgentWithRetry(embeddedAgent, logger);
    void embeddedAgentStartPromise.catch(async (error) => {
      logger.warn("linear_thenvoi_bridge.embedded_agent_background_start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await embeddedAgent?.stop().catch(() => {});
    });

    dispatcher = createEmbeddedLinearBridgeDispatcher({
      agent: embeddedAgent,
      store,
      ensureAgentStarted: async () => {
        if (!embeddedAgent) {
          return;
        }

        if (!embeddedAgentStartPromise) {
          embeddedAgentStartPromise = startEmbeddedAgentWithRetry(embeddedAgent, logger);
        }
        try {
          await embeddedAgentStartPromise;
        } catch (error) {
          embeddedAgentStartPromise = null;
          throw error;
        }
      },
      logger,
    });
  }

  const app = createLinearThenvoiBridgeApp({
    restApi,
    linearAccessToken,
    linearWebhookSecret,
    stateDbPath,
    store,
    hostAgentHandle,
    roomStrategy,
    writebackMode,
    dispatcher,
    logger,
  });
  const sessionRoomStore = app.locals.sessionRoomStore as { close?: () => Promise<void> } | undefined;

  const server = app.listen(port, () => {
    logger.info("linear_thenvoi_bridge.server_started", {
      port,
      mode: embedBridgeAgent ? "embedded_bridge_agent" : "agent_rest_adapter",
      thenvoiRestUrl: process.env.THENVOI_REST_URL ?? "https://app.thenvoi.com",
      bridgeMinRequestIntervalMs,
    });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("linear_thenvoi_bridge.shutting_down", {});
    server.close(async () => {
      try {
        await embeddedAgent?.stop();
        await sessionRoomStore?.close?.();
      } catch (error) {
        logger.error("linear_thenvoi_bridge.shutdown_store_close_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isDirectExecution(import.meta.url)) {
  void runLinearThenvoiBridgeServer().catch((error) => {
    const logger = new ConsoleLogger();
    logger.error("linear_thenvoi_bridge.startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

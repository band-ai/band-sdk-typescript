import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import type {
  GatewayCancelRequest,
  GatewayMessagePart,
  GatewayPeer,
  GatewayRequest,
  GatewayServerLike,
  GatewayServerOptions,
} from "./types";
import { buildStatusEvent } from "./statusEvent";
import { asNonEmptyString } from "../shared/coercion";
import { asErrorMessage, BandSdkError, UnsupportedFeatureError, ValidationError } from "../../core/errors";

interface ExpressAppLike {
  use: (...args: unknown[]) => void;
  get: (...args: unknown[]) => void;
  listen: (
    port: number,
    host: string,
    callback?: () => void,
  ) => HttpServer;
}

type ExpressFactory =
  & ((...args: unknown[]) => ExpressAppLike)
  & {
    json: (options?: Record<string, unknown>) => unknown;
  };

interface ExpressRequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

interface ExpressResponseLike {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ExpressResponseLike;
  json: (body: unknown) => void;
}

type ExpressNext = () => void;

interface RuntimeA2AServerModules {
  AGENT_CARD_PATH: string;
  DefaultRequestHandler: new (
    agentCard: Record<string, unknown>,
    taskStore: unknown,
    executor: {
      execute: (
        requestContext: Record<string, unknown>,
        eventBus: {
          publish: (event: unknown) => void;
          finished: () => void;
        },
      ) => Promise<void>;
      cancelTask: (
        taskId: string,
        eventBus: {
          publish: (event: unknown) => void;
          finished: () => void;
        },
      ) => Promise<void>;
    },
  ) => {
    getAgentCard: () => Promise<Record<string, unknown>>;
  };
  InMemoryTaskStore: new () => unknown;
  UserBuilder: {
    noAuthentication: (request: unknown) => Promise<unknown>;
  };
  agentCardHandler: (options: Record<string, unknown>) => unknown;
  jsonRpcHandler: (options: Record<string, unknown>) => unknown;
  restHandler: (options: Record<string, unknown>) => unknown;
  createExpressApp: ExpressFactory;
}

interface AuthenticatedGatewayUser {
  id: string;
  authType: "bearer" | "none";
}

class GatewayPeerExecutor {
  private readonly peer: GatewayPeer;
  private readonly onRequest: GatewayServerOptions["onRequest"];
  private readonly onCancel?: GatewayServerOptions["onCancel"];

  public constructor(options: {
    peer: GatewayPeer;
    onRequest: GatewayServerOptions["onRequest"];
    onCancel?: GatewayServerOptions["onCancel"];
  }) {
    this.peer = options.peer;
    this.onRequest = options.onRequest;
    this.onCancel = options.onCancel;
  }

  public async execute(
    requestContext: Record<string, unknown>,
    eventBus: {
      publish: (event: unknown) => void;
      finished: () => void;
    },
  ): Promise<void> {
    const taskId = asNonEmptyString(requestContext.taskId) ?? randomUUID();
    const contextId = asNonEmptyString(requestContext.contextId) ?? randomUUID();
    const message = asA2AMessage(requestContext.userMessage, contextId, taskId);

    try {
      for await (const event of this.onRequest({
        peerId: this.peer.id,
        peerSlug: this.peer.slug,
        taskId,
        contextId,
        message,
      })) {
        eventBus.publish(event);
        if (event.final) {
          break;
        }
      }
    } catch (error) {
      eventBus.publish(
        buildStatusEvent({
          taskId,
          contextId,
          state: "failed",
          final: true,
          text: "Peer request failed.",
          metadata: buildGatewayExecutionFailureMetadata(error),
        }),
      );
    } finally {
      eventBus.finished();
    }
  }

  public async cancelTask(
    taskId: string,
    eventBus: {
      publish: (event: unknown) => void;
      finished: () => void;
    },
  ): Promise<void> {
    const request: GatewayCancelRequest = {
      peerId: this.peer.id,
      peerSlug: this.peer.slug,
      taskId,
    };
    await this.onCancel?.(request);

    eventBus.publish(
      buildStatusEvent({
        taskId,
        contextId: randomUUID(),
        state: "canceled",
        final: true,
        text: "Task canceled.",
      }),
    );
    eventBus.finished();
  }
}

export class GatewayServer implements GatewayServerLike {
  private readonly options: GatewayServerOptions;
  private server: HttpServer | null = null;
  private started = false;

  public constructor(options: GatewayServerOptions) {
    this.options = options;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    assertGatewayAuthPolicy(
      this.options.host,
      this.options.authToken,
      this.options.allowUnauthenticatedLoopback ?? false,
    );

    const modules = await this.loadModules();
    const gatewayAuthMiddleware = createGatewayAuthMiddleware(this.options.authToken);
    const app = this.createApp(modules, gatewayAuthMiddleware);
    this.registerPeerRoutes(app, modules, gatewayAuthMiddleware);

    this.server = await listen(app, this.options.port, this.options.host);
    this.started = true;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.started = false;

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async loadModules(): Promise<RuntimeA2AServerModules> {
    const modulesLoader = this.options.loadModules as (() => Promise<RuntimeA2AServerModules>) | undefined;
    return modulesLoader ? modulesLoader() : loadA2AServerModules();
  }

  private createApp(
    modules: RuntimeA2AServerModules,
    gatewayAuthMiddleware: ReturnType<typeof createGatewayAuthMiddleware>,
  ): ExpressAppLike {
    const app = modules.createExpressApp();
    app.use(createSecurityHeadersMiddleware());
    app.use(modules.createExpressApp.json({ limit: "1mb" }));
    app.use("/peers", gatewayAuthMiddleware);
    app.get("/peers", (_request: unknown, response: { json: (body: unknown) => void }) => {
      const peers = [...this.options.peersBySlug.values()].map((peer) => ({
        slug: peer.slug,
        id: peer.id,
        name: peer.name,
        description: peer.description,
      }));

      response.json({
        peers,
        count: peers.length,
      });
    });

    return app;
  }

  private registerPeerRoutes(
    app: ExpressAppLike,
    modules: RuntimeA2AServerModules,
    gatewayAuthMiddleware: ReturnType<typeof createGatewayAuthMiddleware>,
  ): void {
    for (const [slug, peer] of this.options.peersBySlug.entries()) {
      this.registerPeerRoute(app, modules, gatewayAuthMiddleware, slug, peer);
    }
  }

  private registerPeerRoute(
    app: ExpressAppLike,
    modules: RuntimeA2AServerModules,
    gatewayAuthMiddleware: ReturnType<typeof createGatewayAuthMiddleware>,
    slug: string,
    peer: GatewayPeer,
  ): void {
    const requestHandler = new modules.DefaultRequestHandler(
      buildAgentCard(peer, this.options.gatewayUrl),
      new modules.InMemoryTaskStore(),
      new GatewayPeerExecutor({
        peer,
        onRequest: this.options.onRequest,
        onCancel: this.options.onCancel,
      }),
    );

    const userBuilder = createUserBuilder(
      {
        authToken: this.options.authToken,
        allowUnauthenticatedLoopback: this.options.allowUnauthenticatedLoopback ?? false,
      },
      modules,
    );
    const peerBasePath = `/agents/${slug}`;

    app.get(
      `${peerBasePath}/.well-known/agent.json`,
      gatewayAuthMiddleware,
      async (_request: unknown, response: { json: (body: unknown) => void }) => {
        response.json(await requestHandler.getAgentCard());
      },
    );

    app.use(
      `${peerBasePath}/${modules.AGENT_CARD_PATH}`,
      gatewayAuthMiddleware,
      modules.agentCardHandler({
        agentCardProvider: requestHandler,
      }),
    );

    app.use(
      `${peerBasePath}/v1`,
      gatewayAuthMiddleware,
      modules.restHandler({
        requestHandler,
        userBuilder,
      }),
    );

    app.use(
      peerBasePath,
      gatewayAuthMiddleware,
      modules.jsonRpcHandler({
        requestHandler,
        userBuilder,
      }),
    );
  }
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  return new GatewayServer(options);
}

async function loadA2AServerModules(): Promise<RuntimeA2AServerModules> {
  const [sdk, server, expressServer, expressModule] = await Promise.all([
    import("@a2a-js/sdk") as Promise<Record<string, unknown>>,
    import("@a2a-js/sdk/server") as Promise<Record<string, unknown>>,
    import("@a2a-js/sdk/server/express") as Promise<Record<string, unknown>>,
    import("express") as Promise<Record<string, unknown>>,
  ]).catch((error: unknown) => {
    throw new UnsupportedFeatureError(
      `A2AGatewayAdapter requires optional dependency @a2a-js/sdk and express. (${asErrorMessage(error)})`,
      error,
    );
  });

  const createExpressApp =
    (expressModule.default as ExpressFactory | undefined) ??
    (expressModule as unknown as ExpressFactory);

  const AGENT_CARD_PATH = asNonEmptyString(sdk.AGENT_CARD_PATH) ?? ".well-known/agent-card.json";
  const DefaultRequestHandler =
    server.DefaultRequestHandler as RuntimeA2AServerModules["DefaultRequestHandler"];
  const InMemoryTaskStore =
    server.InMemoryTaskStore as RuntimeA2AServerModules["InMemoryTaskStore"];
  const UserBuilder = expressServer.UserBuilder as RuntimeA2AServerModules["UserBuilder"];
  const agentCardHandler =
    expressServer.agentCardHandler as RuntimeA2AServerModules["agentCardHandler"];
  const jsonRpcHandler =
    expressServer.jsonRpcHandler as RuntimeA2AServerModules["jsonRpcHandler"];
  const restHandler =
    expressServer.restHandler as RuntimeA2AServerModules["restHandler"];

  if (
    !DefaultRequestHandler ||
    !InMemoryTaskStore ||
    !UserBuilder ||
    typeof agentCardHandler !== "function" ||
    typeof jsonRpcHandler !== "function" ||
    typeof restHandler !== "function" ||
    typeof createExpressApp !== "function" ||
    typeof createExpressApp.json !== "function"
  ) {
    throw new UnsupportedFeatureError(
      "Failed to initialize A2A gateway server: missing required exports from @a2a-js/sdk/server or @a2a-js/sdk/server/express.",
    );
  }

  return {
    AGENT_CARD_PATH,
    DefaultRequestHandler,
    InMemoryTaskStore,
    UserBuilder,
    agentCardHandler,
    jsonRpcHandler,
    restHandler,
    createExpressApp,
  };
}

function buildAgentCard(peer: GatewayPeer, gatewayUrl: string): Record<string, unknown> {
  const url = `${gatewayUrl}/agents/${peer.slug}`;
  return {
    name: peer.name,
    description: peer.description,
    protocolVersion: "0.3.0",
    version: "1.0.0",
    url,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      {
        transport: "JSONRPC",
        url,
      },
      {
        transport: "HTTP+JSON",
        url: `${url}/v1`,
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      {
        id: "default",
        name: peer.name,
        description: peer.description,
        tags: ["band", "gateway"],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  };
}

function asA2AMessage(
  value: unknown,
  fallbackContextId: string,
  fallbackTaskId: string,
): GatewayRequest["message"] {
  if (!value || typeof value !== "object") {
    return {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      contextId: fallbackContextId,
      taskId: fallbackTaskId,
      parts: [],
    };
  }

  const raw = value as Record<string, unknown>;
  const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
  const parts: GatewayMessagePart[] = [];
  for (const part of rawParts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const candidate = part as Record<string, unknown>;
    parts.push({
      kind: asNonEmptyString(candidate.kind) ?? undefined,
      text: asNonEmptyString(candidate.text) ?? undefined,
      root:
        candidate.root && typeof candidate.root === "object"
          ? {
              text: asNonEmptyString((candidate.root as Record<string, unknown>).text) ?? undefined,
            }
          : undefined,
    });
  }

  return {
    kind: "message",
    messageId: asNonEmptyString(raw.messageId) ?? randomUUID(),
    role: asNonEmptyString(raw.role) === "agent" ? "agent" : "user",
    contextId: asNonEmptyString(raw.contextId) ?? fallbackContextId,
    taskId: asNonEmptyString(raw.taskId) ?? fallbackTaskId,
    parts,
  };
}

function listen(
  app: ExpressAppLike,
  port: number,
  host: string,
): Promise<HttpServer> {
  return new Promise<HttpServer>((resolve, reject) => {
    let server: HttpServer | null = null;
    const onListening = () => {
      if (server) {
        resolve(server);
        return;
      }

      queueMicrotask(() => {
        if (server) {
          resolve(server);
          return;
        }

        reject(new Error("Gateway server did not return an HTTP server instance."));
      });
    };

    server = app.listen(port, host, onListening);
    server.once("error", reject);
  });
}

function assertGatewayAuthPolicy(
  host: string,
  authToken?: string,
  allowUnauthenticatedLoopback = false,
): void {
  if (authToken) {
    return;
  }

  if (allowUnauthenticatedLoopback && isLoopbackHost(host)) {
    return;
  }

  throw new ValidationError(
    "A2A gateway authToken is required unless allowUnauthenticatedLoopback is explicitly enabled on a loopback host.",
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "localhost";
}

function createSecurityHeadersMiddleware(): (
  _request: ExpressRequestLike,
  response: ExpressResponseLike,
  next: ExpressNext,
) => void {
  return (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  };
}

function createGatewayAuthMiddleware(
  authToken?: string,
): (
  request: ExpressRequestLike,
  response: ExpressResponseLike,
  next: ExpressNext,
) => void {
  if (!authToken) {
    return (_request, _response, next) => {
      next();
    };
  }

  return (request, response, next) => {
    if (verifyBearerAuthorization(request.headers, authToken)) {
      next();
      return;
    }

    response.status(401).json({
      error: "Unauthorized",
    });
  };
}

function createUserBuilder(
  options: {
    authToken?: string;
    allowUnauthenticatedLoopback: boolean;
  },
  modules: RuntimeA2AServerModules,
): (request: ExpressRequestLike) => Promise<AuthenticatedGatewayUser> {
  const authToken = options.authToken;
  if (!authToken) {
    if (!options.allowUnauthenticatedLoopback) {
      throw new ValidationError(
        "A2A gateway authToken is required unless allowUnauthenticatedLoopback is explicitly enabled on a loopback host.",
      );
    }

    return async (request) => {
      const user = await modules.UserBuilder.noAuthentication(request);
      return {
        id: asNonEmptyString((user as { id?: string } | null | undefined)?.id) ?? "loopback-anonymous",
        authType: "none",
      };
    };
  }

  return async (request) => {
    if (!verifyBearerAuthorization(request.headers, authToken)) {
      throw new BandSdkError("Unauthorized");
    }

    return {
      id: "gateway-bearer",
      authType: "bearer",
    };
  };
}

function getAuthorizationHeader(
  headers: ExpressRequestLike["headers"],
): string | null {
  if (!headers) {
    return null;
  }

  const value = headers.authorization ?? headers.Authorization;
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === "string" ? value : null;
}

function verifyBearerAuthorization(
  headers: ExpressRequestLike["headers"],
  authToken: string,
): boolean {
  const authorization = getAuthorizationHeader(headers);
  if (!authorization) {
    return false;
  }

  return safeHeaderEquals(authorization, `Bearer ${authToken}`);
}

function buildGatewayExecutionFailureMetadata(
  error: unknown,
): Record<string, unknown> {
  return {
    error_type: error instanceof Error ? error.name : "UnknownError",
    error_message: sanitizeGatewayErrorMessage(error),
  };
}

function sanitizeGatewayErrorMessage(error: unknown): string {
  const rawMessage = asErrorMessage(error);
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return "Unknown error";
  }

  const withBearerRedaction = trimmed
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");

  const maxLength = 240;
  if (withBearerRedaction.length <= maxLength) {
    return withBearerRedaction;
  }

  return `${withBearerRedaction.slice(0, maxLength - 3)}...`;
}

function safeHeaderEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

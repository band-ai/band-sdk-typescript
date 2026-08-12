import type { Server as HttpServer } from "node:http";

import { describe, expect, it } from "vitest";

import { createGatewayServer } from "../src/adapters/a2a-gateway/server";
import type {
  GatewayCancelRequest,
  GatewayRequest,
  GatewayServerOptions,
} from "../src/adapters/a2a-gateway/types";

interface RecordedUse {
  args: unknown[];
}

interface RecordedExecutor {
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
}

interface AuthResponse {
  status: (code: number) => AuthResponse;
  json: (payload: unknown) => void;
  setHeader: () => void;
}

function makeServerOptions(
  overrides: Partial<GatewayServerOptions> = {},
): GatewayServerOptions {
  return {
    peersBySlug: new Map([
      ["weather", {
        id: "peer-1",
        slug: "weather",
        name: "Weather",
        description: "Weather agent",
      }],
    ]),
    peersById: new Map(),
    gatewayUrl: "http://localhost:10000",
    host: "127.0.0.1",
    port: 10_000,
    onRequest: async function* () {
      yield {
        kind: "status-update",
        taskId: "task-1",
        contextId: "ctx-1",
        final: true,
        status: {
          state: "completed",
        },
      };
    },
    ...overrides,
  };
}

function createModulesRecorder() {
  const recordedUses: RecordedUse[] = [];
  const recordedExecutors: RecordedExecutor[] = [];
  const recordedCards: Record<string, unknown>[] = [];
  const fakeServer = {
    once: () => fakeServer,
    close: (callback?: (error?: Error) => void) => callback?.(),
  } as unknown as HttpServer;

  const fakeApp = {
    use: (...args: unknown[]) => {
      recordedUses.push({ args });
    },
    get: (..._args: unknown[]) => undefined,
    listen: (_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    },
  };

  const createExpressApp = Object.assign(
    () => fakeApp,
    {
      json: () => "json-middleware",
    },
  );

  const modules = {
    AGENT_CARD_PATH: ".well-known/agent-card.json",
    DefaultRequestHandler: class {
      public constructor(
        agentCard: Record<string, unknown>,
        _taskStore: unknown,
        executor: RecordedExecutor,
      ) {
        recordedCards.push(agentCard);
        recordedExecutors.push(executor);
      }

      public async getAgentCard(): Promise<Record<string, unknown>> {
        return { ok: true };
      }
    },
    InMemoryTaskStore: class {},
    UserBuilder: {
      noAuthentication: async () => ({ id: "anon" }),
    },
    agentCardHandler: (options: Record<string, unknown>) => ({ kind: "agent-card-handler", options }),
    jsonRpcHandler: (options: Record<string, unknown>) => ({ kind: "jsonrpc-handler", options }),
    restHandler: (options: Record<string, unknown>) => ({ kind: "rest-handler", options }),
    createExpressApp,
  };

  return {
    recordedUses,
    recordedExecutors,
    recordedCards,
    loadModules: async () => modules,
  };
}

describe("GatewayServer", () => {
  it("requires auth by default, even on loopback", async () => {
    const { loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      loadModules,
    }));

    await expect(server.start()).rejects.toThrow(
      "A2A gateway authToken is required unless allowUnauthenticatedLoopback is explicitly enabled on a loopback host.",
    );
  });

  it("requires auth when binding to a non-loopback host", async () => {
    const { loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      host: "0.0.0.0",
      loadModules,
    }));

    await expect(server.start()).rejects.toThrow(
      "A2A gateway authToken is required unless allowUnauthenticatedLoopback is explicitly enabled on a loopback host.",
    );
  });

  it("allows explicit unauthenticated loopback mode", async () => {
    const { loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      allowUnauthenticatedLoopback: true,
      loadModules,
    }));

    await expect(server.start()).resolves.toBeUndefined();
    await server.stop();
  });

  it("uses an authenticated user builder when bearer auth is configured", async () => {
    const { recordedUses, loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      authToken: "secret-token",
      loadModules,
    }));

    await server.start();
    await server.stop();

    const handlerConfig = recordedUses.find(
      (entry) =>
        entry.args[0] === "/agents/weather/v1"
        && typeof entry.args[2] === "object"
        && (entry.args[2] as { kind?: string }).kind === "rest-handler",
    );
    const options = (handlerConfig?.args[2] as { options?: { userBuilder?: (request: { headers?: Record<string, string> }) => Promise<unknown> } } | undefined)?.options;

    expect(typeof options?.userBuilder).toBe("function");
    await expect(options?.userBuilder?.({
      headers: {
        authorization: "Bearer secret-token",
      },
    })).resolves.toEqual({
      id: "gateway-bearer",
      authType: "bearer",
    });

    await expect(options?.userBuilder?.({
      headers: {
        authorization: "Bearer wrong-token",
      },
    })).rejects.toThrow("Unauthorized");
  });

  it("applies security headers and bearer auth middleware when configured", async () => {
    const { recordedUses, loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      authToken: "secret-token",
      loadModules,
    }));

    await server.start();
    await server.stop();

    const securityHeadersMiddleware = recordedUses[0]?.args[0];
    expect(typeof securityHeadersMiddleware).toBe("function");

    const headerValues = new Map<string, string>();
    let securityNextCalled = false;
    (securityHeadersMiddleware as (
      request: unknown,
      response: { setHeader: (name: string, value: string) => void },
      next: () => void,
    ) => void)(
      {},
      {
        setHeader: (name, value) => {
          headerValues.set(name, value);
        },
      },
      () => {
        securityNextCalled = true;
      },
    );

    expect(securityNextCalled).toBe(true);
    expect(headerValues.get("X-Frame-Options")).toBe("DENY");
    expect(headerValues.get("X-Content-Type-Options")).toBe("nosniff");

    const peersAuthMiddleware = recordedUses.find((entry) => entry.args[0] === "/peers")?.args[1];
    expect(typeof peersAuthMiddleware).toBe("function");

    let nextCalled = false;
    let statusCode = 200;
    let body: unknown = null;
    const response: AuthResponse = {
      status: (code: number) => {
        statusCode = code;
        return response;
      },
      json: (payload: unknown) => {
        body = payload;
      },
      setHeader: () => undefined,
    };

    (peersAuthMiddleware as (
      request: { headers?: Record<string, string> },
      response: AuthResponse,
      next: () => void,
    ) => void)({}, response, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });

    (peersAuthMiddleware as (
      request: { headers?: Record<string, string> },
      response: AuthResponse,
      next: () => void,
    ) => void)({
      headers: {
        authorization: "Bearer secret-token",
      },
    }, response, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("forwards canonical peer ids to adapter callbacks and includes slug aliases", async () => {
    const { recordedExecutors, loadModules } = createModulesRecorder();
    const requestCalls: GatewayRequest[] = [];
    const cancelCalls: GatewayCancelRequest[] = [];
    const server = createGatewayServer(makeServerOptions({
      allowUnauthenticatedLoopback: true,
      loadModules,
      onRequest: async function* (request) {
        requestCalls.push(request);
        yield {
          kind: "status-update",
          taskId: request.taskId,
          contextId: request.contextId,
          final: true,
          status: {
            state: "completed",
          },
        };
      },
      onCancel: async (request) => {
        cancelCalls.push(request);
      },
    }));

    await server.start();
    const executor = recordedExecutors[0];
    expect(executor).toBeDefined();
    if (!executor) {
      throw new Error("Expected a recorded gateway executor");
    }

    await executor.execute(
      {
        taskId: "task-exec",
        contextId: "ctx-exec",
        userMessage: {
          kind: "message",
          messageId: "m-1",
          role: "user",
          parts: [],
        },
      },
      {
        publish: () => undefined,
        finished: () => undefined,
      },
    );

    await executor.cancelTask("task-cancel", {
      publish: () => undefined,
      finished: () => undefined,
    });
    await server.stop();

    expect(requestCalls[0]).toMatchObject({
      peerId: "peer-1",
      peerSlug: "weather",
      taskId: "task-exec",
      contextId: "ctx-exec",
    });
    expect(cancelCalls[0]).toEqual({
      peerId: "peer-1",
      peerSlug: "weather",
      taskId: "task-cancel",
    });
  });

  it("includes sanitized failure metadata when peer execution throws", async () => {
    const { recordedExecutors, loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      allowUnauthenticatedLoopback: true,
      loadModules,
      onRequest: async function* () {
        throw new Error("upstream failed Bearer secret-token token=abc123 api_key=xyz");
      },
    }));

    await server.start();
    const executor = recordedExecutors[0];
    expect(executor).toBeDefined();
    if (!executor) {
      throw new Error("Expected a recorded gateway executor");
    }

    const publishedEvents: unknown[] = [];
    await executor.execute(
      {
        taskId: "task-fail",
        contextId: "ctx-fail",
        userMessage: {
          kind: "message",
          messageId: "m-fail",
          role: "user",
          parts: [],
        },
      },
      {
        publish: (event) => {
          publishedEvents.push(event);
        },
        finished: () => undefined,
      },
    );
    await server.stop();

    expect(publishedEvents).toHaveLength(1);
    const event = publishedEvents[0] as {
      kind?: string;
      final?: boolean;
      status?: { state?: string };
      metadata?: Record<string, unknown>;
    };

    expect(event.kind).toBe("status-update");
    expect(event.final).toBe(true);
    expect(event.status?.state).toBe("failed");
    expect(event.metadata?.error_type).toBe("Error");
    expect(typeof event.metadata?.error_message).toBe("string");
    expect(String(event.metadata?.error_message)).toContain("[REDACTED]");
    expect(String(event.metadata?.error_message)).not.toContain("secret-token");
    expect(String(event.metadata?.error_message)).not.toContain("abc123");
    expect(String(event.metadata?.error_message)).not.toContain("xyz");
  });

  it("builds agent card skills tagged with band and gateway", async () => {
    const { recordedCards, loadModules } = createModulesRecorder();
    const server = createGatewayServer(makeServerOptions({
      allowUnauthenticatedLoopback: true,
      loadModules,
    }));

    await server.start();
    await server.stop();

    expect(recordedCards).toHaveLength(1);
    const card = recordedCards[0] as {
      skills?: Array<{ id?: string; tags?: string[] }>;
    };
    expect(card.skills).toHaveLength(1);
    expect(card.skills?.[0]?.tags).toEqual(["band", "gateway"]);
  });
});

import { createHmac } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInProcessLinearBridgeDispatcher,
  createLinearWebhookHandler,
  type LinearBridgeDispatcher,
  type LinearThenvoiBridgeConfig,
  type PendingBootstrapRequest,
  type PermissionChangeCallbacks,
  type SessionRoomRecord,
  type SessionRoomStore,
} from "../src/linear";
import { LinearThenvoiExampleRestApi } from "../examples/linear-thenvoi/linear-thenvoi-rest-stub";

class MemorySessionRoomStore implements SessionRoomStore {
  private readonly records = new Map<string, SessionRoomRecord>();
  private readonly bootstrapRequests = new Map<string, PendingBootstrapRequest>();

  public async getBySessionId(sessionId: string): Promise<SessionRoomRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  public async getByIssueId(issueId: string): Promise<SessionRoomRecord | null> {
    return [...this.records.values()].find((record) => record.linearIssueId === issueId) ?? null;
  }

  public async upsert(record: SessionRoomRecord): Promise<void> {
    this.records.set(record.linearSessionId, record);
  }

  public async markCanceled(sessionId: string): Promise<void> {
    const existing = this.records.get(sessionId);
    if (!existing) {
      return;
    }

    this.records.set(sessionId, {
      ...existing,
      status: "canceled",
      updatedAt: new Date().toISOString(),
    });
  }

  public async enqueueBootstrapRequest(request: PendingBootstrapRequest): Promise<void> {
    this.bootstrapRequests.set(request.eventKey, request);
  }

  public async listPendingBootstrapRequests(): Promise<PendingBootstrapRequest[]> {
    return [...this.bootstrapRequests.values()];
  }

  public async markBootstrapRequestProcessed(eventKey: string): Promise<void> {
    this.bootstrapRequests.delete(eventKey);
  }
}

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.clear();
});

const config: LinearThenvoiBridgeConfig = {
  linearAccessToken: "lin_api_test",
  linearWebhookSecret: "linear_webhook_secret",
  hostAgentHandle: "linear-host",
  roomStrategy: "issue",
  writebackMode: "activity_stream",
};

function makePayload() {
  return {
    action: "created",
    type: "AgentSessionEvent",
    appUserId: "app-user",
    createdAt: new Date(),
    oauthClientId: "oauth-client",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    promptContext: "@research-agent investigate and summarize",
    agentSession: {
      id: "session-1",
      issueId: "issue-1",
      status: "active",
      type: "issue",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      organizationId: "org-1",
      updatedAt: new Date().toISOString(),
      issue: {
        id: "issue-1",
        title: "Investigate bug",
        identifier: "INT-1",
        team: {
          id: "team-1",
          key: "INT",
          name: "Integrations",
        },
        teamId: "team-1",
        url: "https://linear.app/example/issue/INT-1",
      },
    },
  };
}

function sign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function startServer(dispatcher?: LinearBridgeDispatcher, permissionCallbacks?: PermissionChangeCallbacks) {
  const store = new MemorySessionRoomStore();
  const linearClient = {
    createAgentActivity: vi.fn(async () => ({ ok: true })),
    agentSessionUpdateExternalUrl: vi.fn(async () => ({ success: true })),
    issue: vi.fn(async () => ({ id: "issue-1", delegateId: null })),
    workflowStates: vi.fn(async () => ({ nodes: [] })),
    updateIssue: vi.fn(async () => ({ success: true })),
  };
  const handler = createLinearWebhookHandler({
    config,
    dispatcher,
    permissionCallbacks,
    deps: {
      thenvoiRest: new LinearThenvoiExampleRestApi(),
      linearClient: linearClient as never,
      store,
    },
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.add(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    linearClient,
    store,
    url: `http://127.0.0.1:${address.port}/linear/webhook`,
  };
}

async function startServerWithDeps(deps: {
  thenvoiRest: unknown;
  store: SessionRoomStore;
  linearClient?: unknown;
}) {
  const linearClient = deps.linearClient ?? {
    createAgentActivity: vi.fn(async () => ({ ok: true })),
  };
  const handler = createLinearWebhookHandler({
    config,
    deps: {
      thenvoiRest: deps.thenvoiRest as never,
      linearClient: linearClient as never,
      store: deps.store,
    },
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.add(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/linear/webhook`,
  };
}

function makeTeamAccessChangedPayload(overrides?: {
  addedTeamIds?: string[];
  removedTeamIds?: string[];
  canAccessAllPublicTeams?: boolean;
}) {
  return {
    type: "PermissionChange",
    action: "teamAccessChanged",
    appUserId: "app-user",
    createdAt: new Date(),
    oauthClientId: "oauth-client",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    addedTeamIds: overrides?.addedTeamIds ?? ["team-new"],
    removedTeamIds: overrides?.removedTeamIds ?? ["team-old"],
    canAccessAllPublicTeams: overrides?.canAccessAllPublicTeams ?? false,
  };
}

function makeOAuthAppRevokedPayload() {
  return {
    type: "OAuthApp",
    action: "revoked",
    createdAt: new Date(),
    oauthClientId: "oauth-client",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
  };
}

describe("createLinearWebhookHandler", () => {
  it("verifies the payload, posts acknowledgment, and dispatches async work", async () => {
    const queued = new Set<string>();
    const dispatcher = {
      isQueued: (eventKey: string) => queued.has(eventKey),
      dispatch: vi.fn((job) => {
        queued.add(job.eventKey);
      }),
    } satisfies LinearBridgeDispatcher;

    const { linearClient, url } = await startServer(dispatcher);
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(linearClient.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        content: expect.objectContaining({
          type: "thought",
          body: "Received session. Setting up workspace...",
        }),
      }),
    );
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("rejects invalid signatures", async () => {
    const { url } = await startServer();
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": "invalid",
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid webhook");
  });

  it("rejects requests missing timestamp headers", async () => {
    const { url } = await startServer();
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Missing webhook timestamp");
  });

  it("marks bootstrap handoff processed after inline dispatch", async () => {
    const { store, url } = await startServer();
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([]);
  });

  it("skips events that are already queued", async () => {
    const queued = new Set<string>();
    const dispatcher = {
      isQueued: (eventKey: string) => queued.has(eventKey),
      dispatch: vi.fn((job) => {
        queued.add(job.eventKey);
      }),
    } satisfies LinearBridgeDispatcher;

    const { linearClient, url } = await startServer(dispatcher);
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "linear-signature": sign(config.linearWebhookSecret, rawBody),
      "linear-timestamp": String(payload.webhookTimestamp),
    };

    const first = await fetch(url, { method: "POST", headers, body: rawBody });
    const second = await fetch(url, { method: "POST", headers, body: rawBody });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(linearClient.createAgentActivity).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent duplicate deliveries while first request is in flight", async () => {
    let resolveDispatch: (value: void | PromiseLike<void>) => void = () => undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    const dispatcher = {
      dispatch: vi.fn(async () => {
        await dispatchGate;
      }),
    } satisfies LinearBridgeDispatcher;

    const { linearClient, url } = await startServer(dispatcher);
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "linear-signature": sign(config.linearWebhookSecret, rawBody),
      "linear-timestamp": String(payload.webhookTimestamp),
    };

    const firstRequest = fetch(url, { method: "POST", headers, body: rawBody });
    await vi.waitFor(() => {
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    const secondRequest = await fetch(url, { method: "POST", headers, body: rawBody });
    expect(secondRequest.status).toBe(200);
    await expect(secondRequest.text()).resolves.toBe("OK");

    resolveDispatch(undefined);

    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.text()).resolves.toBe("OK");
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(linearClient.createAgentActivity).toHaveBeenCalledOnce();
  });

  it("processes PermissionChange webhook and invokes onTeamAccessChanged callback", async () => {
    const onTeamAccessChanged = vi.fn();
    const { url } = await startServer(undefined, { onTeamAccessChanged });
    const payload = makeTeamAccessChangedPayload({
      addedTeamIds: ["team-3", "team-4"],
      removedTeamIds: ["team-1"],
      canAccessAllPublicTeams: true,
    });
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onTeamAccessChanged).toHaveBeenCalledOnce();
    expect(onTeamAccessChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PermissionChange",
        action: "teamAccessChanged",
        addedTeamIds: ["team-3", "team-4"],
        removedTeamIds: ["team-1"],
        canAccessAllPublicTeams: true,
      }),
    );
  });

  it("returns 200 for PermissionChange webhook even without a callback", async () => {
    const { url } = await startServer();
    const payload = makeTeamAccessChangedPayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
  });

  it("returns 200 for PermissionChange webhook even when callback throws", async () => {
    const onTeamAccessChanged = vi.fn(async () => {
      throw new Error("callback boom");
    });
    const { url } = await startServer(undefined, { onTeamAccessChanged });
    const payload = makeTeamAccessChangedPayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onTeamAccessChanged).toHaveBeenCalledOnce();
  });

  it("ignores non-teamAccessChanged PermissionChange events without invoking callback", async () => {
    const onTeamAccessChanged = vi.fn();
    const { url } = await startServer(undefined, { onTeamAccessChanged });
    const payload = { ...makeTeamAccessChangedPayload(), action: "somethingElse" };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onTeamAccessChanged).not.toHaveBeenCalled();
  });

  it("processes OAuthApp revoked webhook and invokes onOAuthAppRevoked callback", async () => {
    const onOAuthAppRevoked = vi.fn();
    const { url } = await startServer(undefined, { onOAuthAppRevoked });
    const payload = makeOAuthAppRevokedPayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onOAuthAppRevoked).toHaveBeenCalledOnce();
    expect(onOAuthAppRevoked).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OAuthApp",
        action: "revoked",
        oauthClientId: "oauth-client",
      }),
    );
  });

  it("returns 200 for OAuthApp revoked webhook even without a callback", async () => {
    const { url } = await startServer();
    const payload = makeOAuthAppRevokedPayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
  });

  it("returns 200 for OAuthApp revoked webhook even when callback throws", async () => {
    const onOAuthAppRevoked = vi.fn(async () => {
      throw new Error("callback boom");
    });
    const { url } = await startServer(undefined, { onOAuthAppRevoked });
    const payload = makeOAuthAppRevokedPayload();
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onOAuthAppRevoked).toHaveBeenCalledOnce();
  });

  it("ignores non-revoked OAuthApp events without invoking callback", async () => {
    const onOAuthAppRevoked = vi.fn();
    const { url } = await startServer(undefined, { onOAuthAppRevoked });
    const payload = { ...makeOAuthAppRevokedPayload(), action: "authorized" };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(onOAuthAppRevoked).not.toHaveBeenCalled();
  });

  it("signals terminal async dispatch failures and surfaces them via waitForIdle", async () => {
    const store = new MemorySessionRoomStore();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const linearClient = {
      createAgentActivity: vi
        .fn()
        .mockRejectedValueOnce(new Error("initial error reporting failed"))
        .mockResolvedValueOnce({ ok: true }),
      agentSessionUpdateExternalUrl: vi.fn(async () => ({ success: true })),
      issue: vi.fn(async () => ({ id: "issue-1", delegateId: null })),
      workflowStates: vi.fn(async () => ({ nodes: [] })),
      updateIssue: vi.fn(async () => ({ success: true })),
    };
    const thenvoiRest = {
      getAgentMe: vi.fn(async () => ({ id: "agent-1", handle: "linear-host" })),
      createChat: vi.fn(async () => {
        throw new Error("createChat failed");
      }),
    };
    const dispatcher = createInProcessLinearBridgeDispatcher({ logger });

    dispatcher.dispatch({
      eventKey: "session-1:created:terminal-failure",
      input: {
        payload: makePayload() as never,
        config,
        deps: {
          thenvoiRest: thenvoiRest as never,
          linearClient: linearClient as never,
          store,
          logger,
        },
      },
    });

    if (!dispatcher.waitForIdle) {
      throw new Error("Expected in-process dispatcher to expose waitForIdle()");
    }

    await expect(dispatcher.waitForIdle()).rejects.toThrow(
      "Linear bridge async dispatch failed for 1 event(s)",
    );

    expect(linearClient.createAgentActivity).toHaveBeenCalledTimes(2);
    expect(linearClient.createAgentActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        content: expect.objectContaining({
          type: "error",
          body: expect.stringContaining("could not recover automatically"),
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.async_dispatch_terminal_failure_signaled",
      expect.objectContaining({
        eventKey: "session-1:created:terminal-failure",
        signal: "linear_activity_error",
      }),
    );
  });

  it("returns 200 for AppUserNotification webhook payloads", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
    } satisfies LinearBridgeDispatcher;
    const { url } = await startServer(dispatcher);

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      notification: {
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        id: "notif-1",
        issueId: "issue-1",
        actorId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user",
        issue: { id: "issue-1", title: "Test issue" },
      },
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("deduplicates notification webhooks with the same notification id", async () => {
    const store = new MemorySessionRoomStore();
    const session: SessionRoomRecord = {
      linearSessionId: "session-dedup",
      linearIssueId: "issue-dedup",
      thenvoiRoomId: "room-dedup",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(session);

    const thenvoiRest = new LinearThenvoiExampleRestApi();
    const { url } = await startServerWithDeps({
      thenvoiRest,
      store,
    });

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      notification: {
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        id: "notif-dedup",
        issueId: "issue-dedup",
        actorId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user",
        issue: { id: "issue-dedup", title: "Dedup test" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "linear-signature": sign(config.linearWebhookSecret, rawBody),
      "linear-timestamp": String(payload.webhookTimestamp),
    };

    const first = await fetch(url, { method: "POST", headers, body: rawBody });
    expect(first.status).toBe(200);

    const second = await fetch(url, { method: "POST", headers, body: rawBody });
    expect(second.status).toBe(200);

    // Only one disengagement message should have been sent
    expect(thenvoiRest.roomEvents).toHaveLength(1);
  });

  it("returns 200 even when notification handling throws", async () => {
    const store = new MemorySessionRoomStore();
    const thenvoiRest = {
      getAgentMe: vi.fn(async () => ({ id: "agent-1", handle: "linear-host" })),
      createChatEvent: vi.fn(async () => {
        throw new Error("room write failed");
      }),
    };

    const { url } = await startServerWithDeps({
      thenvoiRest: thenvoiRest as never,
      store,
    });

    const session: SessionRoomRecord = {
      linearSessionId: "session-fail",
      linearIssueId: "issue-fail",
      thenvoiRoomId: "room-fail",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(session);

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      notification: {
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        id: "notif-fail",
        issueId: "issue-fail",
        actorId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user",
        issue: { id: "issue-fail", title: "Fail test" },
      },
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
  });

  it("does not dedup a notification whose handler previously failed", async () => {
    const store = new MemorySessionRoomStore();
    const session: SessionRoomRecord = {
      linearSessionId: "session-retry",
      linearIssueId: "issue-retry",
      thenvoiRoomId: "room-retry",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(session);

    const thenvoiRest = {
      getAgentMe: vi.fn(async () => ({ id: "agent-1", handle: "linear-host" })),
      createChatEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce(undefined),
    };

    const { url } = await startServerWithDeps({
      thenvoiRest: thenvoiRest as never,
      store,
    });

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      notification: {
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        id: "notif-retry",
        issueId: "issue-retry",
        actorId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user",
        issue: { id: "issue-retry", title: "Retry test" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "linear-signature": sign(config.linearWebhookSecret, rawBody),
      "linear-timestamp": String(payload.webhookTimestamp),
    };

    // First attempt — handler throws (createChatEvent rejects)
    const first = await fetch(url, { method: "POST", headers, body: rawBody });
    expect(first.status).toBe(200);

    // Second attempt (retry) — same notification id, should NOT be deduped
    const second = await fetch(url, { method: "POST", headers, body: rawBody });
    expect(second.status).toBe(200);

    // createChatEvent should have been called twice (once failed, once succeeded)
    expect(thenvoiRest.createChatEvent).toHaveBeenCalledTimes(2);
  });

  it("returns 200 when notification payload is missing the notification field", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
    } satisfies LinearBridgeDispatcher;
    const { url } = await startServer(dispatcher);

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      // notification field intentionally omitted
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("skips self-notification comments at the webhook level", async () => {
    const store = new MemorySessionRoomStore();
    const session: SessionRoomRecord = {
      linearSessionId: "session-self",
      linearIssueId: "issue-self",
      thenvoiRoomId: "room-self",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(session);

    const thenvoiRest = new LinearThenvoiExampleRestApi();
    const { url } = await startServerWithDeps({
      thenvoiRest,
      store,
    });

    const payload = {
      type: "AppUserNotification",
      action: "create",
      appUserId: "app-user-bot",
      createdAt: new Date().toISOString(),
      oauthClientId: "oauth-client",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
      notification: {
        __typename: "IssueNewCommentNotificationWebhookPayload",
        id: "notif-self-wh",
        issueId: "issue-self",
        commentId: "comment-self-wh",
        comment: { body: "Bot wrote this" },
        actor: { name: "Bot" },
        actorId: "app-user-bot",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-bot",
        issue: { id: "issue-self", title: "Self test" },
      },
    };
    const rawBody = JSON.stringify(payload);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(config.linearWebhookSecret, rawBody),
        "linear-timestamp": String(payload.webhookTimestamp),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    // No message should have been sent to the room
    expect(thenvoiRest.roomEvents).toHaveLength(0);
  });
});

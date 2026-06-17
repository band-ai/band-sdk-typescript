import { describe, expect, it } from "vitest";

import {
  createLinearBridgeRuntime,
  handleAgentSessionEvent,
  type HandleAgentSessionEventInput,
  type LinearThenvoiBridgeConfig,
  type PendingBootstrapRequest,
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
    const values = [...this.records.values()]
      .filter((record) => record.linearIssueId === issueId && record.status !== "canceled")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return values[0] ?? null;
  }

  public async upsert(record: SessionRoomRecord): Promise<void> {
    this.records.set(record.linearSessionId, record);
  }

  public async markCanceled(sessionId: string): Promise<void> {
    const current = this.records.get(sessionId);
    if (!current) {
      return;
    }

    this.records.set(sessionId, {
      ...current,
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

class FlakyRoomReuseRestApi extends LinearThenvoiExampleRestApi {
  private readonly failedRooms = new Set<string>();

  public override async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const existingEventCount = this.roomEvents.filter((entry) => entry.roomId === chatId).length;
    if (existingEventCount >= 1 && !this.failedRooms.has(chatId)) {
      this.failedRooms.add(chatId);
      throw new Error(`POST /api/v1/agent/chats/${chatId}/events failed (403; response body omitted; content-type=text/html)`);
    }

    return super.createChatEvent(chatId, event);
  }
}

class FlakyRecoveredRoomRestApi extends LinearThenvoiExampleRestApi {
  private readonly failedRooms = new Set<string>();
  private readonly retriedRecoveredRooms = new Set<string>();

  public override async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const existingEventCount = this.roomEvents.filter((entry) => entry.roomId === chatId).length;
    if (existingEventCount >= 1 && !this.failedRooms.has(chatId)) {
      this.failedRooms.add(chatId);
      throw new Error(`POST /api/v1/agent/chats/${chatId}/events failed (403; response body omitted; content-type=text/html)`);
    }

    if (chatId !== "room-1" && existingEventCount === 0 && !this.retriedRecoveredRooms.has(chatId)) {
      this.retriedRecoveredRooms.add(chatId);
      throw new Error(`POST /api/v1/agent/chats/${chatId}/events failed (403; response body omitted; content-type=text/html)`);
    }

    return super.createChatEvent(chatId, event);
  }
}

class RateLimitedRecoveredRoomRestApi extends LinearThenvoiExampleRestApi {
  private readonly failedRooms = new Set<string>();
  private readonly retriedRecoveredRooms = new Set<string>();

  public override async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const existingEventCount = this.roomEvents.filter((entry) => entry.roomId === chatId).length;
    if (existingEventCount >= 1 && !this.failedRooms.has(chatId)) {
      this.failedRooms.add(chatId);
      throw new Error(`POST /api/v1/agent/chats/${chatId}/events failed (403; response body omitted; content-type=text/html)`);
    }

    if (chatId !== "room-1" && existingEventCount === 0 && !this.retriedRecoveredRooms.has(chatId)) {
      this.retriedRecoveredRooms.add(chatId);
      throw new Error(`POST /api/v1/agent/chats/${chatId}/events failed (429; response body omitted; content-type=text/html)`);
    }

    return super.createChatEvent(chatId, event);
  }
}

class RateLimitedParticipantsRestApi extends LinearThenvoiExampleRestApi {
  public override async listChatParticipants(): Promise<Array<{
    id: string;
    name: string;
    type: string;
    handle?: string | null;
  }>> {
    throw Object.assign(new Error("429 Too Many Requests"), { retryable: true });
  }
}

class FailFirstCreateChatRestApi extends LinearThenvoiExampleRestApi {
  private failed = false;

  public override async createChat(taskId?: string): Promise<{ id: string }> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("simulated room-creation failure");
    }

    return super.createChat(taskId);
  }
}

function makeConfig(roomStrategy: "issue" | "session"): LinearThenvoiBridgeConfig {
  return {
    linearAccessToken: "lin_api_test",
    linearWebhookSecret: "linear_webhook_secret",
    hostAgentHandle: "linear-host",
    roomStrategy,
    writebackMode: "final_only",
  };
}

function makePayload(sessionId: string, issueId: string) {
  const payload: HandleAgentSessionEventInput["payload"] = {
    action: "created",
    type: "AgentSessionEvent",
    appUserId: "app-user",
    createdAt: new Date(),
    oauthClientId: "oauth-client",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    promptContext: `Please handle session ${sessionId}`,
    agentSession: {
      id: sessionId,
      issueId,
      status: "active",
      type: "issue",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      organizationId: "org-1",
      updatedAt: new Date().toISOString(),
      issue: {
        id: issueId,
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

  return payload;
}

function makeLinearClient(): HandleAgentSessionEventInput["deps"]["linearClient"] {
  return {
    createAgentActivity: async () => ({ ok: true }),
    agentSessionUpdateExternalUrl: async () => ({ success: true }),
    issue: async () => ({ id: "issue-1", delegateId: null }),
    workflowStates: async () => ({ nodes: [] }),
    updateIssue: async () => ({ success: true }),
  } as unknown as HandleAgentSessionEventInput["deps"]["linearClient"];
}

describe("linear bridge room strategy", () => {
  it("reuses one room per issue when roomStrategy=issue", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("session-1", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await handleAgentSessionEvent({
      payload: makePayload("session-2", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[0]?.roomId).toBe(restApi.roomEvents[1]?.roomId);
  });

  it("serializes concurrent issue-room resolution with a shared runtime lock", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const runtime = createLinearBridgeRuntime();

    await Promise.all([
      handleAgentSessionEvent({
        payload: makePayload("session-1", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      }, { runtime }),
      handleAgentSessionEvent({
        payload: makePayload("session-2", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      }, { runtime }),
    ]);

    expect(restApi.createChatCalls).toHaveLength(1);
    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[0]?.roomId).toBe(restApi.roomEvents[1]?.roomId);
  });

  it("releases room-resolution lock after failure so later retries can proceed", async () => {
    const restApi = new FailFirstCreateChatRestApi();
    const store = new MemorySessionRoomStore();
    const runtime = createLinearBridgeRuntime();

    await expect(
      handleAgentSessionEvent({
        payload: makePayload("session-fail", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      }, { runtime }),
    ).rejects.toThrow("simulated room-creation failure");

    await expect(
      handleAgentSessionEvent({
        payload: makePayload("session-retry", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      }, { runtime }),
    ).resolves.toBeUndefined();

    expect(restApi.createChatCalls).toHaveLength(1);
    expect(restApi.roomEvents).toHaveLength(1);
    await expect(store.getBySessionId("session-retry")).resolves.toMatchObject({
      status: "active",
    });
  });

  it("reuses the same issue room after the previous session completed", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("session-1", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await store.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      thenvoiRoomId: restApi.roomEvents[0]?.roomId ?? "room-1",
      status: "completed",
      createdAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:05:00.000Z",
    });

    await handleAgentSessionEvent({
      payload: makePayload("session-2", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[0]?.roomId).toBe(restApi.roomEvents[1]?.roomId);
    await expect(store.getBySessionId("session-2")).resolves.toMatchObject({
      thenvoiRoomId: restApi.roomEvents[0]?.roomId,
      status: "active",
    });
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linearSessionId: "session-2",
          metadata: expect.objectContaining({
            linear_reset_room_session: true,
          }),
        }),
      ]),
    );
  });

  it("creates one room per session when roomStrategy=session", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("session-1", "issue-1"),
      config: makeConfig("session"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await handleAgentSessionEvent({
      payload: makePayload("session-2", "issue-1"),
      config: makeConfig("session"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[0]?.roomId).not.toBe(restApi.roomEvents[1]?.roomId);
  });

  it("recovers by creating a fresh room when a reused issue room rejects event forwarding", async () => {
    const restApi = new FlakyRoomReuseRestApi();
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("session-1", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await handleAgentSessionEvent({
      payload: makePayload("session-2", "issue-1"),
      config: makeConfig("issue"),
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[0]?.roomId).not.toBe(restApi.roomEvents[1]?.roomId);
    await expect(store.getBySessionId("session-2")).resolves.toMatchObject({
      thenvoiRoomId: restApi.roomEvents[1]?.roomId,
      status: "active",
    });
  });

  it("retries the recreated room when the first post races room access propagation", async () => {
    const previousDelay = process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS;
    process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS = "0";
    try {
      const restApi = new FlakyRecoveredRoomRestApi();
      const store = new MemorySessionRoomStore();

      await handleAgentSessionEvent({
        payload: makePayload("session-1", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      });

      await handleAgentSessionEvent({
        payload: makePayload("session-2", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      });

      expect(restApi.roomEvents).toHaveLength(2);
      expect(restApi.roomEvents[0]?.roomId).not.toBe(restApi.roomEvents[1]?.roomId);
      await expect(store.getBySessionId("session-2")).resolves.toMatchObject({
        thenvoiRoomId: restApi.roomEvents[1]?.roomId,
        status: "active",
      });
    } finally {
      if (previousDelay === undefined) {
        delete process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS;
      } else {
        process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS = previousDelay;
      }
    }
  });

  it("retries recreated-room forwarding when the first post is rate limited", async () => {
    const previousDelay = process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS;
    process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS = "0";
    try {
      const restApi = new RateLimitedRecoveredRoomRestApi();
      const store = new MemorySessionRoomStore();

      await handleAgentSessionEvent({
        payload: makePayload("session-1", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      });

      await handleAgentSessionEvent({
        payload: makePayload("session-2", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      });

      expect(restApi.roomEvents).toHaveLength(2);
      expect(restApi.roomEvents[0]?.roomId).not.toBe(restApi.roomEvents[1]?.roomId);
      await expect(store.getBySessionId("session-2")).resolves.toMatchObject({
        thenvoiRoomId: restApi.roomEvents[1]?.roomId,
        status: "active",
      });
    } finally {
      if (previousDelay === undefined) {
        delete process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS;
      } else {
        process.env.LINEAR_THENVOI_RECOVERED_ROOM_RETRY_BASE_DELAY_MS = previousDelay;
      }
    }
  });

  it("continues bridging when participant lookups are rate limited", async () => {
    const restApi = new RateLimitedParticipantsRestApi();
    const store = new MemorySessionRoomStore();

    await expect(
      handleAgentSessionEvent({
        payload: makePayload("session-rate-limit", "issue-1"),
        config: makeConfig("issue"),
        deps: {
          thenvoiRest: restApi,
          linearClient: makeLinearClient(),
          store,
        },
      }),
    ).resolves.toBeUndefined();

    expect(restApi.roomEvents).toHaveLength(1);
    await expect(store.getBySessionId("session-rate-limit")).resolves.toMatchObject({
      status: "active",
    });
  });
});

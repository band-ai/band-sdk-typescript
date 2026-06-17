import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StaleSessionGuard,
  isSessionStale,
  sendRecoveryActivityIfStale,
  type LinearActivityClient,
  type SessionRoomRecord,
  type SessionRoomStore,
  type PendingBootstrapRequest,
  STALE_SESSION_THRESHOLD_MS,
} from "../src/linear";

function makeMockClient(): LinearActivityClient & {
  calls: Array<{ agentSessionId: string; content: Record<string, unknown> }>;
} {
  const calls: Array<{ agentSessionId: string; content: Record<string, unknown> }> = [];
  return {
    calls,
    createAgentActivity: vi.fn(async (input) => {
      calls.push(input);
      return { ok: true };
    }),
  };
}

function makeRecord(overrides?: Partial<SessionRoomRecord>): SessionRoomRecord {
  const now = new Date().toISOString();
  return {
    linearSessionId: "session-1",
    linearIssueId: "issue-1",
    thenvoiRoomId: "room-1",
    status: "active",
    lastEventKey: null,
    lastLinearActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class MemorySessionRoomStore implements SessionRoomStore {
  public readonly records = new Map<string, SessionRoomRecord>();
  public readonly bootstrapRequests = new Map<string, PendingBootstrapRequest>();

  public async getBySessionId(sessionId: string): Promise<SessionRoomRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  public async getByIssueId(issueId: string): Promise<SessionRoomRecord | null> {
    const values = [...this.records.values()]
      .filter((r) => r.linearIssueId === issueId && r.status !== "canceled")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return values[0] ?? null;
  }

  public async upsert(record: SessionRoomRecord): Promise<void> {
    this.records.set(record.linearSessionId, record);
  }

  public async markCanceled(sessionId: string): Promise<void> {
    const current = this.records.get(sessionId);
    if (current) {
      this.records.set(sessionId, { ...current, status: "canceled", updatedAt: new Date().toISOString() });
    }
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

  public async listActiveSessions(): Promise<SessionRoomRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.status === "active" || r.status === "waiting",
    );
  }
}

describe("isSessionStale", () => {
  it("returns true when session has no lastLinearActivityAt and updatedAt is old", () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    const session = makeRecord({
      lastLinearActivityAt: null,
      updatedAt: thirtyMinutesAgo,
    });

    expect(isSessionStale(session, Date.now(), STALE_SESSION_THRESHOLD_MS)).toBe(true);
  });

  it("returns false when lastLinearActivityAt is recent", () => {
    const session = makeRecord({
      lastLinearActivityAt: new Date().toISOString(),
    });

    expect(isSessionStale(session, Date.now(), STALE_SESSION_THRESHOLD_MS)).toBe(false);
  });

  it("returns true when lastLinearActivityAt exceeds threshold", () => {
    const old = new Date(Date.now() - 26 * 60_000).toISOString();
    const session = makeRecord({ lastLinearActivityAt: old });

    expect(isSessionStale(session, Date.now(), STALE_SESSION_THRESHOLD_MS)).toBe(true);
  });

  it("falls back to updatedAt when lastLinearActivityAt is null", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const session = makeRecord({
      lastLinearActivityAt: null,
      updatedAt: recent,
    });

    expect(isSessionStale(session, Date.now(), STALE_SESSION_THRESHOLD_MS)).toBe(false);
  });

  it("returns true when reference date is invalid", () => {
    const session = makeRecord({
      lastLinearActivityAt: "invalid-date",
    });

    expect(isSessionStale(session, Date.now(), STALE_SESSION_THRESHOLD_MS)).toBe(true);
  });
});

describe("sendRecoveryActivityIfStale", () => {
  it("sends a recovery activity when session is stale", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const session = makeRecord({ lastLinearActivityAt: old });
    store.records.set(session.linearSessionId, session);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const recovered = await sendRecoveryActivityIfStale({
      session,
      linearClient: client,
      store,
      logger,
    });

    expect(recovered).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-1",
      content: { type: "thought" },
    });
    // Store should be updated with new timestamp
    const updated = store.records.get("session-1");
    expect(updated?.lastLinearActivityAt).not.toBe(old);
  });

  it("does not send activity when session is fresh", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const session = makeRecord();

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const recovered = await sendRecoveryActivityIfStale({
      session,
      linearClient: client,
      store,
      logger,
    });

    expect(recovered).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it("returns false and logs warning when activity post fails", async () => {
    const client = makeMockClient();
    client.createAgentActivity = vi.fn(async () => {
      throw new Error("network error");
    });
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const session = makeRecord({ lastLinearActivityAt: old });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const recovered = await sendRecoveryActivityIfStale({
      session,
      linearClient: client,
      store,
      logger,
    });

    expect(recovered).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "stale_session_guard.recovery_activity_failed",
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });
});

describe("StaleSessionGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tick sends keepalive for stale sessions", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 26 * 60_000).toISOString();
    store.records.set("session-stale", makeRecord({
      linearSessionId: "session-stale",
      lastLinearActivityAt: old,
    }));
    store.records.set("session-fresh", makeRecord({
      linearSessionId: "session-fresh",
      lastLinearActivityAt: new Date().toISOString(),
    }));

    const guard = new StaleSessionGuard({ store, linearClient: client });
    const kept = await guard.tick();

    expect(kept).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.agentSessionId).toBe("session-stale");
  });

  it("tick skips completed/canceled sessions", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    store.records.set("session-completed", makeRecord({
      linearSessionId: "session-completed",
      status: "completed",
      lastLinearActivityAt: old,
    }));
    store.records.set("session-canceled", makeRecord({
      linearSessionId: "session-canceled",
      status: "canceled",
      lastLinearActivityAt: old,
    }));

    const guard = new StaleSessionGuard({ store, linearClient: client });
    const kept = await guard.tick();

    expect(kept).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it("tick returns 0 when store lacks listActiveSessions", async () => {
    const client = makeMockClient();
    const storeWithoutList: SessionRoomStore = {
      getBySessionId: vi.fn(async () => null),
      getByIssueId: vi.fn(async () => null),
      upsert: vi.fn(async () => {}),
      markCanceled: vi.fn(async () => {}),
      enqueueBootstrapRequest: vi.fn(async () => {}),
      listPendingBootstrapRequests: vi.fn(async () => []),
      markBootstrapRequestProcessed: vi.fn(async () => {}),
    };

    const guard = new StaleSessionGuard({ store: storeWithoutList, linearClient: client });
    const kept = await guard.tick();

    expect(kept).toBe(0);
  });

  it("start and stop manage the interval timer", () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();

    const guard = new StaleSessionGuard({
      store,
      linearClient: client,
      checkIntervalMs: 1000,
    });

    guard.start();
    // Starting again is a no-op.
    guard.start();

    guard.stop();
    // Stopping again is a no-op.
    guard.stop();
  });

  it("tick updates lastLinearActivityAt in store after keepalive", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    store.records.set("session-1", makeRecord({
      linearSessionId: "session-1",
      lastLinearActivityAt: old,
    }));

    const guard = new StaleSessionGuard({ store, linearClient: client });
    await guard.tick();

    const updated = store.records.get("session-1");
    expect(updated?.lastLinearActivityAt).not.toBe(old);
    expect(new Date(updated!.lastLinearActivityAt!).getTime()).toBeGreaterThan(
      new Date(old).getTime(),
    );
  });

  it("uses custom keepalive message", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    store.records.set("session-1", makeRecord({
      linearSessionId: "session-1",
      lastLinearActivityAt: old,
    }));

    const guard = new StaleSessionGuard({
      store,
      linearClient: client,
      keepAliveMessage: "Custom keepalive",
    });
    await guard.tick();

    expect(client.calls[0]?.content).toMatchObject({
      body: "Custom keepalive",
    });
  });
});

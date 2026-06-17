import { describe, expect, it, vi } from "vitest";

import {
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
      lastEventKey: current.lastEventKey ?? null,
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

class PromptedConfiguredHostRestApi extends LinearThenvoiExampleRestApi {
  public override async getAgentMe(): Promise<never> {
    throw new Error("getAgentMe should not be called when hostAgentHandle is configured");
  }
}

const config: LinearThenvoiBridgeConfig = {
  linearAccessToken: "lin_api_test",
  linearWebhookSecret: "linear_webhook_secret",
  hostAgentHandle: "linear-host",
  roomStrategy: "issue",
  writebackMode: "final_only",
};

function makePayload(action: "created" | "updated" | "canceled") {
  const issue = {
    id: "issue-1",
    title: "Investigate bug",
    description: "We need a concrete plan before implementation.",
    identifier: "INT-1",
    state: {
      id: "state-1",
      name: "In Progress",
      type: "started",
    },
    assignee: {
      id: "agent-1",
      name: "Thenvoi",
      displayName: "Thenvoi",
    },
    team: {
      id: "team-1",
      key: "INT",
      name: "Integrations",
    },
    teamId: "team-1",
    url: "https://linear.app/example/issue/INT-1",
  } as unknown as HandleAgentSessionEventInput["payload"]["agentSession"]["issue"];

  const payload: HandleAgentSessionEventInput["payload"] = {
    action,
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
      status: action === "canceled" ? "canceled" : "active",
      type: "issue",
      appUserId: "app-user",
      createdAt: new Date().toISOString(),
      organizationId: "org-1",
      updatedAt: new Date().toISOString(),
      issue,
      comment: {
        id: "comment-1",
        body: "Need a clear summary",
      },
    },
  };

  return payload;
}

function makeLinearClient(options?: { delegateId?: string | null }): HandleAgentSessionEventInput["deps"]["linearClient"] & {
  createAgentActivity: ReturnType<typeof vi.fn>;
  agentSessionUpdateExternalUrl: ReturnType<typeof vi.fn>;
  issue: ReturnType<typeof vi.fn>;
  workflowStates: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
} {
  return {
    createAgentActivity: vi.fn(async () => ({ ok: true })),
    agentSessionUpdateExternalUrl: vi.fn(async () => ({ success: true })),
    issue: vi.fn(async () => ({
      id: "issue-1",
      delegateId: options?.delegateId ?? null,
    })),
    workflowStates: vi.fn(async () => ({
      nodes: [
        { id: "state-started-1", name: "In Progress", type: "started", position: 1 },
        { id: "state-started-2", name: "In Review", type: "started", position: 2 },
      ],
    })),
    updateIssue: vi.fn(async () => ({ success: true })),
  } as unknown as HandleAgentSessionEventInput["deps"]["linearClient"] & {
    createAgentActivity: ReturnType<typeof vi.fn>;
    agentSessionUpdateExternalUrl: ReturnType<typeof vi.fn>;
    issue: ReturnType<typeof vi.fn>;
    workflowStates: ReturnType<typeof vi.fn>;
    updateIssue: ReturnType<typeof vi.fn>;
  };
}

describe("linear bridge webhook actions", () => {
  it("forwards created/updated events to Thenvoi room messages", async () => {
    const restApi = new LinearThenvoiExampleRestApi({
      agentId: "peer-transport",
      agentName: "Transport Agent",
      agentHandle: "transport-agent",
      peers: [
        { id: "peer-transport", name: "Transport Agent", handle: "transport-agent" },
        { id: "peer-host", name: "Linear Bridge", handle: "linear-host" },
        { id: "peer-research", name: "research-agent", handle: "research-agent" },
      ],
    });
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await handleAgentSessionEvent({
      payload: makePayload("updated"),
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.createChatCalls).toEqual([undefined]);
    expect(restApi.roomEvents[0]?.metadata).toMatchObject({
      linear_event_action: "created",
      linear_session_id: "session-1",
      linear_issue_id: "issue-1",
      linear_host_handle: "linear-host",
    });
    expect(restApi.roomEvents[1]?.metadata).toMatchObject({
      linear_event_action: "updated",
      linear_session_id: "session-1",
      linear_issue_id: "issue-1",
    });
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([
      expect.objectContaining({ messageType: "task" }),
      expect.objectContaining({ messageType: "task" }),
    ]);
    await expect(store.getBySessionId("session-1")).resolves.toMatchObject({
      status: "active",
      lastEventKey: expect.any(String),
    });
  });

  it("surfaces a relevant implementation specialist as a bridge hint without adding them to the room", async () => {
    const restApi = new LinearThenvoiExampleRestApi({
      agentId: "peer-host",
      agentName: "Linear Bridge",
      agentHandle: "linear-host",
      peers: [
        { id: "peer-host", name: "Linear Bridge", handle: "linear-host" },
        { id: "peer-planner", name: "Ticket Planner", handle: "ticket-planner" },
        { id: "peer-implementer", name: "Feature Implementer", handle: "feature-implementer" },
      ],
    });
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    const roomId = restApi.roomEvents[0]?.roomId;
    expect(roomId).toBeTruthy();
    await expect(restApi.listChatParticipants(roomId ?? "missing-room")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "linear-host" }),
      ]),
    );
    await expect(restApi.listChatParticipants(roomId ?? "missing-room")).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "feature-implementer" }),
      ]),
    );
    expect(restApi.roomMessages).toEqual([]);
    expect(restApi.roomEvents[0]?.content).toContain(
      "Suggested peers available in the registry right now. They are not in the room yet:",
    );
    expect(restApi.roomEvents[0]?.content).toContain("feature-implementer");
    expect(restApi.roomEvents[0]?.content).toContain(
      "include the relevant ticket context in the room message",
    );
  });

  it("prefetches planner and reviewer specialists for planning sessions", async () => {
    const restApi = new LinearThenvoiExampleRestApi({
      agentId: "peer-host",
      agentName: "Linear Bridge",
      agentHandle: "linear-host",
      peers: [
        { id: "peer-host", name: "Linear Bridge", handle: "linear-host" },
        { id: "peer-planner", name: "Claude Code Planner", handle: "claude-planner" },
        { id: "peer-reviewer", name: "Codex Reviewer", handle: "codex-reviewer" },
        { id: "peer-implementer", name: "Feature Implementer", handle: "feature-implementer" },
      ],
    });
    const store = new MemorySessionRoomStore();
    const payload = makePayload("created");
    payload.promptContext = "We want a landing page for the dog website.";
    const issue = payload.agentSession.issue as (
      HandleAgentSessionEventInput["payload"]["agentSession"]["issue"] & {
        state?: { name?: string; type?: string };
      }
    ) | undefined;
    if (issue) {
      issue.state = {
        ...(issue.state ?? {}),
        name: "Backlog",
        type: "unstarted",
      };
    }

    await handleAgentSessionEvent({
      payload,
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    const roomId = restApi.roomEvents[0]?.roomId;
    expect(roomId).toBeTruthy();
    await expect(restApi.listChatParticipants(roomId ?? "missing-room")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "linear-host" }),
      ]),
    );
    await expect(restApi.listChatParticipants(roomId ?? "missing-room")).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: "claude-planner" }),
        expect.objectContaining({ handle: "codex-reviewer" }),
        expect.objectContaining({ handle: "feature-implementer" }),
      ]),
    );
    expect(restApi.roomMessages).toEqual([]);
    expect(restApi.roomEvents[0]?.content).toContain(
      "Suggested peers available in the registry right now. They are not in the room yet:",
    );
    expect(restApi.roomEvents[0]?.content).toContain("claude-planner");
    expect(restApi.roomEvents[0]?.content).toContain("codex-reviewer");
  });

  it("marks session canceled and emits a cancellation event", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    await handleAgentSessionEvent({
      payload: makePayload("canceled"),
      config,
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[1]?.metadata).toMatchObject({
      linear_event_action: "canceled",
      linear_session_id: "session-1",
      linear_issue_id: "issue-1",
    });

    await expect(store.getBySessionId("session-1")).resolves.toMatchObject({
      status: "canceled",
      lastEventKey: expect.any(String),
    });
  });

  it("sends acknowledgment thought on created events only", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    // Acknowledgment should be the first call to createAgentActivity
    expect(linearClient.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        content: expect.objectContaining({
          type: "thought",
          body: "Received session. Setting up workspace...",
        }),
      }),
    );
  });

  it("does not send acknowledgment on updated events", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    // First create so the room exists.
    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    const updatedClient = makeLinearClient();
    await handleAgentSessionEvent({
      payload: makePayload("updated"),
      config,
      deps: { thenvoiRest: restApi, linearClient: updatedClient, store },
    });

    // Updated event should not trigger any createAgentActivity calls
    expect(updatedClient.createAgentActivity).not.toHaveBeenCalled();
  });

  it("reports errors back to Linear and re-throws", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    // Make createChat throw to simulate a failure after acknowledgment.
    const originalCreateChat = restApi.createChat.bind(restApi);
    restApi.createChat = async () => {
      throw new Error("Room creation failed");
    };

    await expect(
      handleAgentSessionEvent({
        payload: makePayload("created"),
        config,
        deps: { thenvoiRest: restApi, linearClient, store },
      }),
    ).rejects.toThrow("Room creation failed");

    // Should have called createAgentActivity twice: acknowledgment + error report
    expect(linearClient.createAgentActivity).toHaveBeenCalledTimes(2);
    expect(linearClient.createAgentActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        content: expect.objectContaining({
          type: "error",
          body: expect.stringContaining("Room creation failed"),
        }),
      }),
    );

    // Restore for other tests
    restApi.createChat = originalCreateChat;
  });

  it("forwards prompted action as user response to room", async () => {
    const restApi = new PromptedConfiguredHostRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    // First create a session so the room exists.
    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    const promptedPayload = {
      ...makePayload("created"),
      action: "prompted",
      agentActivity: {
        content: {
          body: "Yes, please proceed with option A",
        },
      },
    } as unknown as HandleAgentSessionEventInput["payload"];

    await handleAgentSessionEvent({
      payload: promptedPayload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[1]?.messageType).toBe("text");
    expect(restApi.roomEvents[1]?.metadata).toMatchObject({
      linear_event_action: "prompted",
      linear_session_id: "session-1",
    });
    expect(restApi.roomEvents[1]?.content).toContain("Yes, please proceed with option A");
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([
      expect.objectContaining({ messageType: "task" }),
      expect.objectContaining({ messageType: "text" }),
    ]);
    await expect(store.getBySessionId("session-1")).resolves.toMatchObject({
      status: "waiting",
      lastEventKey: expect.any(String),
    });
  });

  it("skips duplicate deliveries for the same event key", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(restApi.roomEvents).toHaveLength(1);
    expect(linearClient.createAgentActivity).toHaveBeenCalledTimes(1);
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([
      expect.objectContaining({ messageType: "task" }),
    ]);
  });

  it("treats duplicate prompted events as idempotent and does not re-forward room content", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    const promptedPayload = {
      ...makePayload("created"),
      action: "prompted",
      agentActivity: {
        content: {
          body: "Please continue with implementation.",
        },
      },
    } as unknown as HandleAgentSessionEventInput["payload"];

    await handleAgentSessionEvent({
      payload: promptedPayload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });
    await handleAgentSessionEvent({
      payload: promptedPayload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(restApi.roomEvents).toHaveLength(2);
    expect(restApi.roomEvents[1]?.content).toContain("Please continue with implementation.");
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([
      expect.objectContaining({ messageType: "task" }),
      expect.objectContaining({ messageType: "text" }),
    ]);
  });

  it("uses configured host handle when provided", async () => {
    const restApi = new LinearThenvoiExampleRestApi({
      agentId: "peer-actual-host",
      agentName: "Actual Host",
      agentHandle: "actual-host",
      peers: [
        { id: "peer-actual-host", name: "Actual Host", handle: "actual-host" },
        { id: "peer-config-host", name: "Configured Host", handle: "linear-host" },
        { id: "peer-research", name: "research-agent", handle: "research-agent" },
      ],
    });
    const store = new MemorySessionRoomStore();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config: {
        ...config,
        hostAgentHandle: "linear-host",
      },
      deps: {
        thenvoiRest: restApi,
        linearClient: makeLinearClient(),
        store,
      },
    });

    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.metadata).toMatchObject({
      linear_host_handle: "linear-host",
      linear_event_action: "created",
    });
    await expect(store.listPendingBootstrapRequests()).resolves.toEqual([
      expect.objectContaining({ messageType: "task" }),
    ]);
  });

  it("sets external URL on Linear session on created event", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.agentSessionUpdateExternalUrl).toHaveBeenCalledWith(
      "session-1",
      {
        externalUrls: [{ label: "View in Thenvoi", url: expect.stringMatching(/^https:\/\/app\.thenvoi\.com\/rooms\//) }],
      },
    );
  });

  it("uses custom thenvoiAppBaseUrl for external URL", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config: { ...config, thenvoiAppBaseUrl: "https://custom.example.com" },
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.agentSessionUpdateExternalUrl).toHaveBeenCalledWith(
      "session-1",
      {
        externalUrls: [{ label: "View in Thenvoi", url: expect.stringContaining("https://custom.example.com/rooms/") }],
      },
    );
  });

  it("skips delegate when appUserId is absent", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    (payload as Record<string, unknown>).appUserId = undefined;

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.issue).not.toHaveBeenCalled();
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    // Should still forward the message successfully.
    expect(restApi.roomEvents).toHaveLength(1);
  });

  it("sets agent as delegate on created event when no delegate exists", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient({ delegateId: null });
    // First call: check existing delegate (none). Second call: re-fetch after setting delegate.
    linearClient.issue
      .mockReset()
      .mockResolvedValueOnce({ id: "issue-1", delegateId: null })
      .mockResolvedValueOnce({
        id: "issue-1",
        delegateId: "app-user",
        delegate: { id: "app-user", name: "Thenvoi Agent", displayName: "Thenvoi Agent" },
      });

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.issue).toHaveBeenCalledWith("issue-1");
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-1", {
      delegateId: "app-user",
    });
    // Bridge message should reflect the newly-set delegate with a human-readable name.
    expect(restApi.roomEvents[0]?.content).toContain("issue_delegate_id: app-user");
    expect(restApi.roomEvents[0]?.content).toContain("issue_delegate: Thenvoi Agent");
  });

  it("does not overwrite existing delegate on created event", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient({ delegateId: "existing-delegate" });

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.issue).toHaveBeenCalledWith("issue-1");
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
  });

  it("does not set external URL on updated events", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    // First create to set up the room.
    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    const updatedClient = makeLinearClient();
    await handleAgentSessionEvent({
      payload: makePayload("updated"),
      config,
      deps: { thenvoiRest: restApi, linearClient: updatedClient, store },
    });

    expect(updatedClient.agentSessionUpdateExternalUrl).not.toHaveBeenCalled();
    // The updated client should not have fetched the issue for delegate check.
    expect(updatedClient.issue).not.toHaveBeenCalled();
    expect(updatedClient.updateIssue).not.toHaveBeenCalled();
  });

  it("continues normally when setting external URL fails", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.agentSessionUpdateExternalUrl.mockRejectedValueOnce(new Error("API error"));

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    // Should still forward the message successfully despite external URL failure.
    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.metadata).toMatchObject({
      linear_event_action: "created",
      linear_session_id: "session-1",
    });
  });

  it("continues normally when auto-delegate fails", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.issue.mockRejectedValueOnce(new Error("API rate limit"));

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    // Should still forward the message successfully despite delegate failure.
    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.metadata).toMatchObject({
      linear_event_action: "created",
      linear_session_id: "session-1",
    });
  });

  it("skips external URL when agentSessionUpdateExternalUrl is unavailable", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    delete (linearClient as Partial<typeof linearClient>).agentSessionUpdateExternalUrl;

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    // Should still forward the message successfully.
    expect(restApi.roomEvents).toHaveLength(1);
  });

  it("moves issue to started state on created event when state is unstarted", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-backlog", name: "Backlog", type: "unstarted" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          team: { id: { eq: "team-1" } },
          type: { eq: "started" },
        }),
      }),
    );
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-started-1",
    });
    // Bridge message should reflect the new state.
    expect(restApi.roomEvents[0]?.content).toContain("issue_state: In Progress");
    expect(restApi.roomEvents[0]?.content).toContain("issue_state_id: state-started-1");
    expect(restApi.roomEvents[0]?.content).toContain("issue_state_type: started");
  });

  it("moves issue to started state on created event when state is backlog", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Backlog", type: "backlog" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).toHaveBeenCalled();
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-started-1",
    });
  });

  it("moves issue to started state on created event when state is triage", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-tr", name: "Triage", type: "triage" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).toHaveBeenCalled();
    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-started-1",
    });
  });

  it("does not move issue when already in started state", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).not.toHaveBeenCalled();
  });

  it("does not move issue when in completed state", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-done", name: "Done", type: "completed" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).not.toHaveBeenCalled();
  });

  it("does not move issue when in canceled state", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-cancel", name: "Canceled", type: "canceled" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).not.toHaveBeenCalled();
  });

  it("does not attempt auto-start on updated events", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();

    await handleAgentSessionEvent({
      payload: makePayload("created"),
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    const updatedClient = makeLinearClient();
    const updatedPayload = makePayload("updated");
    const issue = updatedPayload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-backlog", name: "Backlog", type: "unstarted" };

    await handleAgentSessionEvent({
      payload: updatedPayload,
      config,
      deps: { thenvoiRest: restApi, linearClient: updatedClient, store },
    });

    expect(updatedClient.workflowStates).not.toHaveBeenCalled();
  });

  it("continues normally when auto-start fails", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.workflowStates.mockRejectedValueOnce(new Error("API rate limit"));
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Backlog", type: "backlog" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.metadata).toMatchObject({
      linear_event_action: "created",
      linear_session_id: "session-1",
    });
  });

  it("moves issue to lowest-position started state when multiple exist", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.workflowStates.mockResolvedValueOnce({
      nodes: [
        { id: "state-review", name: "In Review", type: "started", position: 5 },
        { id: "state-in-progress", name: "In Progress", type: "started", position: 1 },
        { id: "state-qa", name: "QA", type: "started", position: 3 },
      ],
    });
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Todo", type: "unstarted" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-in-progress",
    });
    expect(restApi.roomEvents[0]?.content).toContain("issue_state: In Progress");
  });

  it("skips auto-start when no started workflow states exist for the team", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.workflowStates.mockResolvedValueOnce({ nodes: [] });
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Backlog", type: "backlog" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).toHaveBeenCalled();
    // updateIssue may be called by auto-delegate, but should not be called with stateId.
    expect(linearClient.updateIssue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stateId: expect.anything() }),
    );
    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.content).toContain("issue_state: Backlog");
  });

  it("handles malformed workflowStates response with missing nodes gracefully", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    linearClient.workflowStates.mockResolvedValueOnce({ nodes: undefined });
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Backlog", type: "backlog" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).toHaveBeenCalled();
    // updateIssue may be called by auto-delegate, but should not be called with stateId.
    expect(linearClient.updateIssue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stateId: expect.anything() }),
    );
    expect(restApi.roomEvents).toHaveLength(1);
    expect(restApi.roomEvents[0]?.content).toContain("issue_state: Backlog");
  });

  it("preserves original intent after auto-start moves issue to started", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-bl", name: "Backlog", type: "unstarted" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(restApi.roomEvents[0]?.content).toContain("issue_state_type: started");
    expect(restApi.roomEvents[0]?.content).toContain("inferred_session_intent: planning");
  });

  it("skips auto-start when issue state type is missing from payload", async () => {
    const restApi = new LinearThenvoiExampleRestApi();
    const store = new MemorySessionRoomStore();
    const linearClient = makeLinearClient();
    const payload = makePayload("created");
    const issue = payload.agentSession.issue as Record<string, unknown>;
    issue.state = { id: "state-unknown", name: "Unknown" };

    await handleAgentSessionEvent({
      payload,
      config,
      deps: { thenvoiRest: restApi, linearClient, store },
    });

    expect(linearClient.workflowStates).not.toHaveBeenCalled();
    expect(restApi.roomEvents).toHaveLength(1);
  });
});

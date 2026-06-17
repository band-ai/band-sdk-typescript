import { describe, expect, it, vi } from "vitest";

import {
  createLinearTools,
  type LinearActivityClient,
  type PendingBootstrapRequest,
  type SessionRoomRecord,
  type SessionRoomStore,
} from "../src/linear";
import { customToolToOpenAISchema, executeCustomTool } from "../src/runtime/tools/customTools";

const TEST_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEST_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_COMMENT_ID = "33333333-3333-4333-8333-333333333333";
const TEST_TEAM_ID = "44444444-4444-4444-8444-444444444444";
const TEST_STATE_ID = "55555555-5555-4555-8555-555555555555";
const TEST_LABEL_ID_1 = "66666666-6666-4666-8666-666666666666";
const TEST_LABEL_ID_2 = "77777777-7777-4777-8777-777777777777";

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

function makeMockClientWithSessionCreation(): LinearActivityClient {
  return {
    ...makeMockClient(),
    agentSessionCreateOnIssue: vi.fn(async ({ issueId }: { issueId: string; externalLink?: string }) => ({
      agentSession: {
        id: "new-session-1",
        issueId,
        status: "active",
      },
      success: true,
    })),
    agentSessionCreateOnComment: vi.fn(async () => ({
      agentSession: {
        id: "new-session-2",
        issueId: null,
        status: "active",
      },
      success: true,
    })),
    createIssue: vi.fn(async () => ({
      issue: {
        id: "new-issue-1",
        identifier: "SOF-42",
        url: "https://linear.app/example/issue/SOF-42",
        title: "New issue from Thenvoi",
      },
      success: true,
    })),
  };
}

function makeMockClient(options?: { withRepoSuggestions?: boolean }): LinearActivityClient {
  return {
    createAgentActivity: vi.fn(async () => ({ ok: true })),
    updateAgentSession: vi.fn(async () => ({ success: true })),
    updateIssue: vi.fn(async () => ({ ok: true })),
    createComment: vi.fn(async () => ({ ok: true })),
    workflowStates: vi.fn(async ({ teamId }: { teamId?: string } = {}) => ({
      nodes: [
        { id: "state-0", name: "Todo", type: "unstarted", position: 0, teamId: teamId ?? "team-1" },
        { id: "state-1", name: "In Progress", type: "started", position: 1, teamId: teamId ?? "team-1" },
        { id: "state-2", name: "In Review", type: "started", position: 2, teamId: teamId ?? "team-1" },
        { id: "state-3", name: "Done", type: "completed", position: 3, teamId: teamId ?? "team-1" },
      ],
    })),
    issue: vi.fn(async (issueId: string) => ({
      id: issueId,
      identifier: "SOF-1",
      title: "Example issue",
      description: "Example description",
      url: "https://linear.app/example/issue/SOF-1",
      priority: 2,
      estimate: 3,
      dueDate: "2026-03-08",
      createdAt: "2026-03-06T00:00:00.000Z",
      updatedAt: "2026-03-06T01:00:00.000Z",
      state: { id: "state-1", name: "In Progress", type: "started" },
      assignee: { id: "user-1", name: "Darvell" },
      delegate: { id: "agent-1", name: "Thenvoi Agent", displayName: "Thenvoi Agent" },
      delegateId: "agent-1",
      team: { id: "team-1", key: "SOF", name: "SoftwareFactory" },
      comments: vi.fn(async () => ({
        nodes: [
          {
            id: "comment-1",
            body: "Implemented and verified.",
            createdAt: "2026-03-06T01:05:00.000Z",
            updatedAt: "2026-03-06T01:05:00.000Z",
            user: { id: "user-1", name: "Darvell" },
          },
        ],
      })),
    })),
    ...(options?.withRepoSuggestions
      ? {
        issueRepositorySuggestions: vi.fn(async () => ({
          suggestions: [
            { repositoryFullName: "org/frontend-app", hostname: "github.com", confidence: 0.92 },
            { repositoryFullName: "org/backend-api", hostname: "github.com", confidence: 0.45 },
          ],
        })),
      }
      : {}),
  };
}

describe("createLinearTools", () => {
  it("returns the canonical v1 linear tool contract", () => {
    const tools = createLinearTools({ client: makeMockClient() });
    expect(tools).toHaveLength(13);

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "linear_add_issue_comment",
      "linear_ask_user",
      "linear_get_issue",
      "linear_list_issue_comments",
      "linear_list_workflow_states",
      "linear_post_action",
      "linear_post_error",
      "linear_post_response",
      "linear_post_thought",
      "linear_request_auth",
      "linear_select",
      "linear_update_issue",
      "linear_update_plan",
    ]);
  });

  it("includes session creation tools when client supports them", () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    expect(tools).toHaveLength(16);

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toContain("linear_create_session_on_issue");
    expect(names).toContain("linear_create_session_on_comment");
    expect(names).toContain("linear_create_issue");
  });

  it("omits session creation tools when client lacks methods", () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("linear_create_session_on_issue");
    expect(names).not.toContain("linear_create_session_on_comment");
    expect(names).not.toContain("linear_create_issue");
  });

  it("each tool has a description", () => {
    const tools = createLinearTools({ client: makeMockClient() });
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it("linear_post_thought validates and calls the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_thought")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Analyzing the issue",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "thought", body: "Analyzing the issue" },
    });
  });

  it("linear_post_action validates and calls the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_action")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Searching codebase",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "action", action: "Searching codebase", parameter: "" },
    });
  });

  it("linear_post_thought passes ephemeral flag to the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_thought")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Thinking...",
      ephemeral: true,
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "thought", body: "Thinking..." },
      ephemeral: true,
    });
  });

  it("linear_post_action passes ephemeral flag to the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_action")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Searching...",
      ephemeral: true,
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "action", action: "Searching...", parameter: "" },
      ephemeral: true,
    });
  });

  it("linear_post_error does not forward ephemeral flag to the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_error")!;

    await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Something broke",
      ephemeral: true,
    });

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "error", body: "Something broke" },
    });
  });

  it("linear_ask_user validates and calls the activity layer", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_ask_user")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Which approach do you prefer?",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "elicitation", body: "Which approach do you prefer?" },
    });
  });

  it("linear_select posts an elicitation with select signal and options", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_select")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Which repository should I work in?",
      options: [
        { label: "org/frontend-app", value: "org/frontend-app" },
        { label: "org/backend-api", value: "org/backend-api" },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: {
        type: "elicitation",
        body: "Which repository should I work in?",
        signal: "select",
        signalMetadata: {
          options: [
            { label: "org/frontend-app", value: "org/frontend-app" },
            { label: "org/backend-api", value: "org/backend-api" },
          ],
        },
      },
    });
  });

  it("linear_ask_user sends select signal when options are provided", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_ask_user")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Which repository?",
      options: [
        { label: "Repo A", value: "repo-a" },
        { label: "Repo B", value: "repo-b" },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: {
        type: "elicitation",
        body: "Which repository?",
        signal: "select",
        signalMetadata: {
          options: [
            { label: "Repo A", value: "repo-a" },
            { label: "Repo B", value: "repo-b" },
          ],
        },
      },
    });
  });

  it("linear_select is excluded when elicitation is disabled", () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client, enableElicitation: false });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("linear_select");
    expect(names).not.toContain("linear_ask_user");
  });

  it("linear_select rejects empty options array", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_select")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Pick one",
        options: [],
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_ask_user falls back to plain elicitation when options is omitted", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_ask_user")!;

    await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "What do you think?",
    });

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "elicitation", body: "What do you think?" },
    });
  });

  it("linear_request_auth sends auth signal with url and provider", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Please link your GitHub account to continue.",
      url: "https://github.com/login/oauth/authorize?client_id=abc",
      provider: "GitHub",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: {
        type: "elicitation",
        body: "Please link your GitHub account to continue.",
        signal: "auth",
        signalMetadata: {
          url: "https://github.com/login/oauth/authorize?client_id=abc",
          provider: "GitHub",
        },
      },
    });
  });

  it("linear_request_auth omits provider when not specified", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Please authenticate.",
      url: "https://example.com/auth",
    });

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: {
        type: "elicitation",
        body: "Please authenticate.",
        signal: "auth",
        signalMetadata: { url: "https://example.com/auth" },
      },
    });
  });

  it("linear_request_auth rejects invalid url", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Please authenticate.",
        url: "not-a-url",
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_request_auth rejects non-https url for remote hosts", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Please authenticate.",
        url: "ftp://example.com/auth",
      }),
    ).rejects.toThrow("Invalid arguments");

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Please authenticate.",
        url: "http://example.com/auth",
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_request_auth allows http for localhost", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Please authenticate locally.",
      url: "http://localhost:3000/auth/callback",
    });

    expect(result).toEqual({ ok: true });
  });

  it("linear_request_auth allows http for IPv6 localhost", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Please authenticate locally.",
      url: "http://[::1]:3000/auth/callback",
    });

    expect(result).toEqual({ ok: true });
  });

  it("linear_request_auth rejects overly long provider name", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Please authenticate.",
        url: "https://example.com/auth",
        provider: "A".repeat(101),
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_ask_user rejects options with fewer than 2 items", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_ask_user")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Pick one",
        options: [{ label: "Only", value: "only" }],
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_request_auth rejects empty provider string", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_request_auth")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        body: "Please authenticate.",
        url: "https://example.com/auth",
        provider: "",
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_request_auth and linear_ask_user are excluded when enableElicitation is false", () => {
    const tools = createLinearTools({ client: makeMockClient(), enableElicitation: false });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("linear_ask_user");
    expect(names).not.toContain("linear_request_auth");
  });

  it("linear_post_response posts the final response and marks the session completed", async () => {
    const client = makeMockClient();
    const store = new MemorySessionRoomStore();
    await store.upsert({
      linearSessionId: "sess-1",
      linearIssueId: "issue-1",
      thenvoiRoomId: "room-1",
      status: "active",
      lastEventKey: "event-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tools = createLinearTools({ client, store });
    const tool = tools.find((entry) => entry.name === "linear_post_response")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Final answer",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "response", body: "Final answer" },
    });
    await expect(store.getBySessionId("sess-1")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("linear_post_response does not accept ephemeral flag (schema rejects it)", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_post_response")!;

    // linear_post_response uses sessionBodySchema (no ephemeral field).
    // Even if ephemeral is passed, it should be stripped by Zod and not forwarded.
    await executeCustomTool(tool, {
      session_id: "sess-1",
      body: "Final answer",
    });

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "sess-1",
      content: { type: "response", body: "Final answer" },
    });
  });

  it("linear_update_plan validates steps and calls updateAgentSession with structured plan", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_update_plan")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      steps: [
        { title: "Step 1", status: "completed" },
        { title: "Step 2", status: "in_progress" },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(client.createAgentActivity).not.toHaveBeenCalled();
    expect(client.updateAgentSession).toHaveBeenCalledWith("sess-1", {
      plan: {
        steps: [
          { content: "Step 1", status: "completed" },
          { content: "Step 2", status: "inProgress" },
        ],
      },
    });
  });

  it("rejects invalid input with Zod validation error", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_post_thought")!;

    await expect(
      executeCustomTool(tool, { session_id: 123 as unknown as string }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("rejects invalid plan step status", async () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_update_plan")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        steps: [{ title: "Step 1", status: "invalid_status" }],
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_update_issue updates issue fields through the Linear client", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_update_issue")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      title: "Updated title",
      priority: 2,
      assignee_id: null,
    });

    expect(result).toEqual({ ok: true });
    expect(client.updateIssue).toHaveBeenCalledWith(
      TEST_ISSUE_ID,
      expect.objectContaining({
        title: "Updated title",
        priority: 2,
        assigneeId: null,
      }),
    );
  });

  it("linear_get_issue returns normalized issue details", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_get_issue")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
    });

    expect(result).toEqual({
      issue: expect.objectContaining({
        id: TEST_ISSUE_ID,
        identifier: "SOF-1",
        title: "Example issue",
        team: expect.objectContaining({ key: "SOF" }),
        delegate: expect.objectContaining({ id: "agent-1", name: "Thenvoi Agent" }),
        delegate_id: "agent-1",
      }),
    });
    expect(client.issue).toHaveBeenCalledWith(TEST_ISSUE_ID);
  });

  it("issue tools expose issue_id as the canonical input key", () => {
    const tools = createLinearTools({ client: makeMockClient() });
    const tool = tools.find((entry) => entry.name === "linear_get_issue")!;
    const schema = customToolToOpenAISchema(tool) as {
      function?: {
        parameters?: {
          properties?: Record<string, unknown>;
        };
      };
    };
    const properties = schema.function?.parameters?.properties ?? {};

    expect(properties).toHaveProperty("issue_id");
    expect(properties).not.toHaveProperty("issueId");
    expect(properties).not.toHaveProperty("id");
  });

  it("rejects non-canonical issue id aliases", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_get_issue")!;

    await expect(executeCustomTool(tool, {
      issueId: TEST_ISSUE_ID,
    })).rejects.toThrow("requires issue_id");
    await expect(executeCustomTool(tool, {
      id: OTHER_TEST_ISSUE_ID,
    })).rejects.toThrow("requires issue_id");
    expect(client.issue).not.toHaveBeenCalled();
  });

  it("uses canonical issue_id even when unknown extra fields are present", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_get_issue")!;

    await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      issueId: OTHER_TEST_ISSUE_ID,
      id: OTHER_TEST_ISSUE_ID,
    });

    expect(client.issue).toHaveBeenCalledWith(TEST_ISSUE_ID);
  });

  it("linear_list_issue_comments returns recent comments", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_list_issue_comments")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      limit: 10,
    });

    expect(result).toEqual({
      comments: [
        expect.objectContaining({
          id: "comment-1",
          body: "Implemented and verified.",
        }),
      ],
    });
    expect(client.issue).toHaveBeenCalledWith(TEST_ISSUE_ID);
  });

  it("linear_list_workflow_states returns normalized states for the issue team", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_list_workflow_states")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
    });

    expect(result).toEqual({
      team_id: "team-1",
      states: [
        expect.objectContaining({ id: "state-0", name: "Todo", type: "unstarted", team_id: "team-1" }),
        expect.objectContaining({ id: "state-1", name: "In Progress", type: "started", team_id: "team-1" }),
        expect.objectContaining({ id: "state-2", name: "In Review", type: "started", team_id: "team-1" }),
        expect.objectContaining({ id: "state-3", name: "Done", type: "completed", team_id: "team-1" }),
      ],
    });
    expect(client.issue).toHaveBeenCalledWith(TEST_ISSUE_ID);
    expect(client.workflowStates).toHaveBeenCalledWith({ teamId: "team-1" });
  });

  it("linear_add_issue_comment posts a comment through the Linear client", async () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_add_issue_comment")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      body: "Implemented and verified.",
    });

    expect(result).toEqual({ ok: true });
    expect(client.createComment).toHaveBeenCalledWith({
      issueId: TEST_ISSUE_ID,
      body: "Implemented and verified.",
    });
  });

  it("linear_create_session_on_issue creates a session and returns session info", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
    });

    expect(result).toEqual({
      ok: true,
      session: {
        id: "new-session-1",
        issueId: TEST_ISSUE_ID,
        status: "active",
      },
    });
    expect(client.agentSessionCreateOnIssue).toHaveBeenCalledWith({
      issueId: TEST_ISSUE_ID,
    });
  });

  it("linear_create_session_on_issue passes external_link when provided", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      external_link: "https://example.com/session",
    });

    expect(client.agentSessionCreateOnIssue).toHaveBeenCalledWith({
      issueId: TEST_ISSUE_ID,
      externalLink: "https://example.com/session",
    });
  });

  it("linear_create_session_on_comment creates a session on a comment thread", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_comment")!;

    const result = await executeCustomTool(tool, {
      comment_id: TEST_COMMENT_ID,
    });

    expect(result).toEqual({
      ok: true,
      session: {
        id: "new-session-2",
        issueId: null,
        status: "active",
      },
    });
    expect(client.agentSessionCreateOnComment).toHaveBeenCalledWith({
      commentId: TEST_COMMENT_ID,
    });
  });

  it("linear_create_session_on_comment rejects non-UUID comment_id", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_comment")!;

    await expect(
      executeCustomTool(tool, { comment_id: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("linear_create_issue creates a new issue via the Linear client", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_issue")!;

    const result = await executeCustomTool(tool, {
      team_id: TEST_TEAM_ID,
      title: "New issue from Thenvoi",
      description: "Created during collaboration",
      priority: 2,
    });

    expect(result).toEqual({
      ok: true,
      issue: {
        id: "new-issue-1",
        identifier: "SOF-42",
        url: "https://linear.app/example/issue/SOF-42",
        title: "New issue from Thenvoi",
      },
    });
    expect(client.createIssue).toHaveBeenCalledWith({
      teamId: TEST_TEAM_ID,
      title: "New issue from Thenvoi",
      description: "Created during collaboration",
      priority: 2,
    });
  });

  it("linear_create_issue passes label_ids and state_id", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_issue")!;

    await executeCustomTool(tool, {
      team_id: TEST_TEAM_ID,
      title: "Bug report",
      state_id: TEST_STATE_ID,
      label_ids: [TEST_LABEL_ID_1, TEST_LABEL_ID_2],
    });

    expect(client.createIssue).toHaveBeenCalledWith({
      teamId: TEST_TEAM_ID,
      title: "Bug report",
      stateId: TEST_STATE_ID,
      labelIds: [TEST_LABEL_ID_1, TEST_LABEL_ID_2],
    });
  });

  it("linear_create_session_on_issue persists session-room mapping when store and room_id are provided", async () => {
    const client = makeMockClientWithSessionCreation();
    const store = new MemorySessionRoomStore();
    const tools = createLinearTools({ client, store });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      room_id: "room-abc",
    });

    const record = await store.getBySessionId("new-session-1");
    expect(record).not.toBeNull();
    expect(record!.linearSessionId).toBe("new-session-1");
    expect(record!.linearIssueId).toBe(TEST_ISSUE_ID);
    expect(record!.thenvoiRoomId).toBe("room-abc");
    expect(record!.status).toBe("active");
  });

  it("linear_create_session_on_issue rejects empty room_id via schema", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await expect(
      executeCustomTool(tool, { issue_id: TEST_ISSUE_ID, room_id: "" }),
    ).rejects.toThrow();
  });

  it("linear_create_session_on_issue skips persistence when room_id is not provided", async () => {
    const client = makeMockClientWithSessionCreation();
    const store = new MemorySessionRoomStore();
    const tools = createLinearTools({ client, store });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
    });

    const record = await store.getBySessionId("new-session-1");
    expect(record).toBeNull();
  });

  it("linear_create_session_on_issue surfaces warning when store persistence fails", async () => {
    const client = makeMockClientWithSessionCreation();
    const store = new MemorySessionRoomStore();
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("db write failed"));
    const tools = createLinearTools({ client, store, logger: mockLogger });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    const result = await executeCustomTool(tool, {
      issue_id: TEST_ISSUE_ID,
      room_id: "room-abc",
    });

    expect(result).toEqual({
      ok: true,
      session: { id: "new-session-1", issueId: TEST_ISSUE_ID, status: "active" },
      warning: "session-room mapping not persisted",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "linear_tools.session_room_persist_failed",
      expect.objectContaining({
        sessionId: "new-session-1",
        roomId: "room-abc",
        error: "db write failed",
      }),
    );
  });

  it("linear_create_session_on_comment persists session-room mapping when store and room_id are provided", async () => {
    const client = makeMockClientWithSessionCreation();
    const store = new MemorySessionRoomStore();
    const tools = createLinearTools({ client, store });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_comment")!;

    await executeCustomTool(tool, {
      comment_id: TEST_COMMENT_ID,
      room_id: "room-xyz",
    });

    const record = await store.getBySessionId("new-session-2");
    expect(record).not.toBeNull();
    expect(record!.thenvoiRoomId).toBe("room-xyz");
    expect(record!.status).toBe("active");
    // Comment sessions have null linearIssueId — verify it is persisted as null
    // and that getByIssueId does not accidentally match it.
    expect(record!.linearIssueId).toBeNull();
    const byIssue = await store.getByIssueId(TEST_ISSUE_ID);
    expect(byIssue).toBeNull();
  });

  it("linear_create_session_on_comment surfaces warning when store persistence fails", async () => {
    const client = makeMockClientWithSessionCreation();
    const store = new MemorySessionRoomStore();
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("db error"));
    const tools = createLinearTools({ client, store, logger: mockLogger });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_comment")!;

    const result = await executeCustomTool(tool, {
      comment_id: TEST_COMMENT_ID,
      room_id: "room-xyz",
    });

    expect(result).toEqual({
      ok: true,
      session: { id: "new-session-2", issueId: null, status: "active" },
      warning: "session-room mapping not persisted",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "linear_tools.session_room_persist_failed",
      expect.objectContaining({
        sessionId: "new-session-2",
        roomId: "room-xyz",
        error: "db error",
      }),
    );
  });

  it("linear_create_issue rejects empty title", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_issue")!;

    await expect(
      executeCustomTool(tool, { team_id: TEST_TEAM_ID, title: "" }),
    ).rejects.toThrow();
  });

  it("linear_create_session_on_issue throws when API returns no session ID", async () => {
    const client = makeMockClientWithSessionCreation();
    (client.agentSessionCreateOnIssue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      agentSession: { id: undefined, issueId: null, status: null },
    });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await expect(
      executeCustomTool(tool, { issue_id: TEST_ISSUE_ID }),
    ).rejects.toThrow(/session without an ID/);
  });

  it("linear_create_issue throws when API returns no issue ID", async () => {
    const client = makeMockClientWithSessionCreation();
    (client.createIssue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      issue: { id: undefined, identifier: null, url: null, title: null },
    });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_issue")!;

    await expect(
      executeCustomTool(tool, { team_id: TEST_TEAM_ID, title: "Test" }),
    ).rejects.toThrow(/issue without an ID/);
  });

  it("linear_create_session_on_issue rejects non-UUID issue_id via schema", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_session_on_issue")!;

    await expect(
      executeCustomTool(tool, { issue_id: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("linear_create_issue rejects non-UUID team_id via schema", async () => {
    const client = makeMockClientWithSessionCreation();
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_create_issue")!;

    await expect(
      executeCustomTool(tool, { team_id: "not-a-uuid", title: "Test" }),
    ).rejects.toThrow();
  });

  it("includes linear_suggest_repositories when client supports issueRepositorySuggestions", () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    const tools = createLinearTools({ client });
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("linear_suggest_repositories");
  });

  it("excludes linear_suggest_repositories when client lacks issueRepositorySuggestions", () => {
    const client = makeMockClient();
    const tools = createLinearTools({ client });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("linear_suggest_repositories");
  });

  it("linear_suggest_repositories returns ranked suggestions from the Linear API", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      issue_id: TEST_ISSUE_ID,
      repositories: [
        { hostname: "github.com", repositoryFullName: "org/frontend-app" },
        { hostname: "github.com", repositoryFullName: "org/backend-api" },
      ],
    });

    expect(result).toEqual({
      suggestions: [
        { repositoryFullName: "org/frontend-app", hostname: "github.com", confidence: 0.92 },
        { repositoryFullName: "org/backend-api", hostname: "github.com", confidence: 0.45 },
      ],
    });
    expect(client.issueRepositorySuggestions).toHaveBeenCalledWith(
      [
        { hostname: "github.com", repositoryFullName: "org/frontend-app" },
        { hostname: "github.com", repositoryFullName: "org/backend-api" },
      ],
      TEST_ISSUE_ID,
      { agentSessionId: "sess-1" },
    );
  });

  it("linear_suggest_repositories rejects non-UUID issue_id", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        issue_id: "SOF-1",
        repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
      }),
    ).rejects.toThrow("requires the exact Linear UUID from the session context");
  });

  it("linear_suggest_repositories rejects empty repositories array", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        issue_id: TEST_ISSUE_ID,
        repositories: [],
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("linear_suggest_repositories returns empty array when API returns null", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    (client.issueRepositorySuggestions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      issue_id: TEST_ISSUE_ID,
      repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
    });

    expect(result).toEqual({ suggestions: [] });
  });

  it("linear_suggest_repositories returns empty array when API response has no suggestions key", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    (client.issueRepositorySuggestions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: [] });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      issue_id: TEST_ISSUE_ID,
      repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
    });

    expect(result).toEqual({ suggestions: [] });
  });

  it("linear_suggest_repositories sorts suggestions by confidence descending", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    (client.issueRepositorySuggestions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestions: [
        { repositoryFullName: "org/low", hostname: "github.com", confidence: 0.2 },
        { repositoryFullName: "org/high", hostname: "github.com", confidence: 0.95 },
        { repositoryFullName: "org/mid", hostname: "github.com", confidence: 0.6 },
      ],
    });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      issue_id: TEST_ISSUE_ID,
      repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
    });

    expect(result).toEqual({
      suggestions: [
        { repositoryFullName: "org/high", hostname: "github.com", confidence: 0.95 },
        { repositoryFullName: "org/mid", hostname: "github.com", confidence: 0.6 },
        { repositoryFullName: "org/low", hostname: "github.com", confidence: 0.2 },
      ],
    });
  });

  it("linear_suggest_repositories propagates API errors to the caller", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    (client.issueRepositorySuggestions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Linear API unavailable"),
    );
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    await expect(
      executeCustomTool(tool, {
        session_id: "sess-1",
        issue_id: TEST_ISSUE_ID,
        repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
      }),
    ).rejects.toThrow("Linear API unavailable");
  });

  it("linear_suggest_repositories skips malformed entries missing repositoryFullName", async () => {
    const client = makeMockClient({ withRepoSuggestions: true });
    (client.issueRepositorySuggestions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestions: [
        { repositoryFullName: "org/valid", hostname: "github.com", confidence: 0.9 },
        { hostname: "github.com", confidence: 0.5 },
        null,
        { repositoryFullName: 123, hostname: "github.com", confidence: 0.3 },
      ],
    });
    const tools = createLinearTools({ client });
    const tool = tools.find((entry) => entry.name === "linear_suggest_repositories")!;

    const result = await executeCustomTool(tool, {
      session_id: "sess-1",
      issue_id: TEST_ISSUE_ID,
      repositories: [{ hostname: "github.com", repositoryFullName: "org/repo" }],
    });

    expect(result).toEqual({
      suggestions: [
        { repositoryFullName: "org/valid", hostname: "github.com", confidence: 0.9 },
      ],
    });
  });
});

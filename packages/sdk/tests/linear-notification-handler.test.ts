import { describe, expect, it, vi } from "vitest";

import {
  handleAppUserNotification,
  type HandleAppUserNotificationInput,
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
    return (
      [...this.records.values()]
        .filter((r) => r.linearIssueId === issueId && r.status !== "canceled")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    );
  }

  public async upsert(record: SessionRoomRecord): Promise<void> {
    this.records.set(record.linearSessionId, record);
  }

  public async markCanceled(sessionId: string): Promise<void> {
    const existing = this.records.get(sessionId);
    if (!existing) return;
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

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeActiveSession(issueId: string): SessionRoomRecord {
  return {
    linearSessionId: `session-for-${issueId}`,
    linearIssueId: issueId,
    thenvoiRoomId: `room-for-${issueId}`,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeDeps(store: SessionRoomStore) {
  return {
    thenvoiRest: new LinearThenvoiExampleRestApi(),
    linearClient: { createAgentActivity: vi.fn(async () => ({ ok: true })) } as never,
    store,
  };
}

function makeNotificationPayload(
  notification: Record<string, unknown>,
): HandleAppUserNotificationInput["payload"] {
  return {
    type: "AppUserNotification",
    action: "create",
    appUserId: "app-user-1",
    createdAt: new Date().toISOString(),
    oauthClientId: "oauth-1",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    notification,
  } as unknown as HandleAppUserNotificationInput["payload"];
}

describe("handleAppUserNotification", () => {
  it("cancels active session and sends room message on issueUnassignedFromYou", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-1");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        issueId: "issue-1",
        actorId: "user-who-unassigned",
        id: "notif-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-1", title: "Test issue" },
      }),
      deps,
      logger,
    });

    const updated = await store.getBySessionId("session-for-issue-1");
    expect(updated?.status).toBe("canceled");

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    expect(deps.thenvoiRest.roomEvents[0]).toEqual(
      expect.objectContaining({
        roomId: "room-for-issue-1",
        content: expect.stringContaining("unassigned from agent"),
        messageType: "task",
        metadata: expect.objectContaining({
          linear_notification_type: "issueUnassignedFromYou",
          linear_issue_id: "issue-1",
          linear_actor_id: "user-who-unassigned",
        }),
      }),
    );

    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_unassigned_handled",
      expect.objectContaining({
        issueId: "issue-1",
        sessionId: "session-for-issue-1",
      }),
    );
  });

  it("is a no-op on unassignment when no active session exists", async () => {
    const store = new MemorySessionRoomStore();
    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        issueId: "issue-no-session",
        actorId: "user-1",
        id: "notif-2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-no-session", title: "No session" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_unassigned_no_session",
      expect.objectContaining({ issueId: "issue-no-session" }),
    );
  });

  it("skips unassignment when session is already completed", async () => {
    const store = new MemorySessionRoomStore();
    const session: SessionRoomRecord = {
      ...makeActiveSession("issue-completed"),
      status: "completed",
    };
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueUnassignedFromYouNotificationWebhookPayload",
        issueId: "issue-completed",
        actorId: "user-1",
        id: "notif-completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-completed", title: "Completed issue" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_unassigned_no_session",
      expect.objectContaining({
        issueId: "issue-completed",
        reason: "session_status_completed",
      }),
    );
  });

  it("forwards new comment to active session room", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-2");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-2",
        commentId: "comment-1",
        comment: { body: "Please also check the edge case" },
        actor: { name: "Alice" },
        actorId: "alice-id",
        id: "notif-3",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-2", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    expect(deps.thenvoiRest.roomEvents[0]).toEqual(
      expect.objectContaining({
        roomId: "room-for-issue-2",
        content: "[Linear Comment from Alice]: Please also check the edge case",
        messageType: "text",
        metadata: expect.objectContaining({
          linear_notification_type: "issueNewComment",
          linear_comment_id: "comment-1",
          linear_actor_id: "alice-id",
        }),
      }),
    );
  });

  it("truncates comment body exceeding 4000 characters", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-trunc");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();
    const longBody = "x".repeat(5000);

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-trunc",
        commentId: "comment-trunc",
        comment: { body: longBody },
        actor: { name: "Alice" },
        actorId: "alice-id",
        id: "notif-trunc",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-trunc", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    const content = deps.thenvoiRest.roomEvents[0]!.content;
    const body = content.replace("[Linear Comment from Alice]: ", "");
    expect(body).toHaveLength(4001); // 4000 chars + ellipsis
    expect(body.endsWith("\u2026")).toBe(true);
    expect(body.startsWith("x".repeat(4000))).toBe(true);
  });

  it("sanitizes actor name with control characters", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-sanitize");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-sanitize",
        commentId: "comment-sanitize",
        comment: { body: "test" },
        actor: { name: "Alice\n]: injected\nBob" },
        actorId: "alice-id",
        id: "notif-sanitize",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-sanitize", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    const content = deps.thenvoiRest.roomEvents[0]!.content;
    expect(content).toBe("[Linear Comment from Alice ]: injected Bob]: test");
    expect(content).not.toContain("\n");
  });

  it("sanitizes comment body by stripping dangerous control characters but preserving newlines", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-sanitize-body");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-sanitize-body",
        commentId: "comment-sanitize-body",
        comment: { body: "\x00First line\nSecond line\x07\x0e" },
        actor: { name: "Alice" },
        actorId: "alice-id",
        id: "notif-sanitize-body",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-sanitize-body", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    const content = deps.thenvoiRest.roomEvents[0]!.content;
    expect(content).toBe("[Linear Comment from Alice]: First line\nSecond line");
    expect(content).not.toContain("\x00");
    expect(content).not.toContain("\x07");
    expect(content).toContain("\n");
  });

  it("forwards comment with null body as empty string", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-null-body");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-null-body",
        commentId: "comment-null-body",
        comment: { body: null },
        actor: { name: "Alice" },
        actorId: "alice-id",
        id: "notif-null-body",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-null-body", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    const content = deps.thenvoiRest.roomEvents[0]!.content;
    expect(content).toBe("[Linear Comment from Alice]: ");
  });

  it("truncates actor name exceeding 100 characters", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-long-name");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();
    const longName = "A".repeat(150);

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-long-name",
        commentId: "comment-long-name",
        comment: { body: "test" },
        actor: { name: longName },
        actorId: "alice-id",
        id: "notif-long-name",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-long-name", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    const content = deps.thenvoiRest.roomEvents[0]!.content;
    const name = content.replace("[Linear Comment from ", "").split("]: ")[0]!;
    expect(name).toHaveLength(101); // 100 chars + ellipsis
    expect(name.endsWith("\u2026")).toBe(true);
    expect(name.startsWith("A".repeat(100))).toBe(true);
  });

  it("skips comment forwarding when session is completed", async () => {
    const store = new MemorySessionRoomStore();
    const session: SessionRoomRecord = {
      ...makeActiveSession("issue-3"),
      status: "completed",
    };
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-3",
        commentId: "comment-2",
        comment: { body: "Late comment" },
        actor: { name: "Bob" },
        actorId: "bob-id",
        id: "notif-4",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-3", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_comment_skipped",
      expect.objectContaining({
        issueId: "issue-3",
        reason: "session_status_completed",
      }),
    );
  });

  it("logs reactions without room interaction", async () => {
    const store = new MemorySessionRoomStore();
    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueCommentReactionNotificationWebhookPayload",
        issueId: "issue-4",
        commentId: "comment-5",
        reactionEmoji: "\u{1F44D}",
        actorId: "reactor-id",
        id: "notif-5",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-4", title: "Test" },
        comment: { body: "Good work" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_reaction",
      expect.objectContaining({
        notificationType: "IssueCommentReactionNotificationWebhookPayload",
        reactionEmoji: "\u{1F44D}",
        issueId: "issue-4",
        commentId: "comment-5",
      }),
    );
  });

  it("logs emoji reactions on issues without room interaction", async () => {
    const store = new MemorySessionRoomStore();
    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueEmojiReactionNotificationWebhookPayload",
        issueId: "issue-5",
        reactionEmoji: "\u{1F389}",
        actorId: "reactor-id",
        id: "notif-6",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-5", title: "Test" },
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_reaction",
      expect.objectContaining({
        notificationType: "IssueEmojiReactionNotificationWebhookPayload",
        reactionEmoji: "\u{1F389}",
        issueId: "issue-5",
      }),
    );
  });

  it("skips comment when actorId matches appUserId (self-notification guard)", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-self");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-self",
        commentId: "comment-self",
        comment: { body: "Bot's own comment" },
        actor: { name: "Bot" },
        actorId: "app-user-1",
        id: "notif-self",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-self", title: "Test" },
      }),
      deps,
      logger,
      appUserId: "app-user-1",
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_comment_self_skipped",
      expect.objectContaining({
        issueId: "issue-self",
        commentId: "comment-self",
        actorId: "app-user-1",
      }),
    );
  });

  it("forwards comment when actorId differs from appUserId", async () => {
    const store = new MemorySessionRoomStore();
    const session = makeActiveSession("issue-other");
    await store.upsert(session);

    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "IssueNewCommentNotificationWebhookPayload",
        issueId: "issue-other",
        commentId: "comment-other",
        comment: { body: "Human comment" },
        actor: { name: "Alice" },
        actorId: "alice-id",
        id: "notif-other",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
        issue: { id: "issue-other", title: "Test" },
      }),
      deps,
      logger,
      appUserId: "app-user-1",
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(1);
    expect(deps.thenvoiRest.roomEvents[0]).toEqual(
      expect.objectContaining({
        roomId: "room-for-issue-other",
        content: "[Linear Comment from Alice]: Human comment",
      }),
    );
  });

  it("gracefully handles OtherNotificationWebhookPayload", async () => {
    const store = new MemorySessionRoomStore();
    const deps = makeDeps(store);
    const logger = makeLogger();

    await handleAppUserNotification({
      payload: makeNotificationPayload({
        __typename: "OtherNotificationWebhookPayload",
        id: "notif-7",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: "app-user-1",
      }),
      deps,
      logger,
    });

    expect(deps.thenvoiRest.roomEvents).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "linear_thenvoi_bridge.notification_unhandled",
      expect.objectContaining({
        notificationType: "OtherNotificationWebhookPayload",
      }),
    );
  });
});

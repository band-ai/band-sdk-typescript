import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformEvent } from "@band-ai/sdk";

import { AckTracker, type AckLink } from "../src/ack";
import { createMessageHandler, type MessageHandlerDeps } from "../src/handler";
import { LastSenderTracker } from "../src/mentions";

const SELF_ID = "3d5bd75e-1111-4c22-9e2b-8f1a2b3c4d5e";
const OWNER_ID = "b4e1a2c3-2222-4c22-9e2b-8f1a2b3c4d5e";
const SELF = { id: SELF_ID, name: "Band Bot", handle: "band-bot" };

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function messageEvent(overrides: Partial<{
  roomId: string;
  id: string;
  content: string;
  senderId: string;
  senderName: string;
  messageType: string;
}> = {}): PlatformEvent {
  const roomId = overrides.roomId ?? "room-1";
  return {
    type: "message_created",
    roomId,
    payload: {
      id: overrides.id ?? "msg-1",
      content: overrides.content ?? "@band-bot hello",
      message_type: overrides.messageType ?? "text",
      sender_id: overrides.senderId ?? OWNER_ID,
      sender_type: "user",
      sender_name: overrides.senderName ?? "Nir",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function fakeAckLink(): AckLink & { markProcessing: ReturnType<typeof vi.fn>; markProcessed: ReturnType<typeof vi.fn> } {
  return {
    markProcessing: vi.fn().mockResolvedValue(undefined),
    markProcessed: vi.fn().mockResolvedValue(undefined),
  };
}

function buildDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    self: SELF,
    ownerId: OWNER_ID,
    allowedSenderIds: new Set(),
    listParticipants: async () => [SELF, { id: OWNER_ID, name: "Nir", handle: "nir" }],
    commandAuthorizer: {
      authorize: vi.fn(async () => ({ allowed: true, note: null, source: "owner" as const })),
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ackTracker: new AckTracker(fakeAckLink(), noopLogger),
    lastSenderTracker: new LastSenderTracker(),
    notify: vi.fn().mockResolvedValue(undefined),
    logger: noopLogger,
    ...overrides,
  };
}

describe("createMessageHandler", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  it("pushes a channel notification for a mentioning owner message", async () => {
    const deps = buildDeps();
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent());

    expect(deps.notify).toHaveBeenCalledWith(
      "@band-bot hello",
      expect.objectContaining({ room_id: "room-1", sender_id: OWNER_ID, message_id: "msg-1" }),
    );
  });

  it("tracks the sender as the room's last sender on a forwarded message", async () => {
    const deps = buildDeps();
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent());

    expect(deps.lastSenderTracker.get("room-1")).toEqual({ senderId: OWNER_ID, senderName: "Nir" });
  });

  it("drops a self-authored message without notifying or acking", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({ ackTracker: new AckTracker(ackLink, noopLogger) });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ senderId: SELF_ID }));

    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessing).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).not.toHaveBeenCalled();
  });

  it("drops a non-text message without notifying or acking", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({ ackTracker: new AckTracker(ackLink, noopLogger) });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ messageType: "image" }));

    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessing).not.toHaveBeenCalled();
  });

  it("ignores non-message_created events entirely", async () => {
    const deps = buildDeps();
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, {
      type: "room_added",
      roomId: "room-1",
      payload: { id: "room-1", inserted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    });

    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("fails closed and marks nothing when the agent has no owner on record", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({ ownerId: null, ackTracker: new AckTracker(ackLink, noopLogger) });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent());

    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessing).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "dropping message: agent has no owner on record",
      expect.objectContaining({ room_id: "room-1" }),
    );
  });

  it("marks a gated-out message (no mention, group room) processed immediately without notifying", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({
      ackTracker: new AckTracker(ackLink, noopLogger),
      listParticipants: async () => [SELF, { id: OWNER_ID, name: "Nir", handle: "nir" }, { id: "third", name: "Third" }],
    });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ content: "just chatting, no mention" }));

    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
    expect(ackLink.markProcessing).not.toHaveBeenCalled();
  });

  it("forwards an owner message with no mention in a 1:1 room, and marks processing not processed", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({
      ackTracker: new AckTracker(ackLink, noopLogger),
      listParticipants: async () => [SELF, { id: OWNER_ID, name: "Nir", handle: "nir" }],
    });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ content: "just chatting, no mention" }));

    expect(deps.notify).toHaveBeenCalled();
    expect(ackLink.markProcessing).toHaveBeenCalledWith("room-1", "msg-1");
    expect(ackLink.markProcessed).not.toHaveBeenCalled();
  });

  it("drops a message from a sender outside the allowlist, even a mentioning one", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({ ackTracker: new AckTracker(ackLink, noopLogger) });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ senderId: "stranger", senderName: "Stranger" }));

    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
  });

  it("forwards an allowlisted sender's mentioning message", async () => {
    const deps = buildDeps({
      allowedSenderIds: new Set(["ally"]),
    });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ senderId: "ally", senderName: "Ally" }));

    expect(deps.notify).toHaveBeenCalled();
  });

  it("does not distinguish a reconnect catch-up event from a live one: both push identically", async () => {
    // AgentRuntime routes both a live WebSocket push and a reconnect's
    // /messages/next backlog drain through the same onExecute call with the
    // same PlatformEvent shape — there is nothing to special-case, so two
    // otherwise-identical message_created events (as if the first arrived
    // live and the second arrived via catch-up after a reconnect) both push.
    const ackLink = fakeAckLink();
    const deps = buildDeps({ ackTracker: new AckTracker(ackLink, noopLogger) });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent({ id: "msg-1" }));
    await handler({ roomId: "room-1" }, messageEvent({ id: "msg-2" }));

    expect(deps.notify).toHaveBeenCalledTimes(2);
    expect(ackLink.markProcessing).toHaveBeenCalledWith("room-1", "msg-1");
    expect(ackLink.markProcessing).toHaveBeenCalledWith("room-1", "msg-2");
  });

  it("propagates to the ack tracker on a notify failure, logging instead of throwing", async () => {
    const ackLink = fakeAckLink();
    const deps = buildDeps({
      ackTracker: new AckTracker(ackLink, noopLogger),
      notify: vi.fn().mockRejectedValue(new Error("stdio closed")),
    });
    const handler = createMessageHandler(deps);

    await handler({ roomId: "room-1" }, messageEvent());

    expect(ackLink.markProcessing).toHaveBeenCalledWith("room-1", "msg-1");
    expect(noopLogger.error).toHaveBeenCalledWith(
      "failed to push notifications/claude/channel",
      expect.objectContaining({ room_id: "room-1" }),
    );
  });

  it("requires local authorization before forwarding a non-owner slash command", async () => {
    const ackLink = fakeAckLink();
    const authorize = vi.fn().mockResolvedValue({
      allowed: false,
      note: "Deployment is frozen.",
      source: "deny_once",
    });
    const deps = buildDeps({
      listParticipants: async () => [
        SELF,
        { id: "ally", name: "Ally", handle: "ally-handle" },
      ],
      commandAuthorizer: { authorize },
      ackTracker: new AckTracker(ackLink, noopLogger),
    });
    const handler = createMessageHandler(deps);

    await handler(
      { roomId: "room-1" },
      messageEvent({
        senderId: "ally",
        senderName: "Ally",
        content: "@band-bot /deploy staging",
      }),
    );

    expect(authorize).toHaveBeenCalledWith({
      senderId: "ally",
      senderName: "Ally",
      command: "/deploy",
      content: "@band-bot /deploy staging",
    });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
    expect(deps.sendMessage).toHaveBeenCalledWith("room-1", {
      content: "@ally-handle /deploy was denied by the local Claude Code session. Deployment is frozen.",
      mentions: [{ id: "ally", handle: "ally-handle", name: "Ally" }],
    });
  });

  it("can authorize a slash command from outside the ordinary sender allowlist", async () => {
    const authorize = vi.fn().mockResolvedValue({
      allowed: true,
      note: null,
      source: "run_once",
    });
    const deps = buildDeps({ commandAuthorizer: { authorize } });
    const handler = createMessageHandler(deps);

    await handler(
      { roomId: "room-1" },
      messageEvent({
        senderId: "requester",
        senderName: "Requester",
        content: "@band-bot /review",
      }),
    );

    expect(authorize).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledWith(
      "@band-bot /review",
      expect.objectContaining({ sender_id: "requester" }),
    );
  });

  it("drops an unmentioned non-owner slash command without opening an authorization prompt", async () => {
    const ackLink = fakeAckLink();
    const authorize = vi.fn();
    const deps = buildDeps({
      commandAuthorizer: { authorize },
      ackTracker: new AckTracker(ackLink, noopLogger),
      listParticipants: async () => [
        SELF,
        { id: "requester", name: "Requester", handle: "requester" },
      ],
    });
    const handler = createMessageHandler(deps);

    await handler(
      { roomId: "room-1" },
      messageEvent({
        senderId: "requester",
        senderName: "Requester",
        content: "/review",
      }),
    );

    expect(authorize).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(ackLink.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
  });
});

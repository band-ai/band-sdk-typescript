/**
 * Unit tests for the pure inbound-context builder (transport layer).
 *
 * Contract (D5 C1 + INT-836 L2/F2):
 *  - message_created text -> inbound ctx; self-authored + non-text -> null
 *  - display Body carries the `[Band Room: <id>]` SUFFIX; command fields
 *    (RawBody/CommandBody/BodyForCommands) stay RAW (so stripMentions +
 *    command-parse are not corrupted by the marker)
 *  - ChatType derived from the (cached) room type; default 'group' on unknown
 *  - CommandAuthorized = (senderId === ownerUuid), FAIL-CLOSED if no owner
 *  - stable SessionKey `band:{roomId}`
 */

import { describe, it, expect } from "vitest";
import {
  platformEventToInboundContext,
  roomTypeToChatType,
} from "../../src/transport.js";
import type { PlatformEvent } from "@thenvoi/sdk";

const SELF = "agent-self";
const OWNER = "user-owner";

function msgEvent(
  overrides: { type?: string; roomId?: string | undefined; payload?: Record<string, unknown> } = {},
): PlatformEvent {
  const { payload: payloadOverrides, ...top } = overrides;
  return {
    type: "message_created",
    roomId: "room-1",
    payload: {
      id: "msg-1",
      chat_room_id: "room-1",
      sender_id: "user-bob",
      sender_type: "user",
      sender_name: "Bob",
      content: "hello there",
      message_type: "text",
      inserted_at: "2026-06-16T10:00:00.000Z",
      ...(payloadOverrides ?? {}),
    },
    ...top,
  } as unknown as PlatformEvent;
}

describe("roomTypeToChatType", () => {
  it("maps direct-ish types to 'direct'", () => {
    expect(roomTypeToChatType("direct")).toBe("direct");
    expect(roomTypeToChatType("dm")).toBe("direct");
  });
  it("maps group/unknown to 'group', defaults undefined to 'group'", () => {
    expect(roomTypeToChatType("group")).toBe("group");
    expect(roomTypeToChatType("something-else")).toBe("group");
    expect(roomTypeToChatType(undefined)).toBe("group");
    expect(roomTypeToChatType(null)).toBe("group");
  });
});

describe("platformEventToInboundContext", () => {
  it("builds a ctx for a text message from a non-self, non-owner sender", () => {
    const ctx = platformEventToInboundContext(msgEvent(), { selfAgentId: SELF, ownerUuid: OWNER });
    expect(ctx).not.toBeNull();
    expect(ctx!.To).toBe("room-1");
    expect(ctx!.SessionKey).toBe("band:room-1");
    expect(ctx!.Surface).toBe("band");
    expect(ctx!.Provider).toBe("band");
    expect(ctx!.SenderId).toBe("user-bob");
    expect(ctx!.SenderName).toBe("Bob");
    expect(ctx!.CommandAuthorized).toBe(false); // bob is neither self nor owner
    expect(ctx!.ChatType).toBe("group"); // no roomType provided -> default
  });

  it("puts the [Band Room: X] marker as a SUFFIX on the model-facing bodies, keeping command fields RAW", () => {
    const ctx = platformEventToInboundContext(msgEvent(), { selfAgentId: SELF, ownerUuid: OWNER })!;
    // model-facing bodies carry the suffix
    expect(ctx.Body).toBe("hello there\n\n[Band Room: room-1]");
    expect(ctx.BodyForAgent).toBe("hello there\n\n[Band Room: room-1]");
    expect(ctx.Body!.endsWith("[Band Room: room-1]")).toBe(true);
    // command/parse fields stay RAW (ordering-hazard regression guard)
    expect(ctx.CommandBody).toBe("hello there");
    expect(ctx.BodyForCommands).toBe("hello there");
    expect(ctx.CommandBody).not.toContain("[Band Room:");
    expect(ctx.BodyForCommands).not.toContain("[Band Room:");
    // deprecated RawBody is intentionally not set
    expect(ctx.RawBody).toBeUndefined();
  });

  it("rewrites @[[uuid]] to @handle and appends a participant roster on the model-facing body", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { content: "@[[tom-id]] catch Jerry" } }),
      {
        selfAgentId: SELF,
        participants: [
          { id: SELF, name: "MyAgent", handle: "amit.gazal/myagent" },
          { id: "tom-id", name: "Tom", handle: "amit.gazal/tom" },
        ],
      },
    )!;
    // @[[uuid]] rewritten to @handle for the model to read
    expect(ctx.Body).toContain("@amit.gazal/tom catch Jerry");
    expect(ctx.Body).not.toContain("@[[tom-id]]");
    // roster injected (self excluded), marker still the trailing suffix
    expect(ctx.Body).toContain("## Participants in this room");
    expect(ctx.Body).toContain("- @amit.gazal/tom — Tom");
    expect(ctx.Body).not.toContain("MyAgent");
    expect(ctx.Body!.endsWith("[Band Room: room-1]")).toBe(true);
    // command fields stay RAW (no rewrite, no roster, no marker)
    expect(ctx.CommandBody).toBe("@[[tom-id]] catch Jerry");
    expect(ctx.BodyForCommands).toBe("@[[tom-id]] catch Jerry");
  });

  it("sets CommandAuthorized=true only when the sender is the owner", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { sender_id: OWNER } }),
      { selfAgentId: SELF, ownerUuid: OWNER },
    )!;
    expect(ctx.CommandAuthorized).toBe(true);
  });

  it("fails closed: CommandAuthorized=false when ownerUuid is absent, even for the same sender", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { sender_id: OWNER } }),
      { selfAgentId: SELF, ownerUuid: null },
    )!;
    expect(ctx.CommandAuthorized).toBe(false);
  });

  it("derives ChatType from the provided room type", () => {
    const direct = platformEventToInboundContext(msgEvent(), { selfAgentId: SELF, roomType: "direct" })!;
    expect(direct.ChatType).toBe("direct");
    const group = platformEventToInboundContext(msgEvent(), { selfAgentId: SELF, roomType: "group" })!;
    expect(group.ChatType).toBe("group");
  });

  it("returns null for the agent's own messages", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { sender_id: SELF } }),
      { selfAgentId: SELF, ownerUuid: OWNER },
    );
    expect(ctx).toBeNull();
  });

  it("returns null for non-text messages", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { message_type: "event" } }),
      { selfAgentId: SELF, ownerUuid: OWNER },
    );
    expect(ctx).toBeNull();
  });

  it("returns null when there is no room id", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ roomId: undefined, payload: { chat_room_id: undefined } }),
      { selfAgentId: SELF },
    );
    expect(ctx).toBeNull();
  });

  it("returns null for non-message events", () => {
    const ctx = platformEventToInboundContext(
      { type: "participant_added", roomId: "r", payload: {} } as unknown as PlatformEvent,
      { selfAgentId: SELF },
    );
    expect(ctx).toBeNull();
  });

  it("defaults SenderName to 'Unknown' when missing", () => {
    const ctx = platformEventToInboundContext(
      msgEvent({ payload: { sender_name: null } }),
      { selfAgentId: SELF },
    )!;
    expect(ctx.SenderName).toBe("Unknown");
  });
});

// =============================================================================
// Gateway lifecycle (HARD GATE: re-covers the deleted channel-gateway.test)
// =============================================================================

import { createBandGateway, resetGatewayStarting, createReplyDeliver } from "../../src/transport.js";
import {
  resetAccounts,
  getAccount,
  setAccount,
  cacheRoomType,
  trackLastSender,
} from "../../src/state.js";

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-self",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    rest: { getAgentMe: vi.fn().mockResolvedValue({ id: "agent-self", ownerUuid: "owner-1" }) },
    ...overrides,
  };
}

function makePresence() {
  return {
    onRoomJoined: undefined as unknown,
    onRoomEvent: undefined as unknown,
    onContactEvent: undefined as unknown,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/** A controllable abort signal + a runLifecycle that blocks until aborted. */
function makeCtx(account: Record<string, unknown> = { apiKey: "k", agentId: "a" }) {
  const controller = new AbortController();
  return {
    ctx: {
      cfg: {} as never,
      accountId: "default",
      account: account as never,
      runtime: {} as never,
      abortSignal: controller.signal,
      getStatus: () => ({}) as never,
      setStatus: () => {},
    },
    controller,
  };
}

function deps(extra: Record<string, unknown> = {}) {
  const link = makeLink();
  const presence = makePresence();
  const dispatch = vi.fn().mockResolvedValue(undefined);
  return {
    link,
    presence,
    dispatch,
    base: {
      createLink: () => link,
      createPresence: () => presence,
      createContactHandler: () => ({ handle: vi.fn().mockResolvedValue(undefined) }),
      dispatch,
      // runLifecycle resolves only when aborted (mirrors runPassiveAccountLifecycle)
      runLifecycle: ({ abortSignal, stop }: { abortSignal: AbortSignal; stop: () => Promise<void> }) =>
        new Promise<void>((resolve) => {
          if (abortSignal.aborted) return void stop().then(resolve);
          abortSignal.addEventListener("abort", () => void stop().then(resolve), { once: true });
        }),
      log: () => {},
      ...extra,
    },
  };
}

describe("gateway lifecycle", () => {
  beforeEach(() => {
    resetAccounts();
    resetGatewayStarting();
  });

  it("starts an account: connects, resolves owner, registers the account, holds open until abort, tears down once", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();

    const started = gw.startAccount!(ctx);
    // let startAccount run up to the lifecycle await
    await new Promise((r) => setTimeout(r, 0));

    expect(d.link.connect).toHaveBeenCalledOnce();
    expect(getAccount("default")?.selfAgentId).toBe("agent-self");
    expect(getAccount("default")?.ownerUuid).toBe("owner-1");
    expect(d.presence.start).toHaveBeenCalledOnce();

    controller.abort();
    await started;

    expect(d.presence.stop).toHaveBeenCalledOnce();
    expect(d.link.disconnect).toHaveBeenCalledOnce();
    expect(getAccount("default")).toBeUndefined();
  });

  it("race-guard: a concurrent startAccount for the same account is skipped", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const a = makeCtx();
    const b = makeCtx();

    const p1 = gw.startAccount!(a.ctx);
    await new Promise((r) => setTimeout(r, 0));
    await gw.startAccount!(b.ctx); // should no-op (already starting)

    expect(d.link.connect).toHaveBeenCalledOnce(); // only the first start connected

    a.controller.abort();
    await p1;
  });

  it("disconnect-before-restart: an existing connection is torn down before a new start", async () => {
    // pre-seed an existing account with a stoppable presence + link
    const oldStop = vi.fn().mockResolvedValue(undefined);
    const oldDisconnect = vi.fn().mockResolvedValue(undefined);
    setAccount("default", {
      link: { disconnect: oldDisconnect } as never,
      selfAgentId: "old",
      presence: { stop: oldStop },
    });

    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(oldStop).toHaveBeenCalledOnce();
    expect(oldDisconnect).toHaveBeenCalledOnce();
    expect(d.link.connect).toHaveBeenCalledOnce();

    controller.abort();
    await p;
  });

  it("dispatch-routing: a text message is mapped and routed to dispatch; markProcessed best-effort", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    // simulate an inbound message via the registered handler
    await (d.presence.onRoomEvent as (r: string, e: unknown) => Promise<void>)("room-1", msgEvent());

    expect(d.dispatch).toHaveBeenCalledOnce();
    const arg = d.dispatch.mock.calls[0][0] as { roomId: string; ctx: { To?: string } };
    expect(arg.roomId).toBe("room-1");
    expect(arg.ctx.To).toBe("room-1");
    expect(d.link.markProcessed).toHaveBeenCalledWith("room-1", "msg-1", { bestEffort: true });

    controller.abort();
    await p;
  });

  it("dispatch-routing: self-authored + non-text are skipped (no dispatch)", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    const onRoomEvent = d.presence.onRoomEvent as (r: string, e: unknown) => Promise<void>;
    await onRoomEvent("room-1", msgEvent({ payload: { sender_id: "agent-self" } }));
    await onRoomEvent("room-1", msgEvent({ payload: { message_type: "event" } }));
    expect(d.dispatch).not.toHaveBeenCalled();

    controller.abort();
    await p;
  });

  it("markProcessed best-effort: a failing markProcessed does not throw out of the handler", async () => {
    const link = makeLink({ markProcessed: vi.fn().mockRejectedValue(new Error("boom")) });
    const d = deps({ createLink: () => link });
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    await expect(
      (d.presence.onRoomEvent as (r: string, e: unknown) => Promise<void>)("room-1", msgEvent()),
    ).resolves.toBeUndefined();

    controller.abort();
    await p;
  });

  it("stopAccount on an unstarted account is safe (no throw)", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx } = makeCtx();
    await expect(gw.stopAccount!(ctx)).resolves.toBeUndefined();
  });
});

describe("createReplyDeliver (the deliver -> outbound.sendText seam)", () => {
  beforeEach(() => resetAccounts());

  it("routes a reply payload to outbound.sendText with the resolved mention", async () => {
    const createChatMessage = vi.fn().mockResolvedValue({ id: "m1" });
    const rest = {
      listChatParticipants: vi.fn().mockResolvedValue([
        { id: "agent-self", name: "AgentBot", type: "agent" },
        { id: "u-bob", name: "Bob", type: "user" },
      ]),
      createChatMessage,
    };
    setAccount("default", { link: { rest } as never, selfAgentId: "agent-self" });
    trackLastSender("default", "room-1", { senderId: "u-bob", senderName: "Bob" });

    const deliver = createReplyDeliver("default", "room-1", () => {});
    await deliver({ text: "hi there" });

    expect(createChatMessage).toHaveBeenCalledWith("room-1", {
      content: "hi there",
      mentions: [{ id: "u-bob", name: "Bob" }],
    });
  });

  it("logs (does not throw) when sendText rejects", async () => {
    const rest = {
      listChatParticipants: vi.fn().mockResolvedValue([
        { id: "agent-self", name: "AgentBot", type: "agent" },
        { id: "u-bob", name: "Bob", type: "user" },
      ]),
      createChatMessage: vi.fn().mockRejectedValue(new Error("network down")),
    };
    setAccount("default", { link: { rest } as never, selfAgentId: "agent-self" });
    trackLastSender("default", "room-1", { senderId: "u-bob", senderName: "Bob" });

    const log = vi.fn();
    const deliver = createReplyDeliver("default", "room-1", log);
    await expect(deliver({ text: "hi" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/reply delivery failed/));
  });

  it("logs (does not silently drop) when the account is not connected", async () => {
    // No setAccount — the account is absent (e.g. a teardown race).
    const log = vi.fn();
    const deliver = createReplyDeliver("default", "room-1", log);
    await expect(deliver({ text: "hi" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/account not connected/i));
  });
});

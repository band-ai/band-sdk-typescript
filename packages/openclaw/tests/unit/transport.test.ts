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

import {
  createBandGateway,
  resetGatewayStarting,
  createReplyDeliver,
  buildRuntimeOptions,
} from "../../src/transport.js";
import {
  resetAccounts,
  getAccount,
  setAccount,
  cacheRoomType,
  getRoomType,
  trackLastSender,
} from "../../src/state.js";

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-self",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    markProcessing: vi.fn().mockResolvedValue(undefined),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    rest: { getAgentMe: vi.fn().mockResolvedValue({ id: "agent-self", ownerUuid: "owner-1" }) },
    ...overrides,
  };
}

/** Captures the opts passed by `createRuntime(link, opts)` so tests can invoke
 * `onExecute`/`onRoomJoined`/`onContactEvent`/`onError` directly, mirroring how
 * the real `AgentRuntime` would call them. */
function makeRuntime() {
  return {
    opts: undefined as
      | {
          agentId: string;
          onExecute: (context: unknown, event: unknown) => Promise<void>;
          onRoomJoined?: (roomId: string, payload: Record<string, unknown>) => unknown;
          onContactEvent?: (event: unknown) => Promise<void>;
          onError?: (error: unknown, event: unknown) => void;
        }
      | undefined,
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

/** In-memory fake so tests never touch the real filesystem, and each test gets
 * an isolated store instead of sharing on-disk state across test runs. */
function makeFakeProcessedStore() {
  const seen = new Set<string>();
  return {
    has: (messageId: string) => seen.has(messageId),
    markProcessed: async (messageId: string) => {
      seen.add(messageId);
    },
  };
}

function deps(extra: Record<string, unknown> = {}) {
  const link = makeLink();
  const runtime = makeRuntime();
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  return {
    link,
    runtime,
    dispatch,
    log,
    base: {
      createLink: () => link,
      createProcessedStore: () => makeFakeProcessedStore(),
      createRuntime: (_l: unknown, opts: typeof runtime.opts) => {
        runtime.opts = opts;
        return runtime;
      },
      createContactHandler: () => ({ handle: vi.fn().mockResolvedValue(undefined) }),
      dispatch,
      // runLifecycle resolves only when aborted (mirrors runPassiveAccountLifecycle)
      runLifecycle: ({ abortSignal, stop }: { abortSignal: AbortSignal; stop: () => Promise<void> }) =>
        new Promise<void>((resolve) => {
          if (abortSignal.aborted) return void stop().then(resolve);
          abortSignal.addEventListener("abort", () => void stop().then(resolve), { once: true });
        }),
      log,
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
    expect(d.runtime.start).toHaveBeenCalledOnce();

    controller.abort();
    await started;

    expect(d.runtime.stop).toHaveBeenCalledOnce();
    // HIGH-2: stop() must be called with a finite timeout, never undefined —
    // an unbounded stop can hang on an in-flight dispatch awaiting the model.
    expect(d.runtime.stop.mock.calls[0][0]).toEqual(expect.any(Number));
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
    // pre-seed an existing account with a stoppable runtime + link
    const oldStop = vi.fn().mockResolvedValue(undefined);
    const oldDisconnect = vi.fn().mockResolvedValue(undefined);
    setAccount("default", {
      link: { disconnect: oldDisconnect } as never,
      selfAgentId: "old",
      runtime: { stop: oldStop },
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

  it("onExecute dispatch-routing: a text message is mapped and routed to dispatch; markProcessing then markProcessed, best-effort", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    // simulate an inbound message via the captured onExecute (as AgentRuntime would call it)
    await d.runtime.opts!.onExecute({}, msgEvent());

    expect(d.dispatch).toHaveBeenCalledOnce();
    const arg = d.dispatch.mock.calls[0][0] as { roomId: string; ctx: { To?: string } };
    expect(arg.roomId).toBe("room-1");
    expect(arg.ctx.To).toBe("room-1");
    // Band's message status is sent -> processing -> processed; markProcessed alone
    // 422s (INT-876 root cause), so markProcessing must be called first.
    expect(d.link.markProcessing).toHaveBeenCalledWith("room-1", "msg-1", { bestEffort: true });
    expect(d.link.markProcessed).toHaveBeenCalledWith("room-1", "msg-1", { bestEffort: true });
    const processingOrder = d.link.markProcessing.mock.invocationCallOrder[0];
    const processedOrder = d.link.markProcessed.mock.invocationCallOrder[0];
    expect(processingOrder).toBeLessThan(processedOrder);

    controller.abort();
    await p;
  });

  it("INT-876 dedup: a redelivered already-processed message is skipped (no re-dispatch, no re-reply)", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    // First delivery: dispatched and recorded as processed.
    await d.runtime.opts!.onExecute({}, msgEvent());
    expect(d.dispatch).toHaveBeenCalledOnce();

    // A room whose oldest message never got the processing->processed transition
    // (e.g. an older openclaw build, or a transient failure) can redeliver the
    // SAME message id on a later reconnect. The local dedup guard must catch it
    // even though the remote ack "succeeded" in this fake (proving the guard
    // doesn't depend on that ack) — but it must still (re-)attempt the mark
    // calls, since an older/real stuck message is exactly what needs unblocking.
    await d.runtime.opts!.onExecute({}, msgEvent());
    expect(d.dispatch).toHaveBeenCalledOnce(); // still just once
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/skipping already-processed message msg-1/));
    expect(d.link.markProcessing).toHaveBeenCalledTimes(2);
    expect(d.link.markProcessed).toHaveBeenCalledTimes(2);

    controller.abort();
    await p;
  });

  it("onExecute dispatch-routing: self-authored + non-text are skipped (no dispatch)", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    const onExecute = d.runtime.opts!.onExecute;
    await onExecute({}, msgEvent({ payload: { sender_id: "agent-self" } }));
    await onExecute({}, msgEvent({ payload: { message_type: "event" } }));
    expect(d.dispatch).not.toHaveBeenCalled();

    controller.abort();
    await p;
  });

  it("markProcessed best-effort: a failing markProcessed does not throw, and is logged (MEDIUM)", async () => {
    const link = makeLink({ markProcessed: vi.fn().mockRejectedValue(new Error("boom")) });
    const d = deps({ createLink: () => link });
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    await expect(d.runtime.opts!.onExecute({}, msgEvent())).resolves.toBeUndefined();
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/markProcessed failed/));

    controller.abort();
    await p;
  });

  it("HIGH-1: onExecute never throws, even when ctx-building fails; a subsequent good event still dispatches", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    cacheRoomType("default", "room-1", "group");
    const onExecute = d.runtime.opts!.onExecute;

    // A malformed event (missing payload) throws inside the wrapped body.
    await expect(onExecute({}, { type: "message_created" } as unknown)).resolves.toBeUndefined();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/onExecute failed/));

    // The runtime/consume loop is untouched: a good event on the same room still dispatches.
    await onExecute({}, msgEvent());
    expect(d.dispatch).toHaveBeenCalledOnce();

    controller.abort();
    await p;
  });

  it("HIGH-1 (architect review): onRoomJoined never throws, same total-try/catch as onExecute", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    const onRoomJoined = d.runtime.opts!.onRoomJoined!;
    // A payload whose `type` getter throws must not propagate (would otherwise
    // abort the whole account's live-event loop via AgentRuntime's consumeLoop).
    const throwingPayload = {
      get type() {
        throw new Error("boom");
      },
    };
    expect(() => onRoomJoined("room-1", throwingPayload)).not.toThrow();
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/onRoomJoined failed/));

    // Still caches the room type on a well-formed payload.
    onRoomJoined("room-2", { type: "direct" });
    expect(getRoomType("default", "room-2")).toBe("direct");

    controller.abort();
    await p;
  });

  it("HIGH-1: onError is wired into createRuntime and is called by the runtime on a fatal error", async () => {
    const d = deps();
    const gw = createBandGateway(d.base);
    const { ctx, controller } = makeCtx();
    const p = gw.startAccount!(ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(d.runtime.opts!.onError).toBeInstanceOf(Function);
    d.runtime.opts!.onError!(new Error("fatal"), msgEvent());
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/fatal runtime error/));

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

// =============================================================================
// INT-876: existing-room hydration / backlog drain (RoomPresence -> AgentRuntime)
// =============================================================================

describe("buildRuntimeOptions (INT-876 flag assertion)", () => {
  it("enables autoSubscribeExistingRooms and wires the callbacks through unchanged", () => {
    const onExecute = vi.fn();
    const onRoomJoined = vi.fn();
    const onContactEvent = vi.fn();
    const onError = vi.fn();
    const opts = buildRuntimeOptions({} as never, {
      agentId: "agent-self",
      onExecute,
      onRoomJoined,
      onContactEvent,
      onError,
    });
    expect(opts.agentConfig).toEqual({ autoSubscribeExistingRooms: true });
    expect(opts.agentId).toBe("agent-self");
    expect(opts.onExecute).toBe(onExecute);
    expect(opts.onRoomJoined).toBe(onRoomJoined);
    expect(opts.onContactEvent).toBe(onContactEvent);
    expect(opts.onError).toBe(onError);
  });
});

/**
 * A fake `link` shaped like `ThenvoiLink` (structurally, not by import) exercising
 * the REAL `AgentRuntime` + `Execution` — no injected fakes for those two. One
 * existing room ("room-1") is seeded with a single backlog message and
 * `nextEvent` never resolves a live WS event (only on abort), so a passing test
 * proves the backlog message was drained and dispatched with NO live event ever
 * delivered — the actual INT-876 behavior, not just the wiring flag.
 */
function makeIntegrationLink(overrides: Record<string, unknown> = {}) {
  const backlogMessage = {
    id: "backlog-1",
    roomId: "room-1",
    content: "backlog message",
    senderId: "user-bob",
    senderType: "user",
    senderName: "Bob",
    messageType: "text",
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  let served = false;
  return {
    agentId: "agent-self",
    capabilities: { contacts: false },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribeAgentRooms: vi.fn().mockResolvedValue(undefined),
    subscribeAgentContacts: vi.fn().mockResolvedValue(undefined),
    unsubscribeAgentContacts: vi.fn().mockResolvedValue(undefined),
    subscribeRoom: vi.fn().mockResolvedValue(undefined),
    unsubscribeRoom: vi.fn().mockResolvedValue(undefined),
    listAllChats: vi.fn().mockResolvedValue([{ id: "room-1", type: "group" }]),
    getStaleProcessingMessages: vi.fn().mockResolvedValue([]),
    getNextMessage: vi.fn().mockImplementation(async () => {
      if (served) return null;
      served = true;
      return backlogMessage;
    }),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    // Never resolves a live event; resolves null only when the runtime aborts —
    // proves the test's dispatched message came from backlog drain, not the WS.
    nextEvent: vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          if (signal.aborted) return resolve(null);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
    ),
    rest: {
      getAgentMe: vi.fn().mockResolvedValue({ id: "agent-self", ownerUuid: "owner-1" }),
      listChatParticipants: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe("real AgentRuntime integration (INT-876: backlog drain on connect)", () => {
  beforeEach(() => {
    resetAccounts();
    resetGatewayStarting();
  });

  it("drains and dispatches an existing-room backlog message with no live WS event ever delivered", async () => {
    const link = makeIntegrationLink();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    // NOTE: no createRuntime override — this exercises the real default
    // AgentRuntime + Execution against the fake link above.
    const gw = createBandGateway({
      createLink: () => link as never,
      createContactHandler: () => ({ handle: vi.fn().mockResolvedValue(undefined) }),
      createProcessedStore: () => makeFakeProcessedStore(),
      dispatch,
      runLifecycle: ({ abortSignal, stop }) =>
        new Promise<void>((resolve) => {
          if (abortSignal.aborted) return void stop().then(resolve);
          abortSignal.addEventListener("abort", () => void stop().then(resolve), { once: true });
        }),
      log,
    });
    const { ctx, controller } = makeCtx();

    const started = gw.startAccount!(ctx);
    // Let the async hydration + backlog drain (network-round-trip-shaped promises) settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(dispatch).toHaveBeenCalledOnce();
    const arg = dispatch.mock.calls[0][0] as { roomId: string; ctx: { To?: string; CommandBody?: string } };
    expect(arg.roomId).toBe("room-1");
    expect(arg.ctx.To).toBe("room-1");
    expect(arg.ctx.CommandBody).toBe("backlog message");
    // No live event delivery happened (nextEvent only ever resolves via abort).
    expect(link.nextEvent).toHaveBeenCalled();

    controller.abort();
    await started;
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

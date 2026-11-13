import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttributedPosts, contextCursorAfter, sortsAfterAnchor, type MessageDelivery } from "../src/client/rest/messageDelivery";
import { MAX_SETTIMEOUT_DELAY_MS } from "../src/core/deadline";
import { RoomExecutionStoppedError, RuntimeStateError } from "../src/core/errors";
import { FakeBandRoom, SELF_ID, type PostStep } from "./support/fakeBandRoom";
import { settleThroughRetries } from "./support/settleThroughRetries";

const ROOM = "room-1";
const USER = "user-1";
const REPLY = "Done @user-1";
const STORED_REPLY = "Done @[[user-1]]";
const UNAVAILABLE = 503;

/**
 * A message post whose outcome Band leaves unknown is settled by reading the
 * room back before any resend: found means delivered, not found means resend.
 * Driven through the real generated client against a fake Band room.
 */
describe("message delivery", () => {
  let room: FakeBandRoom;
  let delivery: MessageDelivery;

  beforeEach(() => {
    vi.useFakeTimers();
    room = new FakeBandRoom(ROOM, { [REPLY]: STORED_REPLY });
    const trigger = room.seed({ id: "trigger", content: `@[[${SELF_ID}]] hi`, senderId: USER, mentionIds: [SELF_ID] });
    delivery = { selfId: SELF_ID, anchor: { id: trigger.id, createdAt: new Date(trigger.inserted_at) }, attributed: new AttributedPosts() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function send(steps: PostStep[], options: { delivery?: MessageDelivery } = { delivery }) {
    room.script(...steps);
    return room.adapter().createChatMessage(ROOM, { content: REPLY, mentions: [{ id: USER, handle: USER }] }, options);
  }

  function ownPosts(): string[] {
    return room.stored.filter((message) => message.sender_id === SELF_ID).map((message) => message.id);
  }

  it("posts once and reads nothing back when Band answers", async () => {
    const result = await settleThroughRetries(send([{ kind: "created" }]));

    expect(result).toMatchObject({ id: "stored-1" });
    expect(ownPosts()).toEqual(["stored-1"]);
    expect(room.contextCursors).toEqual([]);
    expect(delivery.attributed.has("stored-1")).toBe(true);
  });

  it.each<{ name: string; step: PostStep }>([
    { name: "a 5xx after the commit", step: { kind: "committedThen", status: UNAVAILABLE } },
    { name: "a lost response after the commit", step: { kind: "committedNoResponse" } },
  ])("finds the post in the room after $name and does not send it again", async ({ step }) => {
    const result = await settleThroughRetries(send([step]));

    expect(result).toEqual({ id: "stored-1", success: true });
    expect(room.posts).toHaveLength(1);
    expect(ownPosts()).toEqual(["stored-1"]);
    expect(room.contextCursors).toEqual([contextCursorAfter(delivery.anchor)]);
    expect(delivery.attributed.has("stored-1")).toBe(true);
  });

  it("resends a post the read-back did not find", async () => {
    const result = await settleThroughRetries(send([{ kind: "refused", status: UNAVAILABLE }, { kind: "created" }]));

    expect(result).toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
    expect(ownPosts()).toEqual(["stored-1"]);
  });

  it("accepts a duplicate when the first attempt commits after the read-back", async () => {
    let release!: () => void;
    const commit = new Promise<void>((resolve) => {
      release = resolve;
    });

    await settleThroughRetries(send([{ kind: "commitsOnRelease", status: UNAVAILABLE, release: commit }, { kind: "created" }]));
    expect(ownPosts()).toEqual(["stored-1"]);

    release();
    await commit;
    await vi.runAllTimersAsync();
    expect(ownPosts()).toHaveLength(2);
  });

  it("resends when the room cannot be read back, so the reply is not lost", async () => {
    room.failContext(1);

    await settleThroughRetries(send([{ kind: "committedThen", status: UNAVAILABLE }, { kind: "created" }]));

    expect(room.posts).toHaveLength(2);
    expect(ownPosts()).toHaveLength(2);
  });

  it("surfaces the last failure after every attempt was uncertain and not found", async () => {
    const failing = send(Array.from({ length: 3 }, () => ({ kind: "refused", status: UNAVAILABLE }) as const));

    await expect(settleThroughRetries(failing)).rejects.toMatchObject({ statusCode: UNAVAILABLE });
    expect(room.posts).toHaveLength(3);
    expect(room.contextCursors).toHaveLength(3);
    expect(ownPosts()).toEqual([]);
  });

  it("does not read back or resend a post Band refused", async () => {
    await expect(settleThroughRetries(send([{ kind: "refused", status: 422 }]))).rejects.toMatchObject({ statusCode: 422 });

    expect(room.posts).toHaveLength(1);
    expect(room.contextCursors).toEqual([]);
  });

  it("does not resend into a room Band stopped the agent in", async () => {
    const stopped = { kind: "refused", status: 403, body: { error: { code: "forbidden", message: "Agent execution is stopped in this room" } } } as const;

    await expect(settleThroughRetries(send([stopped]))).rejects.toBeInstanceOf(RoomExecutionStoppedError);
    expect(room.posts).toHaveLength(1);
    expect(room.contextCursors).toEqual([]);
  });

  it("resends after a proxy 408 once its Retry-After has passed, with no read-back", async () => {
    const sent = send([{ kind: "refused", status: 408, headers: { "retry-after": "7" } }, { kind: "created" }]);
    await room.posted(1);

    await vi.advanceTimersByTimeAsync(6_999);
    expect(room.posts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(sent).resolves.toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
    expect(room.contextCursors).toEqual([]);
  });

  it("clamps a huge Retry-After so the resend waits the setTimeout ceiling", async () => {
    const retryAfterSeconds = Math.floor(MAX_SETTIMEOUT_DELAY_MS / 1000) + 100;
    const sent = send([
      { kind: "refused", status: 408, headers: { "retry-after": String(retryAfterSeconds) } },
      { kind: "created" },
    ]);
    await room.posted(1);

    await vi.advanceTimersByTimeAsync(MAX_SETTIMEOUT_DELAY_MS - 1);
    expect(room.posts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(sent).resolves.toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
    expect(room.contextCursors).toEqual([]);
  });

  it.each([
    { where: "after the trigger, already credited", place: "after" },
    { where: "before the trigger", place: "before" },
  ] as const)("does not take an identical own post $where for this one", async ({ place }) => {
    const earlier = { id: "earlier", content: STORED_REPLY, senderId: SELF_ID, mentionIds: [USER] };
    room = new FakeBandRoom(ROOM, { [REPLY]: STORED_REPLY });
    if (place === "before") room.seed(earlier);
    const trigger = room.seed({ id: "trigger", content: "hi", senderId: USER, mentionIds: [SELF_ID] });
    delivery = { selfId: SELF_ID, anchor: { id: trigger.id, createdAt: new Date(trigger.inserted_at) }, attributed: new AttributedPosts() };
    if (place === "after") {
      room.seed(earlier);
      delivery.attributed.add(earlier.id);
    }

    const result = await settleThroughRetries(send([{ kind: "refused", status: UNAVAILABLE }, { kind: "created" }]));

    expect(result).toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
  });

  it("reads the whole room when Band refuses the cursor built from the trigger", async () => {
    room.refuseForeignCursors();

    const result = await settleThroughRetries(send([{ kind: "committedThen", status: UNAVAILABLE }]));

    expect(result).toEqual({ id: "stored-1", success: true });
    expect(room.posts).toHaveLength(1);
    expect(ownPosts()).toEqual(["stored-1"]);
    expect(room.contextCursors).toEqual([contextCursorAfter(delivery.anchor), undefined]);
  });

  it("does not take a pre-trigger twin when the cursor fallback walks the whole room", async () => {
    room = new FakeBandRoom(ROOM, { [REPLY]: STORED_REPLY });
    room.seed({ id: "ancient-twin", content: STORED_REPLY, senderId: SELF_ID, mentionIds: [USER] });
    const trigger = room.seed({ id: "trigger", content: "hi", senderId: USER, mentionIds: [SELF_ID] });
    delivery = {
      selfId: SELF_ID,
      anchor: { id: trigger.id, createdAt: new Date(trigger.inserted_at) },
      attributed: new AttributedPosts(),
    };
    room.refuseForeignCursors();

    const result = await settleThroughRetries(send([{ kind: "refused", status: UNAVAILABLE }, { kind: "created" }]));

    expect(result).toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
    expect(ownPosts()).toEqual(["ancient-twin", "stored-1"]);
    expect(room.contextCursors).toEqual([contextCursorAfter(delivery.anchor), undefined]);
  });

  it("keeps credited posts so a later uncertain settle cannot claim an earlier twin", async () => {
    room = new FakeBandRoom(ROOM, { [REPLY]: STORED_REPLY });
    const trigger = room.seed({ id: "trigger", content: "hi", senderId: USER, mentionIds: [SELF_ID] });
    room.seed({ id: "twin-after-trigger", content: STORED_REPLY, senderId: SELF_ID, mentionIds: [USER] });
    delivery = {
      selfId: SELF_ID,
      anchor: { id: trigger.id, createdAt: new Date(trigger.inserted_at) },
      attributed: new AttributedPosts(),
    };
    delivery.attributed.add("twin-after-trigger");
    for (let i = 0; i < 1_000; i += 1) {
      delivery.attributed.add(`flood-${i}`);
    }
    expect(delivery.attributed.has("twin-after-trigger")).toBe(true);

    const result = await settleThroughRetries(send([{ kind: "refused", status: UNAVAILABLE }, { kind: "created" }]));

    expect(result).toMatchObject({ id: "stored-1" });
    expect(room.posts).toHaveLength(2);
    expect(ownPosts()).toEqual(["twin-after-trigger", "stored-1"]);
  });

  it("credits a twin left by a failed read-back so a later queued turn cannot false-found it", async () => {
    const attributed = new AttributedPosts();
    room = new FakeBandRoom(ROOM, { [REPLY]: STORED_REPLY });
    const m1 = room.seed({ id: "m1", content: "ping-1", senderId: USER, mentionIds: [SELF_ID] });
    // M2 already in the room before M1's reply POST — as when two user messages
    // are queued and the room holds the second turn until the first ends.
    const m2 = room.seed({ id: "m2", content: "ping-2", senderId: USER, mentionIds: [SELF_ID] });
    const body = { content: REPLY, mentions: [{ id: USER, handle: USER }] as [{ id: string; handle: string }] };

    const deliveryM1: MessageDelivery = {
      selfId: SELF_ID,
      anchor: { id: m1.id, createdAt: new Date(m1.inserted_at) },
      attributed,
    };
    room.failContext(1);
    room.script({ kind: "committedThen", status: UNAVAILABLE }, { kind: "created" });
    const m1Result = await settleThroughRetries(
      room.adapter().createChatMessage(ROOM, body, { delivery: deliveryM1 }),
    );

    expect(m1Result).toMatchObject({ id: "stored-2" });
    expect(room.posts).toHaveLength(2);
    expect(ownPosts()).toEqual(["stored-1", "stored-2"]);
    // R1 must not stay claimable after M1's accepted failed-read-back duplicate.
    expect(attributed.has("stored-1")).toBe(true);
    expect(attributed.has("stored-2")).toBe(true);

    const r1 = room.stored.find((message) => message.id === "stored-1")!;
    expect(sortsAfterAnchor(r1, { id: m2.id, createdAt: new Date(m2.inserted_at) })).toBe(true);
    expect(Date.parse(m2.inserted_at)).toBeLessThan(Date.parse(r1.inserted_at));

    const deliveryM2: MessageDelivery = {
      selfId: SELF_ID,
      anchor: { id: m2.id, createdAt: new Date(m2.inserted_at) },
      attributed,
    };
    room.script({ kind: "refused", status: UNAVAILABLE }, { kind: "created" });
    const m2Result = await settleThroughRetries(
      room.adapter().createChatMessage(ROOM, body, { delivery: deliveryM2 }),
    );

    expect(m2Result).toMatchObject({ id: "stored-3" });
    expect(room.posts).toHaveLength(4);
    expect(ownPosts()).toEqual(["stored-1", "stored-2", "stored-3"]);
  });

  it("resends without a read-back when the post has no turn to anchor it", async () => {
    await settleThroughRetries(send([{ kind: "committedThen", status: UNAVAILABLE }, { kind: "created" }], {}));

    expect(room.contextCursors).toEqual([]);
    expect(ownPosts()).toHaveLength(2);
  });

  it("stops between attempts once the turn is cut short", async () => {
    const turn = new AbortController();
    const sent = send([{ kind: "refused", status: UNAVAILABLE }, { kind: "created" }], { delivery: { ...delivery, stopped: turn.signal } });
    await room.posted(1);

    turn.abort("stop");

    await expect(settleThroughRetries(sent)).rejects.toBeInstanceOf(RuntimeStateError);
    expect(room.posts).toHaveLength(1);
  });
});

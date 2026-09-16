import { describe, expect, it, vi } from "vitest";
import {
  agentContactsTopic,
  agentRoomsTopic,
  chatRoomTopic,
  roomParticipantsTopic,
} from "@band-ai/band-sdk-core";

import { RoomPresence } from "../src/runtime/rooms/RoomPresence";
import { BandLink } from "../src/platform/BandLink";
import { TransportError } from "../src/core/errors";
import { FakeRestApi, FakeTransport } from "./testUtils";

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

describe("RoomPresence", () => {
  it("subscribes existing rooms and forwards room lifecycle events", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];
    const left: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async () => ({
            data: [{ id: "room-existing", title: "Existing Room" }],
            metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
          }),
        }),
      }),
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-new",
      status: "active",
      type: "direct",
      title: "New Room",
      removed_at: "",
    });
    await transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-new",
      status: "inactive",
      type: "direct",
      title: "New Room",
      removed_at: new Date().toISOString(),
    });
    await waitFor(
      () => joined.length === 2 && left.length === 1 && presence.roster.trackedRoomIds().length === 1,
    );

    expect(presence.roster.trackedRoomIds()).toEqual(["room-existing"]);
    expect(presence.roster.roomMembership("room-existing")).toBe("admitted");
    expect(joined).toEqual(["room-existing", "room-new"]);
    expect(left).toEqual(["room-new"]);

    await presence.stop();
    expect(left).toEqual(["room-new", "room-existing"]);
  });

  it("forwards contact events when contact subscriptions are enabled", async () => {
    const transport = new FakeTransport();
    const contactEvents: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async () => ({ data: [] }),
        }),
        capabilities: { contacts: true },
      }),
    });
    presence.onContactEvent = async (event) => {
      contactEvents.push(event.type);
    };

    await presence.start();
    await transport.emit("agent_contacts:agent-1", "contact_added", {
      id: "contact-1",
      handle: "jane",
      name: "Jane",
      type: "User",
      inserted_at: new Date().toISOString(),
    });

    expect(contactEvents).toEqual(["contact_added"]);
  });

  it("paginates existing room discovery across all available pages", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async ({ page }) => {
            if (page === 1) {
              return {
                data: [{ id: "room-1", title: "First Room" }],
                metadata: { page: 1, pageSize: 100, totalPages: 2, totalCount: 2 },
              };
            }

            return {
              data: [{ id: "room-2", title: "Second Room" }],
              metadata: { page: 2, pageSize: 100, totalPages: 2, totalCount: 2 },
            };
          },
        }),
      }),
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();

    expect(joined).toEqual(["room-1", "room-2"]);
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1", "room-2"]);
  });

  it("keeps room discovery failures contained when the caller logger throws", async () => {
    const transport = new FakeTransport();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error("logger is broken");
      }),
      error: vi.fn(),
    };

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async () => {
            throw new Error("room discovery failed");
          },
        }),
      }),
      logger,
    });

    await presence.start();

    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence failed to subscribe existing rooms",
      expect.objectContaining({
        error: expect.any(Error),
      }),
    );
  });

  it("admits a room only once under concurrent admission attempts, notifying each caller with its own payload", async () => {
    const transport = new FakeTransport();
    const joined: Array<{ roomId: string; payload: unknown }> = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomJoined = async (roomId, payload) => {
      joined.push({ roomId, payload });
    };

    await presence.start();

    const [first, second] = await Promise.all([
      presence.admitRoom("room-1", { source: "first" }),
      presence.admitRoom("room-1", { source: "second" }),
    ]);

    // Both calls race `beginRoomAdmission` before either awaits the transport
    // join, so exactly one claims the ticket and actually joins — but the
    // loser awaits that winner's result rather than reporting a hardcoded
    // false, so both resolve to the same true outcome. Admission itself
    // happens once (one transport join), but each caller asked to be
    // notified, so each independently gets its own onRoomJoined call with
    // its own payload — never the other caller's.
    expect([first, second]).toEqual([true, true]);
    expect(joined).toEqual([
      { roomId: "room-1", payload: { source: "first" } },
      { roomId: "room-1", payload: { source: "second" } },
    ]);
    expect(transport.hasTopic("chat_room:room-1")).toBe(true);
    expect(presence.roster.roomMembership("room-1")).toBe("admitted");
  });

  it("notifies a caller with its own payload even when a concurrent caller wins the admission", async () => {
    const transport = new FakeTransport();
    const joined: Array<{ roomId: string; payload: unknown }> = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomJoined = async (roomId, payload) => {
      joined.push({ roomId, payload });
    };

    await presence.start();

    // The synchronous ticket claim always goes to whichever call starts
    // first, so the first array element wins and performs the real
    // subscribe; the second is the loser awaiting that outcome.
    const [winnerAdmitted, loserAdmitted] = await Promise.all([
      presence.admitRoom("room-1", { source: "bootstrap" }, false),
      presence.admitRoom("room-1", { source: "room_added" }, true),
    ]);

    expect(winnerAdmitted).toBe(true);
    expect(loserAdmitted).toBe(true);
    // Only the loser asked to be notified, and it must see its own payload —
    // not the winner's, and not be silently skipped just because it lost
    // the ticket race.
    expect(joined).toEqual([{ roomId: "room-1", payload: { source: "room_added" } }]);
  });

  it("keeps a room correctly subscribed when it is removed and re-added while an out-of-loop admission is still resolving", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();

    let releaseStaleJoin: () => void = () => undefined;
    const staleJoinGate = new Promise<void>((resolve) => {
      releaseStaleJoin = resolve;
    });
    let chatJoinCount = 0;
    const joinSpy = vi.spyOn(transport, "join").mockImplementation(async (topic, handlers) => {
      if (topic === "chat_room:room-1") {
        chatJoinCount += 1;
        if (chatJoinCount === 1) {
          await staleJoinGate;
        }
      }
      return FakeTransport.prototype.join.call(transport, topic, handlers);
    });

    // Mirrors bootstrapRoomMessage: an admission entry point outside the
    // sequential WS event loop, whose own subscribe is still in flight.
    const staleAdmission = presence.admitRoom("room-1", {}, false);
    await waitFor(() => chatJoinCount === 1);

    await transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-1",
      status: "inactive",
      type: "direct",
      title: "Room",
      removed_at: new Date().toISOString(),
    });
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });

    // SubscriptionManager serializes room operations, so the removal's
    // unsubscribe and the re-add's fresh subscribe are both chained behind
    // this still-in-flight join and cannot proceed until it settles.
    releaseStaleJoin();
    await waitFor(() => joined.length === 1 && presence.roster.roomMembership("room-1") === "admitted");

    // The in-flight admission's own join succeeded, so its caller correctly
    // sees its own (transient) success — it is then displaced by the
    // removal, and the room ends up admitted again via the fresh ticket
    // that followed, with no leaked or duplicate transport join.
    await expect(staleAdmission).resolves.toBe(true);

    expect(presence.roster.roomMembership("room-1")).toBe("admitted");
    expect(transport.hasTopic("chat_room:room-1")).toBe(true);
    expect(chatJoinCount).toBe(2);

    joinSpy.mockRestore();
  });

  it("reports a stale ticket's own failed subscribe honestly, without blocking the room's fresh re-admission", async () => {
    const transport = new FakeTransport();

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });

    await presence.start();

    let releaseStaleJoin: (error?: unknown) => void = () => undefined;
    const staleJoinOutcome = new Promise<void>((resolve, reject) => {
      releaseStaleJoin = (error) => (error ? reject(error) : resolve());
    });
    let chatJoinCount = 0;
    const joinSpy = vi.spyOn(transport, "join").mockImplementation(async (topic, handlers) => {
      if (topic === "chat_room:room-1") {
        chatJoinCount += 1;
        if (chatJoinCount === 1) {
          await staleJoinOutcome;
        }
      }
      return FakeTransport.prototype.join.call(transport, topic, handlers);
    });

    // Same setup as above, but this time the stale ticket's own subscribe
    // will fail (not just lose a race) once released.
    const staleAdmission = presence.admitRoom("room-1", {}, false);
    await waitFor(() => chatJoinCount === 1);

    await transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-1",
      status: "inactive",
      type: "direct",
      title: "Room",
      removed_at: new Date().toISOString(),
    });
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });

    releaseStaleJoin(new Error("stale ticket's own join failed"));

    // Operations now serialize per room, so a fresh admission cannot start
    // — let alone succeed — before this stale ticket's own join settles.
    // There is no window left in which a newer ticket's success could
    // retroactively rescue this one: the caller sees its own honest failure.
    await expect(staleAdmission).resolves.toBe(false);

    // The room is still reachable: the fresh admission chained behind the
    // failed one (via the removal + re-add that follows it) succeeds
    // normally afterward, unaffected by the earlier failure.
    await waitFor(() => presence.roster.roomMembership("room-1") === "admitted");
    expect(transport.hasTopic("chat_room:room-1")).toBe(true);
    joinSpy.mockRestore();

    // The stale ticket's irrelevant failure must not linger and later be
    // misattributed as the cause of a genuinely fresh failure on this room.
    await transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-1",
      status: "inactive",
      type: "direct",
      title: "Room",
      removed_at: new Date().toISOString(),
    });
    await waitFor(() => presence.roster.roomMembership("room-1") === "unadmitted");
    const freshError = new Error("fresh, unrelated failure");
    const failingJoin = vi.spyOn(transport, "join").mockRejectedValueOnce(freshError);

    await expect(presence.admitRoomOrThrow("room-1")).rejects.toSatisfy((error: unknown) => {
      expect((error as TransportError).cause).toBe(freshError);
      return true;
    });

    failingJoin.mockRestore();
  });

  it("admitRoomOrThrow rejects with the real subscribe error attached as cause", async () => {
    const transport = new FakeTransport();
    const subscribeError = new Error("join failed");

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });

    await presence.start();

    const failingJoin = vi.spyOn(transport, "join").mockRejectedValueOnce(subscribeError);

    await expect(presence.admitRoomOrThrow("room-1")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).message).toBe("Failed to subscribe to room room-1");
      expect((error as TransportError).cause).toBe(subscribeError);
      return true;
    });

    failingJoin.mockRestore();
  });

  it("does not fire onRoomLeft for a room that was never admitted", async () => {
    const transport = new FakeTransport();
    const left: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    await transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-untracked",
      status: "inactive",
      type: "direct",
      title: "Untracked Room",
      removed_at: new Date().toISOString(),
    });

    expect(left).toEqual([]);
    expect(presence.roster.roomMembership("room-untracked")).toBe("unadmitted");
  });

  it("leaves a room unadmitted and fires no onRoomJoined when subscribeRoom fails", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];
    const restApi = new FakeRestApi({ listChats: async () => ({ data: [] }) });

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi,
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();

    const failingTopicJoin = vi.spyOn(transport, "join").mockRejectedValueOnce(new Error("join failed"));
    const admitted = await presence.admitRoom("room-1", {});

    expect(admitted).toBe(false);
    expect(joined).toEqual([]);
    expect(presence.roster.roomMembership("room-1")).toBe("unadmitted");

    failingTopicJoin.mockRestore();
  });

  it("fires onRoomLeft during stop() only for rooms that reached Admitted", async () => {
    const transport = new FakeTransport();
    const left: string[] = [];
    const restApi = new FakeRestApi({ listChats: async () => ({ data: [] }) });

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi,
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    await presence.admitRoom("room-admitted", {});
    presence.roster.beginRoomAdmission("room-admitting", true);

    await presence.stop();

    expect(left).toEqual(["room-admitted"]);
  });

  it("rejects a second concurrent start() without disrupting the first event loop", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      autoSubscribeExistingRooms: false,
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    const firstStart = presence.start();
    const secondStart = presence.start();
    await expect(secondStart).rejects.toThrow("already started");
    await firstStart;

    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-after-rejection",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });
    await waitFor(() => joined.length === 1);

    expect(joined).toEqual(["room-after-rejection"]);
  });

  it("warns and continues start() when the agent_contacts subscribe fails", async () => {
    const transport = new FakeTransport();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failingJoin = vi.spyOn(transport, "join").mockImplementation(async (topic, handlers) => {
      if (topic === "agent_contacts:agent-1") {
        throw new Error("contacts join failed");
      }
      return FakeTransport.prototype.join.call(transport, topic, handlers);
    });

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
        capabilities: { contacts: true },
      }),
      logger,
    });

    await expect(presence.start()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence failed to subscribe agent_contacts channel, continuing without it",
      expect.objectContaining({ error: expect.any(Error) }),
    );

    failingJoin.mockRestore();
  });

  it("still tears down admitted rooms during stop() when unsubscribeAgentContacts fails", async () => {
    const transport = new FakeTransport();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const left: string[] = [];

    await using presence = new RoomPresence({
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
        capabilities: { contacts: true },
      }),
      autoSubscribeExistingRooms: false,
      logger,
    });
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    await presence.admitRoom("room-1", {});

    const failingLeave = vi.spyOn(transport, "leave").mockImplementation(async (topic) => {
      if (topic === "agent_contacts:agent-1") {
        throw new Error("contacts leave failed");
      }
      return FakeTransport.prototype.leave.call(transport, topic);
    });

    await presence.stop();

    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence failed to unsubscribe agent_contacts channel",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(left).toEqual(["room-1"]);
    expect(presence.roster.trackedRoomIds()).toEqual([]);

    failingLeave.mockRestore();
  });

  it("reconciles removed, newly discovered, and surviving rooms from one REST snapshot after reconnect", async () => {
    const transport = new FakeTransport();
    let snapshotRooms: Array<{ id: string; title: string }> = [
      { id: "room-a", title: "Room A" },
      { id: "room-b", title: "Room B" },
    ];
    const joined: string[] = [];
    const left: string[] = [];

    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => ({
          data: snapshotRooms,
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: snapshotRooms.length },
        }),
      }),
    });
    const subscribeRoomSpy = vi.spyOn(link, "subscribeRoom");

    await using presence = new RoomPresence({ link });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    expect(presence.roster.trackedRoomIds().sort()).toEqual(["room-a", "room-b"]);

    // room-a drops off the snapshot, room-b survives, room-c is newly listed.
    snapshotRooms = [
      { id: "room-b", title: "Room B" },
      { id: "room-c", title: "Room C" },
    ];
    subscribeRoomSpy.mockClear();

    await transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set([
        agentRoomsTopic("agent-1"),
        chatRoomTopic("room-a"),
        roomParticipantsTopic("room-a"),
        chatRoomTopic("room-b"),
        roomParticipantsTopic("room-b"),
      ]),
    });

    await waitFor(() => left.includes("room-a") && joined.includes("room-c"));

    expect(left).toEqual(["room-a"]);
    expect(joined).toEqual(["room-a", "room-b", "room-c"]);
    expect(presence.roster.trackedRoomIds().sort()).toEqual(["room-b", "room-c"]);

    // room-b was neither removed nor freshly admitted — it survived via a
    // plain resubscribe, not a second onRoomJoined notification.
    expect(subscribeRoomSpy).toHaveBeenCalledWith("room-b");
    expect(subscribeRoomSpy).not.toHaveBeenCalledWith("room-a");
  });

  it("does not auto-admit a newly discovered room after reconnect when autoSubscribeExistingRooms is false", async () => {
    const transport = new FakeTransport();
    let snapshotRooms: Array<{ id: string; title: string }> = [{ id: "room-1", title: "Room 1" }];
    const joined: string[] = [];

    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => ({
          data: snapshotRooms,
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: snapshotRooms.length },
        }),
      }),
    });

    await using presence = new RoomPresence({ link, autoSubscribeExistingRooms: false });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();
    expect(presence.roster.trackedRoomIds()).toEqual([]);

    await presence.admitRoom("room-1", {});
    joined.length = 0;

    snapshotRooms = [
      { id: "room-1", title: "Room 1" },
      { id: "room-2", title: "Room 2" },
    ];

    await transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set([
        agentRoomsTopic("agent-1"),
        chatRoomTopic("room-1"),
        roomParticipantsTopic("room-1"),
      ]),
    });

    // room-1 stays tracked (it was already admitted); room-2 is never
    // auto-admitted just because a reconnect happened to see it in REST.
    await waitFor(() => presence.roster.trackedRoomIds().length > 0);
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1"]);
    expect(joined).toEqual([]);
  });

  it("restores agent_rooms and agent_contacts subscription intent after reconnect", async () => {
    const transport = new FakeTransport();

    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      transport,
      restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      capabilities: { contacts: true },
    });

    await using presence = new RoomPresence({ link });
    await presence.start();

    const subscribeAgentRoomsSpy = vi.spyOn(link, "subscribeAgentRooms");
    const subscribeAgentContactsSpy = vi.spyOn(link, "subscribeAgentContacts");

    await transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set([agentRoomsTopic("agent-1"), agentContactsTopic("agent-1")]),
    });

    await waitFor(
      () => subscribeAgentRoomsSpy.mock.calls.length > 0 && subscribeAgentContactsSpy.mock.calls.length > 0,
    );
    expect(subscribeAgentRoomsSpy).toHaveBeenCalledTimes(1);
    expect(subscribeAgentContactsSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the roster unchanged but still forwards the reconnect for execution resync when the REST snapshot fetch fails", async () => {
    const transport = new FakeTransport();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let callCount = 0;

    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => {
          callCount += 1;
          if (callCount > 1) {
            throw new Error("REST snapshot fetch failed");
          }
          return {
            data: [{ id: "room-1", title: "Room 1" }],
            metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
          };
        },
      }),
    });

    const events: Array<{ roomId: string; type: string }> = [];
    await using presence = new RoomPresence({ link, logger });
    presence.onRoomEvent = async (roomId, event) => {
      events.push({ roomId, type: event.type });
    };

    await presence.start();
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1"]);

    await transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set([
        agentRoomsTopic("agent-1"),
        chatRoomTopic("room-1"),
        roomParticipantsTopic("room-1"),
      ]),
    });

    await waitFor(() => events.length > 0);

    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence failed to fetch room snapshot after reconnect",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    // The roster survives the failed fetch untouched, and the room's own
    // Execution still gets the reconnect so it can re-run `/next`.
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1"]);
    expect(events).toEqual([{ roomId: "room-1", type: "reconnected" }]);
  });

  it("keeps a surviving room visible and retryable when its post-reconnect resubscribe fails", async () => {
    const transport = new FakeTransport();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => ({
          data: [{ id: "room-1", title: "Room 1" }],
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
        }),
      }),
    });

    await using presence = new RoomPresence({ link, logger });
    await presence.start();

    const originalSubscribeRoom = link.subscribeRoom.bind(link);
    let callCount = 0;
    const subscribeRoomSpy = vi.spyOn(link, "subscribeRoom").mockImplementation(async (roomId) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("resync failed");
      }
      return originalSubscribeRoom(roomId);
    });

    await transport.triggerReconnect({
      generation: 1,
      joinedTopics: new Set([
        agentRoomsTopic("agent-1"),
        chatRoomTopic("room-1"),
        roomParticipantsTopic("room-1"),
      ]),
    });

    await waitFor(() => callCount > 0);
    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence failed to resubscribe surviving room after reconnect",
      expect.objectContaining({ roomId: "room-1", error: expect.any(Error) }),
    );
    // The room stays tracked despite the failed resync — it is not torn
    // down just because one reconnect's resubscribe attempt failed.
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1"]);

    // A later reconnect can still resync it successfully.
    await transport.triggerReconnect({
      generation: 2,
      joinedTopics: new Set([
        agentRoomsTopic("agent-1"),
        chatRoomTopic("room-1"),
        roomParticipantsTopic("room-1"),
      ]),
    });
    await waitFor(() => callCount > 1);
    expect(presence.roster.trackedRoomIds()).toEqual(["room-1"]);

    subscribeRoomSpy.mockRestore();
  });
});

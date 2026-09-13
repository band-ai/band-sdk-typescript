import { describe, expect, it, vi } from "vitest";

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

  it("logs room discovery failures instead of swallowing them silently", async () => {
    const transport = new FakeTransport();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
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

  it("keeps a newer admission's subscription alive when an older, slower ticket resolves stale", async () => {
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
    await waitFor(() => joined.length === 1 && presence.roster.roomMembership("room-1") === "admitted");

    releaseStaleJoin();
    // The stale ticket's own subscribe succeeded, but a newer ticket already
    // won the room — the caller must see the room's real, current state
    // (admitted), not `false` just because its own ticket lost the race.
    await expect(staleAdmission).resolves.toBe(true);

    expect(presence.roster.roomMembership("room-1")).toBe("admitted");
    expect(transport.hasTopic("chat_room:room-1")).toBe(true);

    joinSpy.mockRestore();
  });

  it("does not let a stale ticket's own failed subscribe clobber a healthy room's error state", async () => {
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

    // Same race as above, but this time the stale ticket's own subscribe
    // will fail (not just lose the race) once released.
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
    await waitFor(() => presence.roster.roomMembership("room-1") === "admitted");

    releaseStaleJoin(new Error("stale ticket's own join failed"));

    // The stale ticket's own subscribe failed, but the room is admitted via
    // the newer ticket — the caller must see success, not a spurious failure.
    await expect(staleAdmission).resolves.toBe(true);
    expect(presence.roster.roomMembership("room-1")).toBe("admitted");
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
});

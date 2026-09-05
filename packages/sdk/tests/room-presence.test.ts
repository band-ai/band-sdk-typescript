import { describe, expect, it, vi } from "vitest";

import { RoomPresence } from "../src/runtime/rooms/RoomPresence";
import { BandLink } from "../src/platform/BandLink";
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

    const presence = new RoomPresence({
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

    const presence = new RoomPresence({
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

    await presence.stop();
  });

  it("paginates existing room discovery across all available pages", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    const presence = new RoomPresence({
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

    await presence.stop();
  });

  it("logs room discovery failures instead of swallowing them silently", async () => {
    const transport = new FakeTransport();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const presence = new RoomPresence({
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

    await presence.stop();
  });

  it("admits a room only once under concurrent admission attempts", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    const presence = new RoomPresence({
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

    const [first, second] = await Promise.all([
      presence.admitRoom("room-1", {}),
      presence.admitRoom("room-1", {}),
    ]);

    // Both calls race `beginRoomAdmission` before either awaits the transport
    // join, so exactly one claims the ticket and actually joins — but the
    // loser awaits that winner's result rather than reporting a hardcoded
    // false, so both resolve to the same true outcome.
    expect([first, second]).toEqual([true, true]);
    expect(joined).toEqual(["room-1"]);
    expect(transport.hasTopic("chat_room:room-1")).toBe(true);
    expect(presence.roster.roomMembership("room-1")).toBe("admitted");

    await presence.stop();
  });

  it("does not fire onRoomLeft for a room that was never admitted", async () => {
    const transport = new FakeTransport();
    const left: string[] = [];

    const presence = new RoomPresence({
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

    await presence.stop();
  });

  it("leaves a room unadmitted and fires no onRoomJoined when subscribeRoom fails", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];
    const restApi = new FakeRestApi({ listChats: async () => ({ data: [] }) });

    const presence = new RoomPresence({
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
    await presence.stop();
  });

  it("fires onRoomLeft during stop() only for rooms that reached Admitted", async () => {
    const transport = new FakeTransport();
    const left: string[] = [];
    const restApi = new FakeRestApi({ listChats: async () => ({ data: [] }) });

    const presence = new RoomPresence({
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

    const presence = new RoomPresence({
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

    await presence.stop();
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

    const presence = new RoomPresence({
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
    await presence.stop();
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

    const presence = new RoomPresence({
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

import { describe, expect, it, vi } from "vitest";

import { TransportError } from "../src/core/errors";
import type { TopicHandlers, StreamingTransport } from "../src/platform/streaming/transport";
import { RoomPresence } from "../src/runtime/rooms/RoomPresence";
import { ThenvoiLink } from "../src/platform/ThenvoiLink";
import { FakeRestApi } from "./testUtils";

class FakeTransport implements StreamingTransport {
  protected readonly handlers = new Map<string, TopicHandlers>();
  private connected = false;

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public async join(topic: string, handlers: TopicHandlers): Promise<void> {
    this.handlers.set(topic, handlers);
  }

  public async leave(topic: string): Promise<void> {
    this.handlers.delete(topic);
  }

  public async runForever(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return;
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  public async emit(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const topicHandlers = this.handlers.get(topic);
    const handler = topicHandlers?.[event];
    if (!handler) {
      throw new Error(`No handler for ${topic}/${event}`);
    }

    await Promise.resolve(handler(payload));
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

class FlakyTransport extends FakeTransport {
  private readonly remainingFailures = new Map<string, number>();

  public constructor(failures: Record<string, number>) {
    super();
    for (const [topic, count] of Object.entries(failures)) {
      this.remainingFailures.set(topic, count);
    }
  }

  public override async join(topic: string, handlers: TopicHandlers): Promise<void> {
    const remaining = this.remainingFailures.get(topic) ?? 0;
    if (remaining > 0) {
      this.remainingFailures.set(topic, remaining - 1);
      throw new TransportError(`Timeout joining topic ${topic}`);
    }
    await super.join(topic, handlers);
  }
}

class RejectingTransport extends FakeTransport {
  public constructor(private readonly rejectedTopic: string) {
    super();
  }

  public override async join(topic: string, handlers: TopicHandlers): Promise<void> {
    if (topic === this.rejectedTopic) {
      throw new Error(`Cannot join ${topic}`);
    }
    await super.join(topic, handlers);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition was not met in time");
}

describe("RoomPresence", () => {
  it("subscribes existing rooms and forwards room lifecycle events", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];
    const left: string[] = [];

    const presence = new RoomPresence({
      link: new ThenvoiLink({
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
    await waitFor(() => joined.length === 2 && left.length === 1 && presence.rooms.size === 1);

    expect([...presence.rooms]).toEqual(["room-existing"]);
    expect(joined).toEqual(["room-existing", "room-new"]);
    expect(left).toEqual(["room-new"]);

    await presence.stop();
    expect(left).toEqual(["room-new", "room-existing"]);
  });

  it("forwards contact events when contact subscriptions are enabled", async () => {
    const transport = new FakeTransport();
    const contactEvents: string[] = [];

    const presence = new RoomPresence({
      link: new ThenvoiLink({
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

    await waitFor(() => contactEvents.length === 1);
    expect(contactEvents).toEqual(["contact_added"]);

    await presence.stop();
  });

  it("paginates existing room discovery across all available pages", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];

    const presence = new RoomPresence({
      link: new ThenvoiLink({
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

    expect([...joined].sort()).toEqual(["room-1", "room-2"]);
    expect([...presence.rooms].sort()).toEqual(["room-1", "room-2"]);

    await presence.stop();
  });

  it("retries transient room join timeouts before giving up", async () => {
    const transport = new FlakyTransport({ "chat_room:room-retry": 1 });
    const joined: string[] = [];

    const presence = new RoomPresence({
      link: new ThenvoiLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async () => ({ data: [] }),
        }),
      }),
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-retry",
      status: "active",
      type: "direct",
      title: "Retry Room",
      removed_at: "",
    });

    await waitFor(() => joined.includes("room-retry") && presence.rooms.has("room-retry"));

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
      link: new ThenvoiLink({
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

  it("does not let one room's slow handler block other rooms", async () => {
    const transport = new FakeTransport();
    const joined: string[] = [];
    let releaseSlowRoom!: () => void;
    const slowRoom = new Promise<void>((resolve) => {
      releaseSlowRoom = resolve;
    });

    const presence = new RoomPresence({
      link: new ThenvoiLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
    });
    presence.onRoomJoined = async (roomId) => {
      if (roomId === "room-slow") {
        await slowRoom;
      }
      joined.push(roomId);
    };

    await presence.start();
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-slow",
      status: "active",
      type: "direct",
      title: "Slow Room",
      removed_at: "",
    });
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-fast",
      status: "active",
      type: "direct",
      title: "Fast Room",
      removed_at: "",
    });

    await waitFor(() => joined.includes("room-fast"));
    expect(joined).not.toContain("room-slow");

    releaseSlowRoom();
    await waitFor(() => joined.includes("room-slow"));
    await presence.stop();
  });

  it("prunes rooms missing from recovery discovery", async () => {
    const transport = new FakeTransport();
    const left: string[] = [];
    let listCall = 0;

    const presence = new RoomPresence({
      link: new ThenvoiLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({
          listChats: async () => {
            listCall += 1;
            return listCall === 1
              ? { data: [{ id: "room-deleted", title: "Deleted Room" }] }
              : { data: [] };
          },
        }),
      }),
      recoverySweepIntervalMs: 10,
    });
    presence.onRoomLeft = async (roomId) => {
      left.push(roomId);
    };

    await presence.start();
    await waitFor(() => presence.rooms.has("room-deleted"));
    await waitFor(() => left.includes("room-deleted") && !presence.rooms.has("room-deleted"));

    await presence.stop();
  });

  it("keeps consuming events after a room join failure", async () => {
    const transport = new RejectingTransport("chat_room:room-bad");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const joined: string[] = [];

    const presence = new RoomPresence({
      link: new ThenvoiLink({
        agentId: "agent-1",
        apiKey: "key",
        transport,
        restApi: new FakeRestApi({ listChats: async () => ({ data: [] }) }),
      }),
      logger,
    });
    presence.onRoomJoined = async (roomId) => {
      joined.push(roomId);
    };

    await presence.start();
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-bad",
      status: "active",
      type: "direct",
      title: "Bad Room",
      removed_at: "",
    });
    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-good",
      status: "active",
      type: "direct",
      title: "Good Room",
      removed_at: "",
    });

    await waitFor(() => joined.includes("room-good"));

    expect(joined).not.toContain("room-bad");
    await waitFor(() => logger.warn.mock.calls.length > 0);
    expect(logger.warn).toHaveBeenCalledWith(
      "RoomPresence dropped event after handler failure",
      expect.objectContaining({
        eventType: "room_added",
        roomId: "room-bad",
      }),
    );

    await presence.stop();
  });
});

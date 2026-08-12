import { describe, expect, it, vi } from "vitest";

import type { TopicHandlers, StreamingTransport } from "../src/platform/streaming/transport";
import { RoomPresence } from "../src/runtime/rooms/RoomPresence";
import { BandLink } from "../src/platform/BandLink";
import { FakeRestApi } from "./testUtils";

class FakeTransport implements StreamingTransport {
  private readonly handlers = new Map<string, TopicHandlers>();
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
    expect([...presence.rooms]).toEqual(["room-1", "room-2"]);

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
});

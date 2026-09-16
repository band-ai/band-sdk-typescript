import { describe, expect, it, vi } from "vitest";

import { BandLink } from "../src/platform/BandLink";
import type { PlatformEvent } from "../src/platform/events";
import {
  WebSocketDisconnectError,
  type WebSocketDisconnectReason,
} from "../src/platform/streaming/disconnectReason";
import type { StreamingTransport } from "../src/platform/streaming/transport";
import { UnsupportedFeatureError } from "../src/core/errors";
import { FakeRestApi } from "./testUtils";

class FakeTransport implements StreamingTransport {
  public readonly joinedTopics: string[] = [];

  public async connect() {}
  public async disconnect() {}
  public async join(topic: string, _handlers?: Record<string, unknown>) {
    this.joinedTopics.push(topic);
  }
  public async leave() {}
  public async runForever() {}
  public isConnected() {
    return true;
  }
}

class ControllableTransport extends FakeTransport {
  private readonly handlers = new Map<
    string,
    Record<string, (payload: Record<string, unknown>) => void>
  >();

  public override async join(
    topic: string,
    handlers: Record<string, (payload: Record<string, unknown>) => void>,
  ) {
    this.joinedTopics.push(topic);
    this.handlers.set(topic, handlers);
  }

  public emit(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const handler = this.handlers.get(topic)?.[event];
    if (!handler) {
      throw new Error(`No ${event} handler joined for ${topic}`);
    }
    handler(payload);
  }
}

class RejectingTransport extends FakeTransport {
  public constructor(private readonly reason: WebSocketDisconnectReason) {
    super();
  }

  public override async connect() {
    throw new WebSocketDisconnectError(this.reason);
  }
}

describe("BandLink event waiting", () => {
  it("normalizes every subscribed event through Core without losing ordered delivery", async () => {
    const transport = new ControllableTransport();
    const warn = vi.fn();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    await link.subscribeAgentRooms();
    await link.subscribeRoom("room-1");
    await link.subscribeAgentContacts();

    transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-1",
      title: "A real room",
      task_id: null,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      server_extra: "kept",
    });
    transport.emit("room_participants:room-1", "participant_added", {
      id: "participant-1",
      name: "Participant",
      type: "Agent",
    });
    transport.emit("chat_room:room-1", "message_created", {
      id: "message-1",
      content: "@participant hello",
      message_type: "text",
      sender_id: "sender-1",
      sender_type: "Agent",
      inserted_at: "2026-01-01T00:00:01Z",
      updated_at: "2026-01-01T00:00:01Z",
      server_extra: "kept",
    });

    const roomAdded = await link.nextEvent();
    const participantAdded = await link.nextEvent();
    const message = await link.nextEvent();
    expect([roomAdded?.type, participantAdded?.type, message?.type]).toEqual([
      "room_added",
      "participant_added",
      "message_created",
    ]);
    expect(message?.payload).toMatchObject({
      attachments: [],
      metadata: { mentions: [] },
      server_extra: "kept",
    });
    expect(message?.raw).toMatchObject({ server_extra: "kept" });

    const pending = link.nextEvent();
    transport.emit("chat_room:room-1", "message_created", { id: "invalid" });
    transport.emit("room_participants:room-1", "participant_removed", {
      id: "participant-1",
      name: "Participant",
      type: "Agent",
    });
    await expect(pending).resolves.toMatchObject({
      type: "participant_removed",
      payload: { id: "participant-1", name: "Participant", type: "Agent" },
    });
    expect(warn).toHaveBeenCalledWith(
      "Invalid message_created payload, dropping event",
      expect.objectContaining({
        issues: expect.any(Array),
        traceContext: null,
        roomId: "room-1",
      }),
    );

    transport.emit("agent_rooms:agent-1", "room_removed", {
      id: "room-1",
      title: "A real room",
      task_id: null,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:02Z",
    });
    transport.emit("room_participants:room-1", "room_deleted", { id: "room-1" });
    transport.emit("agent_contacts:agent-1", "contact_request_received", {
      id: "request-1",
      from_handle: "sender",
      from_name: "Sender",
      status: "pending",
      inserted_at: "2026-01-01T00:00:03Z",
    });
    transport.emit("agent_contacts:agent-1", "contact_request_updated", {
      id: "request-1",
      status: "approved",
    });
    transport.emit("agent_contacts:agent-1", "contact_added", {
      id: "contact-1",
      handle: "sender",
      name: "Sender",
      type: "Agent",
      inserted_at: "2026-01-01T00:00:04Z",
      is_remote: true,
      server_extra: "kept",
    });
    transport.emit("agent_contacts:agent-1", "contact_removed", { id: "contact-1" });

    const remaining = await Promise.all(Array.from({ length: 6 }, () => link.nextEvent()));
    expect(remaining.map((event) => event?.type)).toEqual([
      "room_removed",
      "room_deleted",
      "contact_request_received",
      "contact_request_updated",
      "contact_added",
      "contact_removed",
    ]);
    expect(remaining[4]?.payload).toMatchObject({
      is_remote: true,
      is_external: true,
      server_extra: "kept",
    });
  });

  it("does not poison runForever after a retryable websocket disconnect", async () => {
    const retryableReason = {
      source: "upgrade",
      status: 429,
      code: "too_many_requests",
      message: "Too many websocket connection attempts.",
      retryable: true,
      retryAfter: 7,
      requestId: null,
    } satisfies WebSocketDisconnectReason;
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport: new RejectingTransport(retryableReason),
    });

    await expect(link.connect()).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
    expect(link.getDisconnectReason()).toBe(retryableReason);
    await expect(
      link.runForever(new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("removes abort listeners when waiter resolves from queued events", async () => {
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport: new FakeTransport(),
    });

    let addCalls = 0;
    let removeCalls = 0;
    const listeners = new Set<EventListenerOrEventListenerObject>();

    const signal = {
      aborted: false,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        addCalls += 1;
        listeners.add(listener);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        removeCalls += 1;
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    const pending = link.nextEvent(signal);
    expect(addCalls).toBe(1);

    const event = {
      type: "message_created",
      roomId: "room-1",
      payload: {},
      raw: {},
    } as unknown as PlatformEvent;

    link.queueEvent(event);

    await expect(pending).resolves.toBe(event);
    expect(removeCalls).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it("rejects contact subscriptions when contact capability is disabled", async () => {
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport: new FakeTransport(),
      capabilities: { contacts: false },
    });

    await expect(link.subscribeAgentContacts()).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
  });

  it("allows contact subscriptions when contact capability is enabled", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
      capabilities: { contacts: true },
    });

    await expect(link.subscribeAgentContacts()).resolves.toBeUndefined();
    expect(transport.joinedTopics).toContain("agent_contacts:agent-1");
  });

  it("propagates mark errors by default", async () => {
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi({
        markMessageProcessed: async () => {
          throw new Error("mark failed");
        },
      }),
      transport: new FakeTransport(),
    });

    await expect(link.markProcessed("room-1", "message-1")).rejects.toThrow(
      "mark failed",
    );
  });

  it("supports explicit best-effort marking", async () => {
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi({
        markMessageProcessed: async () => {
          throw new Error("mark failed");
        },
      }),
      transport: new FakeTransport(),
    });

    await expect(
      link.markProcessed("room-1", "message-1", { bestEffort: true }),
    ).resolves.toBeUndefined();
  });

  it("exposes request-first chat listing semantics via listChats", async () => {
    let capturedRequest: { page: number; pageSize: number } | null = null;
    let capturedOptions: { headers?: Record<string, string> } | undefined;
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi({
        listChats: async (request, options) => {
          capturedRequest = request;
          capturedOptions = options;
          return {
            data: [{ id: "room-1" }],
            metadata: { page: request.page, pageSize: request.pageSize },
          };
        },
      }),
      transport: new FakeTransport(),
    });

    await expect(
      link.listChats({ page: 2, pageSize: 25 }, { headers: { "x-test": "1" } }),
    ).resolves.toEqual({
      data: [{ id: "room-1" }],
      metadata: { page: 2, pageSize: 25 },
    });

    expect(capturedRequest).toEqual({ page: 2, pageSize: 25 });
    expect(capturedOptions).toEqual({ headers: { "x-test": "1" } });
  });

  it("listAllChats paginates until metadata totalPages is reached", async () => {
    const requests: Array<{ page: number; pageSize: number }> = [];
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi({
        listChats: async (request) => {
          requests.push(request);
          const pageData =
            request.page === 1
              ? [{ id: "room-1" }, { id: "room-2" }]
              : [{ id: "room-3" }];
          return {
            data: pageData,
            metadata: {
              totalPages: 2,
              page: request.page,
              pageSize: request.pageSize,
            },
          };
        },
      }),
      transport: new FakeTransport(),
    });

    await expect(link.listAllChats({ pageSize: 2 })).resolves.toEqual([
      { id: "room-1" },
      { id: "room-2" },
      { id: "room-3" },
    ]);
    expect(requests).toEqual([
      { page: 1, pageSize: 2 },
      { page: 2, pageSize: 2 },
    ]);
  });
});

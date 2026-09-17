import { describe, expect, it, vi } from "vitest";
import { chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";

import { BandLink } from "../src/platform/BandLink";
import type { PlatformEvent } from "../src/platform/events";
import {
  WebSocketDisconnectError,
  type WebSocketDisconnectReason,
} from "../src/platform/streaming/disconnectReason";
import { UnsupportedFeatureError } from "../src/core/errors";
import { FakeRestApi, FakeTransport } from "./testUtils";

const supersededReason = {
  source: "agent_control",
  code: "session.already_connected",
  message: "superseded",
  retryable: false,
  retryAfter: null,
  targetSocketId: null,
  correlationId: null,
} satisfies WebSocketDisconnectReason;

describe("BandLink event waiting", () => {
  it("normalizes subscribed events through Core without losing ordered delivery", async () => {
    const transport = new FakeTransport();
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

    await transport.emit("agent_rooms:agent-1", "room_added", {
      id: "room-1",
      title: "A real room",
      task_id: null,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      server_extra: "kept",
    });
    await transport.emit("room_participants:room-1", "participant_added", {
      id: "participant-1",
      name: "Participant",
      type: "Agent",
    });
    await transport.emit("chat_room:room-1", "message_created", {
      id: "message-1",
      content: "@participant hello",
      message_type: "text",
      sender_id: "sender-1",
      sender_type: "Agent",
      chat_room_id: 42,
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
      chat_room_id: 42,
    });
    expect(message?.raw).toMatchObject({ server_extra: "kept" });

    const pending = link.nextEvent();
    await transport.emit("chat_room:room-1", "message_created", { id: "invalid" });
    await transport.emit("room_participants:room-1", "participant_removed", {
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
  });

  it("delivers Core's compact room and contact payloads", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.subscribeAgentRooms();
    await link.subscribeAgentContacts();

    for (const event of ["room_added", "room_removed"] as const) {
      await transport.emit("agent_rooms:agent-1", event, {
        id: "room-compact",
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
      const received = await link.nextEvent();
      expect(received).toMatchObject({ type: event, payload: { id: "room-compact" } });
      if (received?.type === event) {
        expect(received.payload.title).toBeUndefined();
        expect(received.payload.task_id).toBeUndefined();
      }
    }

    await transport.emit("agent_contacts:agent-1", "contact_request_received", {
      id: "request-1",
      status: "pending",
      inserted_at: "2026-01-01T00:00:00Z",
    });
    await transport.emit("agent_contacts:agent-1", "contact_added", {
      id: "contact-1",
      handle: null,
      name: null,
      type: "Agent",
      inserted_at: "2026-01-01T00:00:01Z",
      is_remote: null,
    });

    await expect(link.nextEvent()).resolves.toMatchObject({
      type: "contact_request_received",
      payload: { id: "request-1" },
    });
    await expect(link.nextEvent()).resolves.toMatchObject({
      type: "contact_added",
      payload: { handle: null, name: null, is_remote: null },
    });
  });

  it("coalesces concurrent connection setup behind one reconnect observer", async () => {
    const transport = new FakeTransport();
    transport.gateConnect();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });

    const first = link.connect();
    const second = link.connect();
    expect(transport.observers.size).toBe(1);

    transport.releaseConnection();
    await Promise.all([first, second]);
    await transport.triggerReconnect({
      generation: 1,
      attemptedTopics: new Set(),
      joinedTopics: new Set(),
    });

    await expect(link.nextEvent()).resolves.toEqual({
      type: "reconnected",
      roomId: null,
      payload: {},
    });
    await link.disconnect();
    expect(transport.observers.size).toBe(0);
  });

  it("finishes cleanup after a terminal callback already marked the link disconnected", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();
    await link.subscribeRoom("room-1");

    (link as unknown as { recordDisconnectError(error: WebSocketDisconnectError): void })
      .recordDisconnectError(new WebSocketDisconnectError(supersededReason));

    await link.disconnect();

    expect(transport.disconnectCount).toBe(1);
    expect(transport.observers.size).toBe(0);
  });

  it("propagates a non-retryable connect failure through the real transport.connect() path, then allows a fresh session afterward", async () => {
    const transport = new FakeTransport();
    transport.failConnect(new WebSocketDisconnectError(supersededReason));
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });

    await expect(link.connect()).rejects.toBeInstanceOf(WebSocketDisconnectError);
    expect(link.getDisconnectReason()).toBe(supersededReason);
    expect(transport.observers.size).toBe(0);

    transport.clearConnectFailure();
    await expect(link.connect()).resolves.toBeUndefined();
    expect(link.isConnected()).toBe(true);
  });

  it("disconnects the transport when connect() fails, so a partially-opened socket/channels don't leak", async () => {
    const transport = new FakeTransport();
    transport.failConnect(new Error("boom"));
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });

    await expect(link.connect()).rejects.toThrow("boom");
    expect(transport.disconnectCount).toBe(1);
    expect(transport.observers.size).toBe(0);

    // A second failed retry must not leak another observer registration on
    // top of the first's.
    await expect(link.connect()).rejects.toThrow("boom");
    expect(transport.disconnectCount).toBe(2);
    expect(transport.observers.size).toBe(0);

    transport.clearConnectFailure();
    await expect(link.connect()).resolves.toBeUndefined();
    expect(link.isConnected()).toBe(true);
  });

  it("still tears down local state and clears observers when transport.disconnect() rejects", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();
    vi.spyOn(transport, "disconnect").mockRejectedValueOnce(new Error("boom"));

    await expect(link.disconnect()).rejects.toThrow("boom");
    expect(link.isConnected()).toBe(false);
    expect(transport.observers.size).toBe(0);
  });

  it("waits for an in-flight disconnect() before completing a concurrent connect()", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();

    let releaseDisconnect: (() => void) | undefined;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    vi.spyOn(transport, "disconnect").mockImplementationOnce(async () => disconnectGate);

    const disconnect = link.disconnect();
    let connectResolved = false;
    const connect = link.connect().then(() => {
      connectResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectResolved).toBe(false);

    releaseDisconnect?.();
    await disconnect;
    await connect;

    expect(connectResolved).toBe(true);
    expect(link.isConnected()).toBe(true);
    await expect(link.subscribeRoom("room-1")).resolves.toBeUndefined();
  });

  it("waits for an in-flight connect() before completing a concurrent disconnect()", async () => {
    const transport = new FakeTransport();
    transport.gateConnect();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });

    const connect = link.connect();
    let disconnectResolved = false;
    const disconnect = link.disconnect().then(() => {
      disconnectResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnectResolved).toBe(false);

    transport.releaseConnection();
    await connect;
    await disconnect;

    expect(disconnectResolved).toBe(true);
    expect(link.isConnected()).toBe(false);
    expect(transport.disconnectCount).toBe(1);
  });

  it("coalesces concurrent disconnect calls into one transport teardown", async () => {
    const transport = new FakeTransport();
    let releaseDisconnect: (() => void) | undefined;
    const disconnectReleased = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const disconnect = vi
      .spyOn(transport, "disconnect")
      .mockImplementation(async () => disconnectReleased);
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();

    const first = link.disconnect();
    const second = link.disconnect();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));

    releaseDisconnect?.();
    await Promise.all([first, second]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not publish an old observer's reconnect after a new session starts", async () => {
    const transport = new FakeTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();
    await link.subscribeRoom("room-1");
    const releaseChatLeave = transport.gateLeave(chatRoomTopic("room-1"));
    const releaseParticipantsLeave = transport.gateLeave(roomParticipantsTopic("room-1"));

    const staleReconnect = transport.triggerReconnect({
      generation: 1,
      attemptedTopics: new Set([chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      joinedTopics: new Set(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await link.disconnect();
    await link.connect();

    releaseChatLeave();
    releaseParticipantsLeave();
    await staleReconnect;

    const controller = new AbortController();
    const next = link.nextEvent(controller.signal);
    controller.abort();
    await expect(next).resolves.toBeNull();
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
    const rejectingTransport = new FakeTransport();
    rejectingTransport.failConnect(new WebSocketDisconnectError(retryableReason));
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport: rejectingTransport,
    });

    await expect(link.connect()).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
    expect(link.getDisconnectReason()).toBe(retryableReason);
    const controller = new AbortController();
    const runForever = link.runForever(controller.signal);
    controller.abort();
    await expect(runForever).resolves.toBeUndefined();
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
    expect(transport.joinCalls).toContain("agent_contacts:agent-1");
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

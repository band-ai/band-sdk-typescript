import { describe, expect, it } from "vitest";

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
  public async join(topic: string) {
    this.joinedTopics.push(topic);
  }
  public async leave() {}
  public async runForever() {}
  public isConnected() {
    return true;
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

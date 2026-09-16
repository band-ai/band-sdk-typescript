import { describe, expect, it, vi } from "vitest";

import { BandLink } from "../src/platform/BandLink";
import type { PlatformEvent } from "../src/platform/events";
import {
  WebSocketDisconnectError,
  type WebSocketDisconnectReason,
} from "../src/platform/streaming/disconnectReason";
import type {
  ReconnectObserver,
  ReconnectSnapshot,
  StreamingTransport,
  TopicHandlers,
} from "../src/platform/streaming/transport";
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

class ReconnectTransport implements StreamingTransport {
  public readonly observers = new Set<ReconnectObserver>();
  public readonly joinCalls: string[] = [];
  public readonly joinedTopics = new Set<string>();
  public disconnectCount = 0;
  private connectGate: Promise<void> = Promise.resolve();
  private releaseConnect: (() => void) | null = null;
  private leaveGate: Promise<void> = Promise.resolve();
  private releaseLeave: (() => void) | null = null;

  public gateConnect(): void {
    this.connectGate = new Promise((resolve) => {
      this.releaseConnect = resolve;
    });
  }

  public releaseConnection(): void {
    this.releaseConnect?.();
    this.releaseConnect = null;
  }

  public gateLeaves(): void {
    this.leaveGate = new Promise((resolve) => {
      this.releaseLeave = resolve;
    });
  }

  public releaseLeaves(): void {
    this.releaseLeave?.();
    this.releaseLeave = null;
  }

  public async connect(): Promise<void> {
    await this.connectGate;
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.joinedTopics.clear();
  }

  public async join(topic: string, _handlers: TopicHandlers): Promise<void> {
    if (this.joinedTopics.has(topic)) {
      return;
    }
    this.joinCalls.push(topic);
    this.joinedTopics.add(topic);
  }

  public async leave(topic: string): Promise<void> {
    await this.leaveGate;
    this.joinedTopics.delete(topic);
  }

  public async runForever(): Promise<void> {}

  public isConnected(): boolean {
    return true;
  }

  public onReconnected(observer: ReconnectObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  public async triggerReconnect(snapshot: ReconnectSnapshot): Promise<void> {
    await Promise.all([...this.observers].map((observer) => observer(snapshot)));
  }
}

describe("BandLink event waiting", () => {
  it("coalesces concurrent connection setup behind one reconnect observer", async () => {
    const transport = new ReconnectTransport();
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

    await expect(link.nextEvent()).resolves.toMatchObject({ type: "reconnected" });
    await link.disconnect();
    expect(transport.observers.size).toBe(0);
  });

  it("finishes cleanup after a terminal callback already marked the link disconnected", async () => {
    const transport = new ReconnectTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();
    await link.subscribeRoom("room-1");

    const reason = {
      source: "agent_control",
      code: "session.already_connected",
      message: "superseded",
      retryable: false,
      retryAfter: null,
      targetSocketId: null,
      correlationId: null,
    } satisfies WebSocketDisconnectReason;
    (link as unknown as { recordDisconnectError(error: WebSocketDisconnectError): void })
      .recordDisconnectError(new WebSocketDisconnectError(reason));

    await link.disconnect();

    expect(transport.disconnectCount).toBe(1);
    expect(transport.observers.size).toBe(0);
  });

  it("coalesces concurrent disconnect calls into one transport teardown", async () => {
    const transport = new ReconnectTransport();
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
    const transport = new ReconnectTransport();
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "key",
      restApi: new FakeRestApi(),
      transport,
    });
    await link.connect();
    await link.subscribeRoom("room-1");
    transport.gateLeaves();

    const staleReconnect = transport.triggerReconnect({
      generation: 1,
      attemptedTopics: new Set(["chat_room:room-1", "room_participants:room-1"]),
      joinedTopics: new Set(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await link.disconnect();
    await link.connect();

    transport.releaseLeaves();
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

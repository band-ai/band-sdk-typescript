import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { RuntimeStateError, ValidationError } from "../src/core/errors";
import { ThenvoiLink } from "../src/platform/ThenvoiLink";
import type { StreamingTransport } from "../src/platform/streaming/transport";
import type { ContactEvent, PlatformEvent } from "../src/platform/events";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { ContactEventHandler } from "../src/runtime/ContactEventHandler";
import { FakeRestApi } from "./testUtils";

class MinimalTransport implements StreamingTransport {
  public async connect() {}
  public async disconnect() {}
  public async join() {}
  public async leave() {}
  public async runForever() {}
  public isConnected() {
    return true;
  }
}

describe("PlatformRuntime coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates required credentials", () => {
    expect(() => new PlatformRuntime({ agentId: "", apiKey: "k" })).toThrow(ValidationError);
    expect(() => new PlatformRuntime({ agentId: "a1", apiKey: " " })).toThrow(ValidationError);
  });

  it("uses configured identity without calling getAgentMe", async () => {
    const getAgentMe = vi.fn(async () => ({ id: "a1", name: "Fetched", description: "Fetched desc" }));
    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi({ getAgentMe }),
      }),
      identity: {
        name: "Configured",
        description: "Configured desc",
      },
    });

    await runtime.initialize();

    expect(runtime.name).toBe("Configured");
    expect(runtime.description).toBe("Configured desc");
    expect(getAgentMe).not.toHaveBeenCalled();
  });

  it("throws when runForever, bootstrapRoomMessage, or resetRoomSession are called before start", async () => {
    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi(),
      }),
    });

    await expect(runtime.runForever()).rejects.toBeInstanceOf(RuntimeStateError);
    await expect(runtime.bootstrapRoomMessage("room-1", {
      id: "m1",
      roomId: "room-1",
      content: "hi",
      senderId: "u1",
      senderType: "User",
      senderName: "User",
      messageType: "text",
      metadata: {},
      createdAt: new Date(),
    })).rejects.toBeInstanceOf(RuntimeStateError);
    await expect(runtime.resetRoomSession("room-1")).rejects.toBeInstanceOf(RuntimeStateError);
  });

  it("aggregates runtime and adapter cleanup failures during stop", async () => {
    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi(),
      }),
    });

    (runtime as unknown as {
      runtime: { stop(timeoutMs?: number): Promise<boolean> };
      activeAdapter: { onRuntimeStop?: () => Promise<void> };
      stopping: boolean;
    }).runtime = {
      stop: async () => {
        throw new Error("runtime stop failed");
      },
    };
    (runtime as unknown as {
      runtime: { stop(timeoutMs?: number): Promise<boolean> };
      activeAdapter: { onRuntimeStop?: () => Promise<void> };
      stopping: boolean;
    }).activeAdapter = {
      onRuntimeStop: async () => {
        throw new Error("adapter cleanup failed");
      },
    };

    await expect(runtime.stop()).rejects.toThrow(
      "PlatformRuntime stop failed and adapter cleanup also failed",
    );
  });

  it("normalizes remote aliases on websocket participant and contact events", async () => {
    const participantEvents: unknown[] = [];
    const contactEvents: ContactEvent[] = [];
    const runtime = new AgentRuntime({
      agentId: "a1",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi(),
      }),
      onExecute: async () => {},
      onParticipantAdded: async (_roomId, participant) => {
        participantEvents.push(participant);
      },
      onContactEvent: async (event) => {
        contactEvents.push(event);
      },
    });
    const handleEvent = (runtime as unknown as { handleEvent(event: PlatformEvent): Promise<void> }).handleEvent.bind(runtime);

    await handleEvent({
      type: "participant_added",
      roomId: "room-1",
      payload: {
        id: "p1",
        name: "Pat",
        type: "User",
        handle: "@pat",
        is_external: true,
      },
    });
    await handleEvent({
      type: "contact_added",
      roomId: null,
      payload: {
        id: "c1",
        handle: "@casey",
        name: "Casey",
        type: "User",
        description: null,
        is_remote: false,
        is_external: true,
        inserted_at: "2026-03-10T00:00:00.000Z",
      },
    });

    expect(participantEvents).toEqual([
      {
        id: "p1",
        name: "Pat",
        type: "User",
        handle: "@pat",
        is_remote: true,
        is_external: true,
      },
    ]);
    expect(contactEvents[0]?.payload).toMatchObject({
      is_remote: false,
      is_external: false,
    });
  });

  it("cleans up if startup fails after the adapter starts", async () => {
    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi(),
      }),
    });
    const adapter = {
      onStarted: vi.fn(async () => {}),
      onCleanup: vi.fn(async () => {}),
      onRuntimeStop: vi.fn(async () => {}),
    };

    vi.spyOn(AgentRuntime.prototype, "start").mockRejectedValueOnce(new Error("runtime start failed"));

    await expect(runtime.start(adapter as never)).rejects.toThrow("runtime start failed");
    expect(adapter.onStarted).toHaveBeenCalledOnce();
    expect(adapter.onRuntimeStop).toHaveBeenCalledOnce();
  });

  it("broadcasts only contact_added and contact_removed via ContactEventHandler", async () => {
    const injected: string[] = [];
    const fakeContext = {
      injectSystemMessage: (message: string) => {
        injected.push(message);
      },
    };

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport: new MinimalTransport(),
        restApi: new FakeRestApi(),
      }),
      contactConfig: {
        strategy: "disabled",
        broadcastChanges: true,
      },
    });

    const handler = new ContactEventHandler({
      config: { strategy: "disabled", broadcastChanges: true },
      rest: new FakeRestApi() as never,
      onBroadcast: (message) => {
        for (const ctx of [fakeContext]) {
          ctx.injectSystemMessage(message);
        }
      },
    });

    (runtime as unknown as { contactHandler: ContactEventHandler }).contactHandler = handler;

    const events: ContactEvent[] = [
      {
        type: "contact_request_received",
        roomId: null,
        payload: {
          id: "r1",
          from_handle: "@jane",
          from_name: "Jane",
          message: null,
          status: "pending",
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      },
      {
        type: "contact_request_updated",
        roomId: null,
        payload: { id: "r1", status: "approved" },
      },
      {
        type: "contact_added",
        roomId: null,
        payload: {
          id: "c1",
          handle: "@jane",
          name: "Jane",
          type: "User",
          description: null,
          is_remote: false,
          is_external: false,
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      },
      {
        type: "contact_removed",
        roomId: null,
        payload: { id: "c1" },
      },
    ];

    for (const event of events) {
      await (
        runtime as unknown as {
          handleContactEvent(event: ContactEvent): Promise<void>;
        }
      ).handleContactEvent(event);
    }

    expect(injected).toEqual([
      "[Contacts]: @jane (Jane) is now a contact",
      "[Contacts]: Contact c1 was removed",
    ]);
  });
});

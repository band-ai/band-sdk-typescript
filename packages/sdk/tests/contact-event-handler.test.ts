import { describe, expect, it, vi } from "vitest";

import {
  ContactEventHandler,
  ContactEventHandlerError,
  HUB_ROOM_SYSTEM_PROMPT,
} from "../src/runtime/ContactEventHandler";
import type { ContactEvent, MessageEvent } from "../src/platform/events";
import type { ContactEventConfig } from "../src/runtime/types";

function makeRest() {
  return {
    createChat: vi.fn().mockResolvedValue({ id: "hub-room-1" }),
    createChatEvent: vi.fn().mockResolvedValue({}),
    listContacts: vi.fn().mockResolvedValue({ data: [] }),
    addContact: vi.fn().mockResolvedValue({ ok: true }),
    removeContact: vi.fn().mockResolvedValue({ ok: true }),
    listContactRequests: vi.fn().mockResolvedValue({ received: [], sent: [] }),
    respondContactRequest: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeContactRequestReceived(id = "req-1"): ContactEvent {
  return {
    type: "contact_request_received",
    roomId: null,
    payload: {
      id,
      from_handle: "alice",
      from_name: "Alice",
      message: "Hello!",
      status: "pending",
      inserted_at: new Date().toISOString(),
    },
  };
}

function makeContactRequestUpdated(id = "req-1", status = "accepted"): ContactEvent {
  return {
    type: "contact_request_updated",
    roomId: null,
    payload: { id, status },
  };
}

function makeContactAdded(id = "contact-1"): ContactEvent {
  return {
    type: "contact_added",
    roomId: null,
    payload: {
      id,
      handle: "alice",
      name: "Alice",
      type: "User",
      inserted_at: new Date().toISOString(),
    },
  };
}

function makeContactRemoved(id = "contact-1"): ContactEvent {
  return {
    type: "contact_removed",
    roomId: null,
    payload: { id },
  };
}

describe("ContactEventHandler", () => {
  describe("disabled strategy", () => {
    it("ignores events when strategy is disabled", async () => {
      const onBroadcast = vi.fn();
      const handler = new ContactEventHandler({
        config: { strategy: "disabled" },
        rest: makeRest(),
        onBroadcast,
      });

      await handler.handle(makeContactAdded());
      expect(onBroadcast).not.toHaveBeenCalled();
    });
  });

  describe("callback strategy", () => {
    it("calls onEvent callback with event and contact tools", async () => {
      const onEvent = vi.fn().mockResolvedValue(undefined);
      const config: ContactEventConfig = { strategy: "callback", onEvent };
      const handler = new ContactEventHandler({ config, rest: makeRest() });

      const event = makeContactAdded();
      await handler.handle(event);

      expect(onEvent).toHaveBeenCalledWith(event, expect.objectContaining({
        capabilities: expect.objectContaining({
          contacts: true,
        }),
        sendMessage: expect.any(Function),
        sendEvent: expect.any(Function),
        executeToolCall: expect.any(Function),
        listContacts: expect.any(Function),
        addContact: expect.any(Function),
        removeContact: expect.any(Function),
        listContactRequests: expect.any(Function),
        respondContactRequest: expect.any(Function),
      }));
    });

    it("routes callback tool calls through the adapter-tools surface", async () => {
      const rest = {
        ...makeRest(),
        createChatMessage: vi.fn().mockResolvedValue({ ok: true }),
        listContacts: vi.fn().mockResolvedValue({ data: [] }),
      };
      const onEvent = vi.fn(async (_event, tools) => {
        await tools.sendMessage("hello");
        await tools.executeToolCall("thenvoi_list_contacts", {});
      });
      const config: ContactEventConfig = { strategy: "callback", onEvent };
      const handler = new ContactEventHandler({ config, rest });

      await handler.handle({
        ...makeContactAdded(),
        roomId: "room-1",
      });

      expect(rest.createChatMessage).toHaveBeenCalledWith(
        "room-1",
        { content: "hello" },
        expect.any(Object),
      );
      expect(rest.listContacts).toHaveBeenCalledWith(
        { page: 1, pageSize: 50 },
        expect.any(Object),
      );
    });

    it("rethrows callback errors with retry signal and deterministic logging", async () => {
      const onEvent = vi.fn().mockRejectedValue(new Error("callback failed"));
      const logger = makeLogger();
      const config: ContactEventConfig = { strategy: "callback", onEvent };
      const handler = new ContactEventHandler({ config, rest: makeRest(), logger });

      await expect(handler.handle(makeContactAdded())).rejects.toMatchObject({
        name: "ContactEventHandlerError",
        stage: "callback",
        retryable: false,
        eventType: "contact_added",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "contact_event.failure",
        expect.objectContaining({
          type: "contact_added",
          stage: "callback",
          retryable: false,
          error: expect.objectContaining({
            name: "Error",
            message: "callback failed",
          }),
        }),
      );
    });
  });

  describe("hub_room strategy", () => {
    it("creates hub room and pushes synthetic event", async () => {
      const rest = makeRest();
      const hubEvents: Array<{ roomId: string; event: MessageEvent }> = [];
      const hubInits: Array<{ roomId: string; prompt: string }> = [];

      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
        onHubEvent: async (roomId, event) => {
          hubEvents.push({ roomId, event });
        },
        onHubInit: async (roomId, prompt) => {
          hubInits.push({ roomId, prompt });
        },
      });

      await handler.handle(makeContactRequestReceived());

      expect(rest.createChat).toHaveBeenCalledWith("task-1");
      expect(rest.createChatEvent).toHaveBeenCalled();
      expect(hubEvents).toHaveLength(1);
      expect(hubEvents[0].roomId).toBe("hub-room-1");
      expect(hubInits).toHaveLength(1);
      expect(hubInits[0].prompt).toBe(HUB_ROOM_SYSTEM_PROMPT);
    });

    it("reuses existing hub room on subsequent events", async () => {
      const rest = makeRest();
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      await handler.handle(makeContactRequestReceived("req-1"));
      await handler.handle(makeContactAdded("contact-1"));

      expect(rest.createChat).toHaveBeenCalledTimes(1);
      expect(rest.createChatEvent).toHaveBeenCalledTimes(2);
    });

    it("throws persist failures but still attempts hub dispatch", async () => {
      const rest = makeRest();
      const logger = makeLogger();
      const onHubEvent = vi.fn().mockResolvedValue(undefined);
      rest.createChatEvent.mockRejectedValueOnce(Object.assign(new Error("persist failed"), { retryable: true }));

      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
        onHubEvent,
        logger,
      });

      await expect(handler.handle(makeContactRequestReceived())).rejects.toMatchObject({
        name: "ContactEventHandlerError",
        stage: "hub_room_persist",
        retryable: true,
        eventType: "contact_request_received",
      });
      expect(onHubEvent).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "contact_event.failure",
        expect.objectContaining({
          type: "contact_request_received",
          stage: "hub_room_persist",
          retryable: true,
        }),
      );
    });

    it("throws dispatch failures with retryable signal", async () => {
      const rest = makeRest();
      const logger = makeLogger();
      const onHubEvent = vi.fn().mockRejectedValueOnce(new Error("dispatch failed"));

      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
        onHubEvent,
        logger,
      });

      await expect(handler.handle(makeContactRequestReceived())).rejects.toMatchObject({
        name: "ContactEventHandlerError",
        stage: "hub_room_dispatch",
        retryable: true,
        eventType: "contact_request_received",
      });
      expect(rest.createChatEvent).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "contact_event.failure",
        expect.objectContaining({
          type: "contact_request_received",
          stage: "hub_room_dispatch",
          retryable: true,
        }),
      );
    });
  });

  describe("deduplication", () => {
    it("skips duplicate events", async () => {
      const rest = makeRest();
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      await handler.handle(makeContactAdded("c1"));
      await handler.handle(makeContactAdded("c1"));

      // Only one event should have been persisted (after room creation)
      expect(rest.createChatEvent).toHaveBeenCalledTimes(1);
    });

    it("allows same request with different statuses", async () => {
      const rest = makeRest();
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      await handler.handle(makeContactRequestUpdated("req-1", "accepted"));
      await handler.handle(makeContactRequestUpdated("req-1", "rejected"));

      expect(rest.createChatEvent).toHaveBeenCalledTimes(2);
    });

    it("evicts oldest entries when LRU limit is reached", async () => {
      const rest = makeRest();
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      // Fill dedup cache beyond limit (1000)
      for (let i = 0; i < 1001; i++) {
        await handler.handle(makeContactAdded(`contact-${i}`));
      }

      // The first entry should have been evicted, so re-sending should work
      rest.createChatEvent.mockClear();
      await handler.handle(makeContactAdded("contact-0"));
      expect(rest.createChatEvent).toHaveBeenCalledTimes(1);
    });

    it("allows retry of same event after a handling failure", async () => {
      const rest = makeRest();
      rest.createChatEvent.mockRejectedValueOnce(new Error("transient failure")).mockResolvedValueOnce({});
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      await expect(handler.handle(makeContactAdded("retry-me"))).rejects.toBeInstanceOf(ContactEventHandlerError);
      await expect(handler.handle(makeContactAdded("retry-me"))).resolves.toBeUndefined();
      expect(rest.createChatEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("request cache enrichment", () => {
    it("enriches contact_request_updated with cached sender info", async () => {
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest: makeRest(),
      });

      // First, receive the request to populate cache
      await handler.handle(makeContactRequestReceived("req-1"));

      const formatted = await handler.formatEventMessage(makeContactRequestUpdated("req-1", "accepted"));
      expect(formatted).toContain("Alice");
      expect(formatted).toContain("@alice");
      expect(formatted).toContain("accepted");
      expect(formatted).toContain("Request ID: req-1");
    });

    it("falls back to ID when cache miss", async () => {
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest: makeRest(),
      });

      const formatted = await handler.formatEventMessage(makeContactRequestUpdated("req-99", "rejected"));
      expect(formatted).toContain("req-99");
      expect(formatted).toContain("rejected");
    });

    it("fetches from API on cache miss (received request)", async () => {
      const rest = {
        ...makeRest(),
        listContactRequests: vi.fn().mockResolvedValue({
          received: [
            { id: "req-api", from_handle: "bob", from_name: "Bob", message: null },
          ],
          sent: [],
        }),
      };
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      const formatted = await handler.formatEventMessage(makeContactRequestUpdated("req-api", "approved"));
      expect(formatted).toContain("Bob");
      expect(formatted).toContain("@bob");
      expect(formatted).toContain("approved");
      expect(formatted).toContain("from");
      expect(rest.listContactRequests).toHaveBeenCalledOnce();
    });

    it("fetches from API on cache miss (sent request)", async () => {
      const rest = {
        ...makeRest(),
        listContactRequests: vi.fn().mockResolvedValue({
          received: [],
          sent: [
            { id: "req-sent", to_handle: "carol", to_name: "Carol", message: null },
          ],
        }),
      };
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      const formatted = await handler.formatEventMessage(makeContactRequestUpdated("req-sent", "rejected"));
      expect(formatted).toContain("Carol");
      expect(formatted).toContain("@carol");
      expect(formatted).toContain("to");
      expect(rest.listContactRequests).toHaveBeenCalledOnce();
    });

    it("caches API-fetched results for subsequent lookups", async () => {
      const rest = {
        ...makeRest(),
        listContactRequests: vi.fn().mockResolvedValue({
          received: [
            { id: "req-cached", from_handle: "dave", from_name: "Dave", message: null },
          ],
          sent: [],
        }),
      };
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      await handler.formatEventMessage(makeContactRequestUpdated("req-cached", "approved"));
      await handler.formatEventMessage(makeContactRequestUpdated("req-cached", "confirmed"));
      expect(rest.listContactRequests).toHaveBeenCalledOnce();
    });

    it("degrades gracefully on API failure", async () => {
      const rest = {
        ...makeRest(),
        listContactRequests: vi.fn().mockRejectedValue(new Error("network error")),
      };
      const handler = new ContactEventHandler({
        config: { strategy: "hub_room", hubTaskId: "task-1" },
        rest,
      });

      const formatted = await handler.formatEventMessage(makeContactRequestUpdated("req-fail", "approved"));
      expect(formatted).toContain("req-fail");
      expect(formatted).toContain("approved");
      expect(formatted).not.toContain("undefined");
    });
  });

  describe("broadcast", () => {
    it("broadcasts contact_added and contact_removed events", async () => {
      const onBroadcast = vi.fn();
      const handler = new ContactEventHandler({
        config: { strategy: "callback", broadcastChanges: true, onEvent: vi.fn() },
        rest: makeRest(),
        onBroadcast,
      });

      await handler.handle(makeContactAdded());
      await handler.handle(makeContactRemoved());

      expect(onBroadcast).toHaveBeenCalledTimes(2);
      expect(onBroadcast.mock.calls[0][0]).toContain("is now a contact");
      expect(onBroadcast.mock.calls[1][0]).toContain("was removed");
    });

    it("does not broadcast contact_request events", async () => {
      const onBroadcast = vi.fn();
      const handler = new ContactEventHandler({
        config: { strategy: "callback", broadcastChanges: true, onEvent: vi.fn() },
        rest: makeRest(),
        onBroadcast,
      });

      await handler.handle(makeContactRequestReceived());
      expect(onBroadcast).not.toHaveBeenCalled();
    });
  });

  describe("event formatting", () => {
    it("formats contact_request_received", async () => {
      const handler = new ContactEventHandler({
        config: { strategy: "disabled" },
        rest: makeRest(),
      });

      const msg = await handler.formatEventMessage(makeContactRequestReceived());
      expect(msg).toContain("[Contact Request]");
      expect(msg).toContain("Alice");
      expect(msg).toContain("@alice");
      expect(msg).toContain('Message: "Hello!"');
    });

    it("formats contact_added", async () => {
      const handler = new ContactEventHandler({
        config: { strategy: "disabled" },
        rest: makeRest(),
      });

      const msg = await handler.formatEventMessage(makeContactAdded());
      expect(msg).toContain("[Contact Added]");
      expect(msg).toContain("Alice");
    });

    it("formats contact_removed", async () => {
      const handler = new ContactEventHandler({
        config: { strategy: "disabled" },
        rest: makeRest(),
      });

      const msg = await handler.formatEventMessage(makeContactRemoved());
      expect(msg).toContain("[Contact Removed]");
      expect(msg).toContain("contact-1");
    });
  });
});

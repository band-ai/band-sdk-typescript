import { describe, expect, it, vi } from "vitest";

import { ContactCallbackTools } from "../src/runtime/tools/ContactCallbackTools";
import { ContactToolsImpl } from "../src/runtime/tools/ContactToolsImpl";
import { BLANK_CONTENT_ERROR, BLANK_CONTENT_STATUS, EVENT_SEND_FAILED_STATUS } from "../src/contracts/content";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";

describe("ContactToolsImpl", () => {
  describe("listContacts", () => {
    it("delegates with default pagination", async () => {
      const listContacts = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const impl = new ContactToolsImpl({ listContacts } as never);

      await impl.listContacts();

      expect(listContacts).toHaveBeenCalledWith({ page: 1, pageSize: 50 }, expect.anything());
    });

    it("passes through an explicit page/pageSize", async () => {
      const listContacts = vi.fn().mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 });
      const impl = new ContactToolsImpl({ listContacts } as never);

      await impl.listContacts({ page: 2, pageSize: 10 });

      expect(listContacts).toHaveBeenCalledWith({ page: 2, pageSize: 10 }, expect.anything());
    });

    it("throws UnsupportedFeatureError when the REST adapter has no listContacts", async () => {
      const impl = new ContactToolsImpl({} as never);
      await expect(impl.listContacts()).rejects.toThrow(UnsupportedFeatureError);
    });
  });

  describe("addContact", () => {
    it("trims the handle and omits message when absent", async () => {
      const addContact = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ addContact } as never);

      await impl.addContact({ handle: "  bob  " });

      expect(addContact).toHaveBeenCalledWith({ handle: "bob" }, expect.anything());
    });

    it("includes a non-empty message", async () => {
      const addContact = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ addContact } as never);

      await impl.addContact({ handle: "bob", message: "hi" });

      expect(addContact).toHaveBeenCalledWith({ handle: "bob", message: "hi" }, expect.anything());
    });

    it("throws ValidationError for a blank handle", async () => {
      const impl = new ContactToolsImpl({ addContact: vi.fn() } as never);
      await expect(impl.addContact({ handle: "   " })).rejects.toThrow(ValidationError);
    });

    it("throws UnsupportedFeatureError when the REST adapter has no addContact", async () => {
      const impl = new ContactToolsImpl({} as never);
      await expect(impl.addContact({ handle: "bob" })).rejects.toThrow(UnsupportedFeatureError);
    });
  });

  describe("removeContact", () => {
    it("removes by trimmed handle", async () => {
      const removeContact = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ removeContact } as never);

      await impl.removeContact({ target: "handle", handle: "  bob  " });

      expect(removeContact).toHaveBeenCalledWith({ target: "handle", handle: "bob" }, expect.anything());
    });

    it("throws ValidationError for a blank handle", async () => {
      const impl = new ContactToolsImpl({ removeContact: vi.fn() } as never);
      await expect(impl.removeContact({ target: "handle", handle: "  " })).rejects.toThrow(ValidationError);
    });

    it("removes by trimmed contactId", async () => {
      const removeContact = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ removeContact } as never);

      await impl.removeContact({ target: "contactId", contactId: "  c-1  " });

      expect(removeContact).toHaveBeenCalledWith({ target: "contactId", contactId: "c-1" }, expect.anything());
    });

    it("throws ValidationError for a blank contactId", async () => {
      const impl = new ContactToolsImpl({ removeContact: vi.fn() } as never);
      await expect(impl.removeContact({ target: "contactId", contactId: "  " })).rejects.toThrow(ValidationError);
    });

    it("throws UnsupportedFeatureError when the REST adapter has no removeContact", async () => {
      const impl = new ContactToolsImpl({} as never);
      await expect(impl.removeContact({ target: "handle", handle: "bob" })).rejects.toThrow(UnsupportedFeatureError);
    });
  });

  describe("listContactRequests", () => {
    it("defaults sentStatus to 'pending' and applies default pagination", async () => {
      const listContactRequests = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const impl = new ContactToolsImpl({ listContactRequests } as never);

      await impl.listContactRequests();

      expect(listContactRequests).toHaveBeenCalledWith(
        { page: 1, pageSize: 50, sentStatus: "pending" },
        expect.anything(),
      );
    });

    it("throws UnsupportedFeatureError when the REST adapter has no listContactRequests", async () => {
      const impl = new ContactToolsImpl({} as never);
      await expect(impl.listContactRequests()).rejects.toThrow(UnsupportedFeatureError);
    });
  });

  describe("respondContactRequest", () => {
    it("responds by trimmed handle", async () => {
      const respondContactRequest = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ respondContactRequest } as never);

      await impl.respondContactRequest({ action: "approve", target: "handle", handle: "  bob  " });

      expect(respondContactRequest).toHaveBeenCalledWith(
        { action: "approve", target: "handle", handle: "bob" },
        expect.anything(),
      );
    });

    it("throws ValidationError for a blank handle", async () => {
      const impl = new ContactToolsImpl({ respondContactRequest: vi.fn() } as never);
      await expect(
        impl.respondContactRequest({ action: "approve", target: "handle", handle: "  " }),
      ).rejects.toThrow(ValidationError);
    });

    it("responds by trimmed requestId", async () => {
      const respondContactRequest = vi.fn().mockResolvedValue({ success: true });
      const impl = new ContactToolsImpl({ respondContactRequest } as never);

      await impl.respondContactRequest({ action: "reject", target: "requestId", requestId: "  r-1  " });

      expect(respondContactRequest).toHaveBeenCalledWith(
        { action: "reject", target: "requestId", requestId: "r-1" },
        expect.anything(),
      );
    });

    it("throws ValidationError for a blank requestId", async () => {
      const impl = new ContactToolsImpl({ respondContactRequest: vi.fn() } as never);
      await expect(
        impl.respondContactRequest({ action: "approve", target: "requestId", requestId: "  " }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws UnsupportedFeatureError when the REST adapter has no respondContactRequest", async () => {
      const impl = new ContactToolsImpl({} as never);
      await expect(
        impl.respondContactRequest({ action: "approve", target: "handle", handle: "bob" }),
      ).rejects.toThrow(UnsupportedFeatureError);
    });
  });
});

describe("ContactCallbackTools", () => {
  describe("capabilities projection", () => {
    it("is false across the board with a bare rest adapter", () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      expect(tools.capabilities).toEqual({ peers: false, contacts: false, memory: false });
    });

    it("flips on peers/contacts/memory when the underlying methods exist", () => {
      const tools = new ContactCallbackTools(
        { createChat: vi.fn(), listPeers: vi.fn(), addContact: vi.fn(), listMemories: vi.fn() } as never,
        "room-1",
      );
      expect(tools.capabilities).toEqual({ peers: true, contacts: true, memory: true });
    });
  });

  describe("sendMessage", () => {
    it("throws when there is no room context", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatMessage: vi.fn() } as never, null);
      await expect(tools.sendMessage("hi")).rejects.toThrow(UnsupportedFeatureError);
    });

    it("throws when the REST adapter has no createChatMessage", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.sendMessage("hi")).rejects.toThrow(UnsupportedFeatureError);
    });

    it("rejects string mentions (unavailable for contact callbacks)", async () => {
      const createChatMessage = vi.fn();
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatMessage } as never, "room-1");
      await expect(tools.sendMessage("hi", ["@bob"])).rejects.toThrow(UnsupportedFeatureError);
      expect(createChatMessage).not.toHaveBeenCalled();
    });

    it("sends structured mentions and plain content", async () => {
      const createChatMessage = vi.fn().mockResolvedValue({ success: true });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatMessage } as never, "room-1");

      await tools.sendMessage("hi", [{ id: "u-1", name: "Bob" }]);

      expect(createChatMessage).toHaveBeenCalledWith(
        "room-1",
        { content: "hi", mentions: [{ id: "u-1", name: "Bob" }] },
      );
    });

    it("omits mentions entirely when none are given", async () => {
      const createChatMessage = vi.fn().mockResolvedValue({ success: true });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatMessage } as never, "room-1");

      await tools.sendMessage("hi");

      expect(createChatMessage).toHaveBeenCalledWith("room-1", { content: "hi" });
    });

    it("throws instead of silently accepting a transport blank-content refusal", async () => {
      const createChatMessage = vi.fn().mockResolvedValue({
        ok: false,
        status: BLANK_CONTENT_STATUS,
        error: `content ${BLANK_CONTENT_ERROR}`,
      });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatMessage } as never, "room-1");

      // Zero-width space: a real-world blank the platform rejects; the fake refuses unconditionally regardless.
      const zeroWidthSpace = "\u200B";
      const error = await tools.sendMessage(zeroWidthSpace).catch((caught) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(`content ${BLANK_CONTENT_ERROR}`);
    });
  });

  describe("sendEvent", () => {
    it("throws when there is no room context", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, null);
      await expect(tools.sendEvent("hi", "task")).rejects.toThrow(UnsupportedFeatureError);
    });

    it("throws when the REST adapter has no createChatEvent", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.sendEvent("hi", "task")).rejects.toThrow(UnsupportedFeatureError);
    });

    it("includes metadata when given, omits it otherwise", async () => {
      const createChatEvent = vi.fn().mockResolvedValue({ success: true });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatEvent } as never, "room-1");

      await tools.sendEvent("hi", "task", { key: "value" });
      expect(createChatEvent).toHaveBeenCalledWith(
        "room-1",
        { content: "hi", messageType: "task", metadata: { key: "value" } },
      );

      await tools.sendEvent("hi", "task");
      expect(createChatEvent).toHaveBeenLastCalledWith(
        "room-1",
        { content: "hi", messageType: "task" },
      );
    });

    it("resolves a transport blank-content refusal instead of throwing (room telemetry, not the agent's answer)", async () => {
      const createChatEvent = vi.fn().mockResolvedValue({
        ok: false,
        status: BLANK_CONTENT_STATUS,
        error: `content ${BLANK_CONTENT_ERROR}`,
      });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatEvent } as never, "room-1");

      const zeroWidthSpace = "\u200B";
      await expect(tools.sendEvent(zeroWidthSpace, "task")).resolves.toEqual({
        ok: false,
        status: BLANK_CONTENT_STATUS,
        error: `content ${BLANK_CONTENT_ERROR}`,
      });
    });

    it("resolves instead of throwing when the transport call itself rejects", async () => {
      const createChatEvent = vi.fn().mockRejectedValue(new Error("network error"));
      const tools = new ContactCallbackTools({ createChat: vi.fn(), createChatEvent } as never, "room-1");

      await expect(tools.sendEvent("thinking", "thought")).resolves.toEqual({
        ok: false,
        status: EVENT_SEND_FAILED_STATUS,
      });
    });
  });

  describe("participant management", () => {
    it("addParticipant and removeParticipant are always unsupported for contact callbacks", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.addParticipant()).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.removeParticipant()).rejects.toThrow(UnsupportedFeatureError);
    });

    it("getParticipants throws with no room context", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, null);
      await expect(tools.getParticipants()).rejects.toThrow(UnsupportedFeatureError);
    });

    it("getParticipants throws when the REST adapter has no listChatParticipants", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.getParticipants()).rejects.toThrow(UnsupportedFeatureError);
    });

    it("getParticipants maps handle present/null (rename regression guard)", async () => {
      const listChatParticipants = vi.fn().mockResolvedValue([
        { id: "u-1", name: "Bob", type: "user", handle: "bob.h" },
        { id: "u-2", name: "Ann", type: "user" },
      ]);
      const tools = new ContactCallbackTools({ createChat: vi.fn(), listChatParticipants } as never, "room-1");

      const participants = await tools.getParticipants();

      expect(participants).toEqual([
        { id: "u-1", name: "Bob", type: "user", handle: "bob.h" },
        { id: "u-2", name: "Ann", type: "user", handle: null },
      ]);
    });
  });

  describe("createChatroom", () => {
    it("returns the created chat's id", async () => {
      const createChat = vi.fn().mockResolvedValue({ id: "room-9" });
      const tools = new ContactCallbackTools({ createChat } as never, null);

      await expect(tools.createChatroom("task-1")).resolves.toBe("room-9");
      expect(createChat).toHaveBeenCalledWith("task-1", expect.anything());
    });
  });

  describe("lookupPeers", () => {
    it("throws when the REST adapter has no listPeers", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.lookupPeers()).rejects.toThrow(UnsupportedFeatureError);
    });

    it("normalizes page/pageSize defaults and excludes the current room", async () => {
      const listPeers = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), listPeers } as never, "room-1");

      await tools.lookupPeers();

      expect(listPeers).toHaveBeenCalledWith(
        { page: 1, pageSize: 50, notInChat: "room-1" },
        expect.anything(),
      );
    });

    it("normalizes invalid page/pageSize (zero, negative, non-integer) back to defaults", async () => {
      const listPeers = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), listPeers } as never, null);

      await tools.lookupPeers(0, -5);

      expect(listPeers).toHaveBeenCalledWith(
        { page: 1, pageSize: 50, notInChat: "" },
        expect.anything(),
      );
    });

    it("passes through explicit valid page/pageSize", async () => {
      const listPeers = vi.fn().mockResolvedValue({ items: [], page: 3, pageSize: 20, total: 0 });
      const tools = new ContactCallbackTools({ createChat: vi.fn(), listPeers } as never, "room-1");

      await tools.lookupPeers(3, 20);

      expect(listPeers).toHaveBeenCalledWith(
        { page: 3, pageSize: 20, notInChat: "room-1" },
        expect.anything(),
      );
    });
  });

  it("exposes empty tool schema arrays", () => {
    const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
    expect(tools.getToolSchemas()).toEqual([]);
    expect(tools.getAnthropicToolSchemas()).toEqual([]);
    expect(tools.getOpenAIToolSchemas()).toEqual([]);
  });

  describe("contact target validation/dispatch", () => {
    it("throws UnsupportedFeatureError for every contact method when no contact REST methods exist", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.listContacts()).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.addContact({ handle: "bob" })).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.removeContact({ target: "handle", handle: "bob" })).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.listContactRequests()).rejects.toThrow(UnsupportedFeatureError);
      await expect(
        tools.respondContactRequest({ action: "approve", target: "handle", handle: "bob" }),
      ).rejects.toThrow(UnsupportedFeatureError);
    });

    it("delegates every contact method to the internal ContactToolsImpl once contact REST methods exist", async () => {
      const listContacts = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const addContact = vi.fn().mockResolvedValue({ success: true });
      const removeContact = vi.fn().mockResolvedValue({ success: true });
      const listContactRequests = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const respondContactRequest = vi.fn().mockResolvedValue({ success: true });
      const tools = new ContactCallbackTools(
        { createChat: vi.fn(), listContacts, addContact, removeContact, listContactRequests, respondContactRequest } as never,
        "room-1",
      );

      await tools.listContacts();
      expect(listContacts).toHaveBeenCalled();

      await tools.addContact({ handle: "bob" });
      expect(addContact).toHaveBeenCalled();

      await tools.removeContact({ target: "handle", handle: "bob" });
      expect(removeContact).toHaveBeenCalled();

      await tools.listContactRequests();
      expect(listContactRequests).toHaveBeenCalled();

      await tools.respondContactRequest({ action: "approve", target: "handle", handle: "bob" });
      expect(respondContactRequest).toHaveBeenCalled();
    });
  });

  describe("memory dispatch", () => {
    it("throws UnsupportedFeatureError for every memory method when unavailable", async () => {
      const tools = new ContactCallbackTools({ createChat: vi.fn() } as never, "room-1");
      await expect(tools.listMemories()).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.storeMemory({ content: "x", system: "s", type: "note", segment: "seg" } as never)).rejects.toThrow(
        UnsupportedFeatureError,
      );
      await expect(tools.getMemory("m-1")).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.supersedeMemory("m-1")).rejects.toThrow(UnsupportedFeatureError);
      await expect(tools.archiveMemory("m-1")).rejects.toThrow(UnsupportedFeatureError);
    });

    it("delegates every memory method to the REST adapter once available", async () => {
      const listMemories = vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
      const storeMemory = vi.fn().mockResolvedValue({ id: "m-1" });
      const getMemory = vi.fn().mockResolvedValue({ id: "m-1" });
      const supersedeMemory = vi.fn().mockResolvedValue({ success: true });
      const archiveMemory = vi.fn().mockResolvedValue({ success: true });
      const tools = new ContactCallbackTools(
        { createChat: vi.fn(), listMemories, storeMemory, getMemory, supersedeMemory, archiveMemory } as never,
        "room-1",
      );

      await tools.listMemories();
      expect(listMemories).toHaveBeenCalled();

      await tools.storeMemory({ content: "x", system: "s", type: "note", segment: "seg" } as never);
      expect(storeMemory).toHaveBeenCalled();

      await tools.getMemory("m-1");
      expect(getMemory).toHaveBeenCalledWith("m-1", expect.anything());

      await tools.supersedeMemory("m-1");
      expect(supersedeMemory).toHaveBeenCalledWith("m-1", expect.anything());

      await tools.archiveMemory("m-1");
      expect(archiveMemory).toHaveBeenCalledWith("m-1", expect.anything());
    });
  });

  describe("executeToolCall", () => {
    function toolsWithFullRest() {
      const rest = {
        createChat: vi.fn().mockResolvedValue({ id: "room-1" }),
        createChatMessage: vi.fn().mockResolvedValue({ success: true }),
        createChatEvent: vi.fn().mockResolvedValue({ success: true }),
        listChatParticipants: vi.fn().mockResolvedValue([]),
        listPeers: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
        listContacts: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
        addContact: vi.fn().mockResolvedValue({ success: true }),
        removeContact: vi.fn().mockResolvedValue({ success: true }),
        listContactRequests: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
        respondContactRequest: vi.fn().mockResolvedValue({ success: true }),
        listMemories: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
        storeMemory: vi.fn().mockResolvedValue({ id: "m-1" }),
        getMemory: vi.fn().mockResolvedValue({ id: "m-1" }),
        supersedeMemory: vi.fn().mockResolvedValue({ success: true }),
        archiveMemory: vi.fn().mockResolvedValue({ success: true }),
      };
      return { rest, tools: new ContactCallbackTools(rest as never, "room-1") };
    }

    it("dispatches band_send_message", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_send_message", { content: "hi" });
      expect(rest.createChatMessage).toHaveBeenCalled();
    });

    it("dispatches band_send_event with default message_type", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_send_event", { content: "hi" });
      expect(rest.createChatEvent).toHaveBeenCalledWith(
        "room-1",
        { content: "hi", messageType: "task" },
      );
    });

    it("dispatches band_get_participants, band_create_chatroom, band_lookup_peers", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_get_participants", {});
      expect(rest.listChatParticipants).toHaveBeenCalled();

      await tools.executeToolCall("band_create_chatroom", { task_id: "t-1" });
      expect(rest.createChat).toHaveBeenCalledWith("t-1", expect.anything());

      await tools.executeToolCall("band_lookup_peers", { page: 2, page_size: 5 });
      expect(rest.listPeers).toHaveBeenCalledWith({ page: 2, pageSize: 5, notInChat: "room-1" }, expect.anything());
    });

    it("dispatches band_list_contacts and band_add_contact", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_list_contacts", { page: 1, page_size: 10 });
      expect(rest.listContacts).toHaveBeenCalledWith({ page: 1, pageSize: 10 }, expect.anything());

      await tools.executeToolCall("band_add_contact", { handle: "bob", message: "hi" });
      expect(rest.addContact).toHaveBeenCalledWith({ handle: "bob", message: "hi" }, expect.anything());
    });

    it("dispatches band_remove_contact by contact_id when given, else by handle", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_remove_contact", { contact_id: "c-1" });
      expect(rest.removeContact).toHaveBeenCalledWith({ target: "contactId", contactId: "c-1" }, expect.anything());

      await tools.executeToolCall("band_remove_contact", { handle: "bob" });
      expect(rest.removeContact).toHaveBeenLastCalledWith({ target: "handle", handle: "bob" }, expect.anything());
    });

    it("dispatches band_list_contact_requests", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_list_contact_requests", { page: 1, page_size: 10, sent_status: "pending" });
      expect(rest.listContactRequests).toHaveBeenCalledWith(
        { page: 1, pageSize: 10, sentStatus: "pending" },
        expect.anything(),
      );
    });

    it("dispatches band_respond_contact_request by request_id when given, else by handle", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_respond_contact_request", { request_id: "r-1", action: "approve" });
      expect(rest.respondContactRequest).toHaveBeenCalledWith(
        { action: "approve", target: "requestId", requestId: "r-1" },
        expect.anything(),
      );

      await tools.executeToolCall("band_respond_contact_request", { handle: "bob", action: "reject" });
      expect(rest.respondContactRequest).toHaveBeenLastCalledWith(
        { action: "reject", target: "handle", handle: "bob" },
        expect.anything(),
      );
    });

    it("dispatches band_list_memories, band_store_memory, band_get_memory, band_supersede_memory, band_archive_memory", async () => {
      const { rest, tools } = toolsWithFullRest();
      await tools.executeToolCall("band_list_memories", {});
      expect(rest.listMemories).toHaveBeenCalled();

      await tools.executeToolCall("band_store_memory", { content: "x", system: "s", type: "note", segment: "seg" });
      expect(rest.storeMemory).toHaveBeenCalled();

      await tools.executeToolCall("band_get_memory", { memory_id: "m-1" });
      expect(rest.getMemory).toHaveBeenCalledWith("m-1", expect.anything());

      await tools.executeToolCall("band_supersede_memory", { memory_id: "m-1" });
      expect(rest.supersedeMemory).toHaveBeenCalledWith("m-1", expect.anything());

      await tools.executeToolCall("band_archive_memory", { memory_id: "m-1" });
      expect(rest.archiveMemory).toHaveBeenCalledWith("m-1", expect.anything());
    });

    it("throws UnsupportedFeatureError for an unrecognized tool name", async () => {
      const { tools } = toolsWithFullRest();
      await expect(tools.executeToolCall("band_unknown_tool", {})).rejects.toThrow(UnsupportedFeatureError);
    });
  });
});

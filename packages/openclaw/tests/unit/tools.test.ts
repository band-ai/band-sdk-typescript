/**
 * Unit tests for the Band management tools.
 *
 * Uses hand-rolled vi.fn() RestApi spies (NOT StubRestApi, which is a no-op
 * example stub that ignores args and omits the optional contact methods).
 */

import { describe, it, expect, vi } from "vitest";
import {
  bandTools,
  getBandTool,
  executeBandTool,
  type BandToolContext,
} from "../../src/tools.js";

const SELF = "agent-self";

/** Build a fake rest with vi.fn() spies; override per test. */
function makeCtx(overrides: Record<string, unknown> = {}): BandToolContext {
  const rest = {
    listPeers: vi.fn(),
    addChatParticipant: vi.fn().mockResolvedValue({ ok: true }),
    removeChatParticipant: vi.fn().mockResolvedValue(undefined),
    listChatParticipants: vi.fn().mockResolvedValue([]),
    createChat: vi.fn().mockResolvedValue({ id: "room-new" }),
    createChatEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    listContacts: vi.fn(),
    addContact: vi.fn(),
    removeContact: vi.fn().mockResolvedValue(undefined),
    listContactRequests: vi.fn(),
    respondContactRequest: vi.fn(),
    ...overrides,
  };
  return { rest: rest as unknown as BandToolContext["rest"], selfAgentId: SELF };
}

const run = (name: string, ctx: BandToolContext, params: unknown) =>
  executeBandTool(ctx, name, params);

describe("tool registry", () => {
  it("exposes exactly the 12 band_* management tools (no band_send_message)", () => {
    const names = bandTools.map((t) => t.name);
    expect(names).toEqual([
      "band_lookup_peers",
      "band_add_participant",
      "band_remove_participant",
      "band_get_participants",
      "band_create_chatroom",
      "band_send_event",
      "band_list_chats",
      "band_list_contacts",
      "band_add_contact",
      "band_remove_contact",
      "band_list_contact_requests",
      "band_respond_contact_request",
    ]);
    expect(names).not.toContain("band_send_message");
    expect(names).toHaveLength(12);
  });

  it("executeBandTool throws on an unknown tool", async () => {
    await expect(run("band_nope", makeCtx(), {})).rejects.toThrow(/unknown tool/i);
  });
});

describe("band_lookup_peers", () => {
  it("maps peers and computes has_more from metadata", async () => {
    const ctx = makeCtx({
      listPeers: vi.fn().mockResolvedValue({
        data: [{ id: "p1", handle: "@p1", name: "P1", type: "agent", description: "d" }],
        metadata: { totalCount: 3, page: 1, totalPages: 2 },
      }),
    });
    const res = (await run("band_lookup_peers", ctx, { page: 1, page_size: 50 })) as {
      peers: unknown[]; total: number; has_more: boolean;
    };
    expect(res.peers).toEqual([{ id: "p1", handle: "@p1", name: "P1", type: "agent", description: "d" }]);
    expect(res.total).toBe(3);
    expect(res.has_more).toBe(true);
  });

  it("clamps page_size to <= 100", async () => {
    const listPeers = vi.fn().mockResolvedValue({ data: [], metadata: {} });
    await run("band_lookup_peers", makeCtx({ listPeers }), { page: 0, page_size: 999 });
    expect(listPeers).toHaveBeenCalledWith({ page: 1, pageSize: 100, notInChat: "" });
  });
});

describe("band_add_participant", () => {
  it("resolves a handle across multiple pages, then adds the participant", async () => {
    const listPeers = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "x", name: "other", handle: "@other" }], metadata: { page: 1, totalPages: 2 } })
      .mockResolvedValueOnce({ data: [{ id: "u-bob", name: "bob", handle: "@bob", type: "agent" }], metadata: { page: 2, totalPages: 2 } });
    const addChatParticipant = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx({ listPeers, addChatParticipant });

    const res = (await run("band_add_participant", ctx, { room_id: "r1", handle: "@bob" })) as { success: boolean; participant: { id: string } };
    expect(res.success).toBe(true);
    expect(res.participant.id).toBe("u-bob");
    expect(addChatParticipant).toHaveBeenCalledWith("r1", { participantId: "u-bob", role: "member" });
    expect(listPeers).toHaveBeenCalledTimes(2);
  });

  it("throws when the peer cannot be found", async () => {
    const listPeers = vi.fn().mockResolvedValue({ data: [], metadata: { page: 1, totalPages: 1 } });
    await expect(run("band_add_participant", makeCtx({ listPeers }), { room_id: "r1", handle: "@ghost" }))
      .rejects.toThrow(/peer not found/i);
  });
});

describe("band_remove_participant", () => {
  it("resolves a name to id (excluding self), then removes", async () => {
    const listChatParticipants = vi.fn().mockResolvedValue([
      { id: SELF, name: "Me", type: "agent" },
      { id: "u-bob", name: "Bob", type: "user" },
    ]);
    const removeChatParticipant = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ listChatParticipants, removeChatParticipant });
    const res = (await run("band_remove_participant", ctx, { room_id: "r1", name: "Bob" })) as { success: boolean };
    expect(res.success).toBe(true);
    expect(removeChatParticipant).toHaveBeenCalledWith("r1", "u-bob");
  });

  it("uses participant_id directly without resolution", async () => {
    const listChatParticipants = vi.fn();
    const removeChatParticipant = vi.fn().mockResolvedValue(undefined);
    await run("band_remove_participant", makeCtx({ listChatParticipants, removeChatParticipant }), { room_id: "r1", participant_id: "u-x" });
    expect(removeChatParticipant).toHaveBeenCalledWith("r1", "u-x");
    expect(listChatParticipants).not.toHaveBeenCalled();
  });

  it("throws when neither name nor participant_id is given", async () => {
    await expect(run("band_remove_participant", makeCtx(), { room_id: "r1" })).rejects.toThrow(/name or participant_id/i);
  });

  it("throws when the named participant is not found", async () => {
    const listChatParticipants = vi.fn().mockResolvedValue([{ id: SELF, name: "Me", type: "agent" }]);
    await expect(run("band_remove_participant", makeCtx({ listChatParticipants }), { room_id: "r1", name: "Ghost" }))
      .rejects.toThrow(/not found/i);
  });
});

describe("band_get_participants / band_create_chatroom / band_send_event", () => {
  it("get_participants maps and counts", async () => {
    const listChatParticipants = vi.fn().mockResolvedValue([{ id: "a", name: "A", type: "user" }]);
    const res = (await run("band_get_participants", makeCtx({ listChatParticipants }), { room_id: "r1" })) as { count: number };
    expect(res.count).toBe(1);
  });

  it("create_chatroom returns the new room id", async () => {
    const res = (await run("band_create_chatroom", makeCtx(), {})) as { room_id: string };
    expect(res.room_id).toBe("room-new");
  });

  it("send_event forwards message_type as messageType", async () => {
    const createChatEvent = vi.fn().mockResolvedValue({ id: "evt-9" });
    await run("band_send_event", makeCtx({ createChatEvent }), { room_id: "r1", content: "thinking", message_type: "thought" });
    expect(createChatEvent).toHaveBeenCalledWith("r1", { content: "thinking", messageType: "thought", metadata: undefined });
  });

  it("send_event rejects an unknown message_type without calling REST", async () => {
    const createChatEvent = vi.fn();
    await expect(
      run("band_send_event", makeCtx({ createChatEvent }), { room_id: "r1", content: "x", message_type: "BOGUS" }),
    ).rejects.toThrow(/invalid message_type/i);
    expect(createChatEvent).not.toHaveBeenCalled();
  });

  it("list_chats maps room id/name/type and clamps pagination", async () => {
    const listChats = vi.fn().mockResolvedValue({
      data: [{ id: "room-1", name: "Room One", type: "group" }],
      metadata: { page: 1, totalPages: 1 },
    });
    const res = (await run("band_list_chats", makeCtx({ listChats }), { page: 0, page_size: 999 })) as {
      chats: Array<{ id: string; name: string; type: string }>;
    };
    expect(res.chats).toEqual([{ id: "room-1", name: "Room One", type: "group" }]);
    // page floored to >=1, page_size capped at 100
    expect(listChats).toHaveBeenCalledWith({ page: 1, pageSize: 100 });
  });
});

describe("contacts", () => {
  it("list_contacts maps data", async () => {
    const listContacts = vi.fn().mockResolvedValue({ data: [{ id: "c1", handle: "@c", name: "C", type: "user" }], metadata: { page: 1 } });
    const res = (await run("band_list_contacts", makeCtx({ listContacts }), {})) as { contacts: unknown[] };
    expect(res.contacts).toEqual([{ id: "c1", handle: "@c", name: "C", type: "user" }]);
  });

  it("list_contacts throws when the optional REST method is absent (requireMethod guard)", async () => {
    await expect(run("band_list_contacts", makeCtx({ listContacts: undefined }), {}))
      .rejects.toThrow(/listContacts.*not available/i);
  });

  it("add_contact forwards handle + message", async () => {
    const addContact = vi.fn().mockResolvedValue({ status: "pending" });
    const res = (await run("band_add_contact", makeCtx({ addContact }), { handle: "@x", message: "hi" })) as { status: string };
    expect(addContact).toHaveBeenCalledWith({ handle: "@x", message: "hi" });
    expect(res.status).toBe("pending");
  });

  it("remove_contact throws without handle or contact_id, and builds handle args", async () => {
    await expect(run("band_remove_contact", makeCtx(), {})).rejects.toThrow(/handle or contact_id/i);
    const removeContact = vi.fn().mockResolvedValue(undefined);
    await run("band_remove_contact", makeCtx({ removeContact }), { handle: "@x" });
    expect(removeContact).toHaveBeenCalledWith({ target: "handle", handle: "@x" });
  });

  it("list_contact_requests maps received and sent", async () => {
    const listContactRequests = vi.fn().mockResolvedValue({
      received: [{ id: "r1", from_handle: "@f", from_name: "F", message: "m", status: "pending" }],
      sent: [{ id: "s1", to_handle: "@t", to_name: "T", message: "m2", status: "pending" }],
      metadata: { page: 1 },
    });
    const res = (await run("band_list_contact_requests", makeCtx({ listContactRequests }), {})) as { received: unknown[]; sent: unknown[] };
    expect(res.received).toHaveLength(1);
    expect(res.sent).toHaveLength(1);
  });

  it("respond_contact_request throws without handle/request_id and builds requestId args", async () => {
    await expect(run("band_respond_contact_request", makeCtx(), { action: "approve" })).rejects.toThrow(/handle or request_id/i);
    const respondContactRequest = vi.fn().mockResolvedValue({ status: "approved" });
    await run("band_respond_contact_request", makeCtx({ respondContactRequest }), { action: "approve", request_id: "req-1" });
    expect(respondContactRequest).toHaveBeenCalledWith({ action: "approve", target: "requestId", requestId: "req-1" });
  });
});

describe("getBandTool", () => {
  it("returns a tool by name and undefined for unknown", () => {
    expect(getBandTool("band_lookup_peers")?.name).toBe("band_lookup_peers");
    expect(getBandTool("nope")).toBeUndefined();
  });
});

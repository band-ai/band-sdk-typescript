import { describe, expect, it, vi } from "vitest";

import type { AdapterToolsProtocol } from "@band-ai/sdk/core";

import { LastSenderTracker, resolveMentionFallback, wrapToolsForMentionFallback } from "../src/mentions";

const SELF_ID = "3d5bd75e-1111-4c22-9e2b-8f1a2b3c4d5e";
const OWNER = { id: "owner-1", name: "Nir", handle: "nir" };
const OTHER = { id: "other-1", name: "Someone Else", handle: null };

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("LastSenderTracker", () => {
  it("tracks and returns the last sender per room independently", () => {
    const tracker = new LastSenderTracker();
    tracker.track("room-1", { senderId: "a", senderName: "Alice" });
    tracker.track("room-2", { senderId: "b", senderName: "Bob" });
    tracker.track("room-1", { senderId: "c", senderName: "Carl" });

    expect(tracker.get("room-1")).toEqual({ senderId: "c", senderName: "Carl" });
    expect(tracker.get("room-2")).toEqual({ senderId: "b", senderName: "Bob" });
    expect(tracker.get("room-3")).toBeUndefined();
  });
});

describe("resolveMentionFallback", () => {
  it("prefers the last sender when they're still a participant", () => {
    expect(
      resolveMentionFallback([OWNER, OTHER], SELF_ID, { senderId: OWNER.id, senderName: OWNER.name }),
    ).toBe("nir");
  });

  it("uses the id when the last sender has no handle", () => {
    expect(
      resolveMentionFallback([OTHER], SELF_ID, { senderId: OTHER.id, senderName: OTHER.name }),
    ).toBe(OTHER.id);
  });

  it("falls back to the first other participant when there's no last sender", () => {
    expect(resolveMentionFallback([OWNER, OTHER], SELF_ID, null)).toBe("nir");
  });

  it("falls back to the first other participant when the last sender left the room", () => {
    expect(
      resolveMentionFallback([OTHER], SELF_ID, { senderId: "departed", senderName: "Gone" }),
    ).toBe(OTHER.id);
  });

  it("returns undefined in an agent-only room", () => {
    expect(resolveMentionFallback([{ id: SELF_ID, name: "This Agent" }], SELF_ID, null)).toBeUndefined();
  });

  it("never resolves to self", () => {
    const self = { id: SELF_ID, name: "This Agent", handle: "this-agent" };
    expect(resolveMentionFallback([self, OWNER], SELF_ID, { senderId: SELF_ID, senderName: "This Agent" })).toBe(
      "nir",
    );
  });
});

function fakeAdapterTools(executeToolCall: (toolName: string, args: unknown) => Promise<unknown>): AdapterToolsProtocol {
  return { executeToolCall } as unknown as AdapterToolsProtocol;
}

describe("wrapToolsForMentionFallback", () => {
  it("passes an explicit mentions array through unchanged", async () => {
    const executeToolCall = vi.fn().mockResolvedValue({ status: "sent" });
    const tools = fakeAdapterTools(executeToolCall);
    const listParticipants = vi.fn();
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants,
      selfId: SELF_ID,
      lastSenderTracker: new LastSenderTracker(),
      logger: noopLogger,
    });

    await wrapped.executeToolCall("band_send_message", { content: "hi", mentions: ["nir"] });

    expect(listParticipants).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hi", mentions: ["nir"] });
  });

  it("injects the last sender's handle when mentions is empty", async () => {
    const executeToolCall = vi.fn().mockResolvedValue({ status: "sent" });
    const tools = fakeAdapterTools(executeToolCall);
    const lastSenderTracker = new LastSenderTracker();
    lastSenderTracker.track("room-1", { senderId: OWNER.id, senderName: OWNER.name });
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants: async () => [OWNER, OTHER],
      selfId: SELF_ID,
      lastSenderTracker,
      logger: noopLogger,
    });

    await wrapped.executeToolCall("band_send_message", { content: "hi", mentions: [] });

    expect(executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hi", mentions: ["nir"] });
  });

  it("injects the last sender's handle when mentions is missing entirely", async () => {
    const executeToolCall = vi.fn().mockResolvedValue({ status: "sent" });
    const tools = fakeAdapterTools(executeToolCall);
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants: async () => [OWNER],
      selfId: SELF_ID,
      lastSenderTracker: new LastSenderTracker(),
      logger: noopLogger,
    });

    await wrapped.executeToolCall("band_send_message", { content: "hi" });

    expect(executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hi", mentions: ["nir"] });
  });

  it("leaves mentions empty in an agent-only room (nothing to fall back to)", async () => {
    const executeToolCall = vi.fn().mockResolvedValue({ status: "sent" });
    const tools = fakeAdapterTools(executeToolCall);
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants: async () => [{ id: SELF_ID, name: "This Agent" }],
      selfId: SELF_ID,
      lastSenderTracker: new LastSenderTracker(),
      logger: noopLogger,
    });

    await wrapped.executeToolCall("band_send_message", { content: "hi", mentions: [] });

    expect(executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hi", mentions: [] });
  });

  it("does not touch other tool calls", async () => {
    const executeToolCall = vi.fn().mockResolvedValue([]);
    const tools = fakeAdapterTools(executeToolCall);
    const listParticipants = vi.fn();
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants,
      selfId: SELF_ID,
      lastSenderTracker: new LastSenderTracker(),
      logger: noopLogger,
    });

    await wrapped.executeToolCall("band_lookup_peers", {});

    expect(listParticipants).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledWith("band_lookup_peers", {});
  });

  it("falls back to the participant list on a listParticipants failure, logging a warning", async () => {
    const executeToolCall = vi.fn().mockResolvedValue({ status: "sent" });
    const tools = fakeAdapterTools(executeToolCall);
    const warn = vi.fn();
    const wrapped = wrapToolsForMentionFallback(tools, "room-1", {
      listParticipants: async () => {
        throw new Error("network error");
      },
      selfId: SELF_ID,
      lastSenderTracker: new LastSenderTracker(),
      logger: { ...noopLogger, warn },
    });

    await wrapped.executeToolCall("band_send_message", { content: "hi", mentions: [] });

    expect(warn).toHaveBeenCalledWith(
      "could not list participants for mention fallback",
      expect.objectContaining({ room_id: "room-1" }),
    );
    // No participants known -> nothing to fall back to, mentions stays empty.
    expect(executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hi", mentions: [] });
  });
});

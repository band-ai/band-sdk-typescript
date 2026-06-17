/**
 * Unit tests for the module-scoped account registry (D6: module Map keyed by
 * accountId, NO globalThis; reset() for test isolation).
 *
 * Holds per-account state the tools path and outbound adapter need without a
 * gateway ctx: the ThenvoiLink, the agent's own id + owner id, a room-type
 * cache (L2 ChatType), and an LRU last-sender cache (auto-mention fallback).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setAccount,
  getAccount,
  getLink,
  resolveSingleAccount,
  resolveAccount,
  deleteAccount,
  resetAccounts,
  cacheRoomType,
  getRoomType,
  trackLastSender,
  getLastSender,
  MAX_LAST_SENDERS,
} from "../../src/state.js";

const fakeLink = { id: "link" } as unknown as Parameters<typeof setAccount>[1]["link"];

beforeEach(() => resetAccounts());

describe("account registry", () => {
  it("sets and gets an account, and getLink returns its link", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "agent-1", ownerUuid: "owner-1" });
    expect(getAccount("default")?.selfAgentId).toBe("agent-1");
    expect(getAccount("default")?.ownerUuid).toBe("owner-1");
    expect(getLink("default")).toBe(fakeLink);
  });

  it("defaults the accountId to 'default'", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "agent-1" });
    expect(getLink()).toBe(fakeLink);
    expect(getAccount()?.selfAgentId).toBe("agent-1");
  });

  it("returns undefined for an unknown account", () => {
    expect(getAccount("nope")).toBeUndefined();
    expect(getLink("nope")).toBeUndefined();
  });

  it("deleteAccount removes a single account", () => {
    setAccount("a", { link: fakeLink, selfAgentId: "x" });
    setAccount("b", { link: fakeLink, selfAgentId: "y" });
    deleteAccount("a");
    expect(getAccount("a")).toBeUndefined();
    expect(getAccount("b")).toBeDefined();
  });

  it("resetAccounts clears everything (no state leak between tests)", () => {
    setAccount("a", { link: fakeLink, selfAgentId: "x" });
    resetAccounts();
    expect(getAccount("a")).toBeUndefined();
  });

  it("resolveSingleAccount prefers 'default' when present", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "agent-default" });
    setAccount("other", { link: fakeLink, selfAgentId: "agent-other" });
    const resolved = resolveSingleAccount();
    expect(resolved?.accountId).toBe("default");
    expect(resolved?.state.selfAgentId).toBe("agent-default");
  });

  it("resolveSingleAccount uses the sole connected account when not named 'default'", () => {
    setAccount("band-openclaw-accounr-id", { link: fakeLink, selfAgentId: "agent-1" });
    const resolved = resolveSingleAccount();
    expect(resolved?.accountId).toBe("band-openclaw-accounr-id");
    expect(resolved?.state.selfAgentId).toBe("agent-1");
  });

  it("resolveSingleAccount returns undefined for none or ambiguous (no 'default')", () => {
    expect(resolveSingleAccount()).toBeUndefined();
    setAccount("a", { link: fakeLink, selfAgentId: "x" });
    setAccount("b", { link: fakeLink, selfAgentId: "y" });
    expect(resolveSingleAccount()).toBeUndefined();
  });

  it("resolveAccount() with no id falls back to the sole connected account", () => {
    setAccount("band-openclaw-accounr-id", { link: fakeLink, selfAgentId: "agent-1" });
    expect(resolveAccount()?.accountId).toBe("band-openclaw-accounr-id");
    expect(resolveAccount(null)?.accountId).toBe("band-openclaw-accounr-id");
  });

  it("resolveAccount(explicitId) returns it when connected", () => {
    setAccount("acct-A", { link: fakeLink, selfAgentId: "x" });
    expect(resolveAccount("acct-A")?.accountId).toBe("acct-A");
  });

  it("resolveAccount(unknownId) does NOT silently substitute another account", () => {
    // The fix: an explicit-but-unknown id must NOT route to the sole connected
    // account (that would misroute a send to the wrong Band identity).
    setAccount("acct-A", { link: fakeLink, selfAgentId: "x" });
    expect(resolveAccount("acct-B")).toBeUndefined();
  });

  it("does NOT store state on globalThis", () => {
    setAccount("a", { link: fakeLink, selfAgentId: "x" });
    const leaked = Object.keys(globalThis as object).filter((k) => /band|thenvoi|account|registry/i.test(k));
    expect(leaked).toEqual([]);
  });
});

describe("room-type cache (L2)", () => {
  it("caches and reads a room type per account", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "x" });
    cacheRoomType("default", "room-1", "direct");
    expect(getRoomType("default", "room-1")).toBe("direct");
  });

  it("returns undefined for an uncached room (caller defaults + warns)", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "x" });
    expect(getRoomType("default", "room-x")).toBeUndefined();
  });
});

describe("last-sender LRU cache (F3 auto-mention fallback)", () => {
  it("tracks and reads the last sender per room", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "x" });
    trackLastSender("default", "room-1", { senderId: "u1", senderName: "Bob" });
    expect(getLastSender("default", "room-1")).toEqual({ senderId: "u1", senderName: "Bob" });
  });

  it("evicts the least-recently-used entry beyond MAX_LAST_SENDERS", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "x" });
    for (let i = 0; i < MAX_LAST_SENDERS + 5; i++) {
      trackLastSender("default", `room-${i}`, { senderId: `u${i}`, senderName: `N${i}` });
    }
    // the earliest rooms should have been evicted
    expect(getLastSender("default", "room-0")).toBeUndefined();
    // the most recent is retained
    expect(getLastSender("default", `room-${MAX_LAST_SENDERS + 4}`)).toEqual({
      senderId: `u${MAX_LAST_SENDERS + 4}`,
      senderName: `N${MAX_LAST_SENDERS + 4}`,
    });
  });

  it("re-tracking a room refreshes its recency (not evicted as LRU)", () => {
    setAccount("default", { link: fakeLink, selfAgentId: "x" });
    trackLastSender("default", "keep", { senderId: "k", senderName: "Keep" });
    for (let i = 0; i < MAX_LAST_SENDERS - 1; i++) {
      trackLastSender("default", `room-${i}`, { senderId: `u${i}`, senderName: `N${i}` });
    }
    // refresh "keep" so it's most-recent
    trackLastSender("default", "keep", { senderId: "k", senderName: "Keep" });
    // one more push triggers an eviction of the oldest (room-0), not "keep"
    trackLastSender("default", "extra", { senderId: "e", senderName: "E" });
    expect(getLastSender("default", "keep")).toEqual({ senderId: "k", senderName: "Keep" });
  });
});

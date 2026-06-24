/**
 * Unit tests for the pure mention-resolution module.
 *
 * Contract (INT-836 / architect consensus C2):
 *  - explicit @Name in text wins over any fallback
 *  - multiple @Names -> multiple mentions
 *  - case-insensitive
 *  - excludes self (never mention the agent)
 *  - word-boundary match: "@bob" must NOT match participant "bobby" (and vice-versa),
 *    and "a@bob" (e.g. an email) must NOT count as a mention
 *  - fallback order when no explicit mention: last sender (if a non-self participant)
 *    -> first other participant -> [] (empty; the throw-on-empty invariant lives in the
 *    outbound adapter, NOT here)
 */

import { describe, it, expect } from "vitest";
import {
  resolveMentions,
  extractExplicitMentions,
  findUnresolvedMentionIds,
  replaceUuidMentions,
  buildParticipantsBlock,
} from "../../src/mentions.js";

const SELF = "agent-self";
const alice = { id: "u-alice", name: "Alice" };
const bob = { id: "u-bob", name: "bob" };
const bobby = { id: "u-bobby", name: "bobby" };
const self = { id: SELF, name: "AgentBot" };

// A realistic uuid + handle participant (mirrors the add-Tom-then-message-Tom bug).
const TOM_ID = "3d5bd75e-6503-40e6-ac49-5acae495e880";
const tom = { id: TOM_ID, name: "Tom", handle: "amit.gazal/tom" };
const amit = { id: "9c7f11b7-0a06-4467-abd5-8ffa66e02cca", name: "Amit Gazal", handle: "amit.gazal" };

describe("extractExplicitMentions", () => {
  it("returns a single explicit @Name match", () => {
    const out = extractExplicitMentions("hey @Alice can you help", [alice, bob], SELF);
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("returns multiple mentions when multiple @Names are present", () => {
    const out = extractExplicitMentions("@Alice @bob look here", [alice, bob], SELF);
    expect(out).toEqual([
      { id: "u-alice", name: "Alice" },
      { id: "u-bob", name: "bob" },
    ]);
  });

  it("is case-insensitive", () => {
    const out = extractExplicitMentions("ping @ALICE", [alice], SELF);
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("excludes self even when the agent's name is @mentioned", () => {
    const out = extractExplicitMentions("@AgentBot @Alice", [self, alice], SELF);
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("respects word boundaries: '@bob' does not match 'bobby'", () => {
    const out = extractExplicitMentions("@bob hello", [bob, bobby], SELF);
    expect(out).toEqual([{ id: "u-bob", name: "bob" }]);
  });

  it("respects word boundaries: '@bobby' matches only 'bobby', not 'bob'", () => {
    const out = extractExplicitMentions("@bobby hello", [bob, bobby], SELF);
    expect(out).toEqual([{ id: "u-bobby", name: "bobby" }]);
  });

  it("does not treat an email-like 'a@bob' as a mention", () => {
    const out = extractExplicitMentions("reach me at amit@bob.com", [bob], SELF);
    expect(out).toEqual([]);
  });

  it("returns [] when there are no explicit mentions", () => {
    const out = extractExplicitMentions("just some text", [alice, bob], SELF);
    expect(out).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(extractExplicitMentions("", [alice, bob], SELF)).toEqual([]);
  });

  it("matches a full multi-word name but not a partial fragment", () => {
    const john = { id: "u-john", name: "John Doe" };
    expect(extractExplicitMentions("@John Doe ping", [john], SELF)).toEqual([
      { id: "u-john", name: "John Doe" },
    ]);
    // partial name must NOT fire (intentional contract)
    expect(extractExplicitMentions("@John ping", [john], SELF)).toEqual([]);
  });

  it("matches an accented name but not its ascii-stripped form", () => {
    const jose = { id: "u-jose", name: "José" };
    expect(extractExplicitMentions("hola @José", [jose], SELF)).toEqual([
      { id: "u-jose", name: "José" },
    ]);
    // '@Jose' must not match 'José' (accented char is a boundary under ASCII \w)
    expect(extractExplicitMentions("hola @Jose", [jose], SELF)).toEqual([]);
  });

  it("de-duplicates by id when a participant appears more than once", () => {
    const dupA = { id: "u-dup", name: "Dup" };
    const dupB = { id: "u-dup", name: "Dup" };
    expect(extractExplicitMentions("@Dup hi", [dupA, dupB], SELF)).toEqual([
      { id: "u-dup", name: "Dup" },
    ]);
  });
});

describe("resolveMentions", () => {
  it("prefers explicit @Name over the last-sender fallback", () => {
    const out = resolveMentions({
      participants: [alice, bob],
      selfId: SELF,
      text: "@Alice please",
      lastSender: { senderId: "u-bob", senderName: "bob" },
    });
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("falls back to the last sender when no explicit mention", () => {
    const out = resolveMentions({
      participants: [alice, bob],
      selfId: SELF,
      text: "thanks",
      lastSender: { senderId: "u-bob", senderName: "bob" },
    });
    expect(out).toEqual([{ id: "u-bob", name: "bob" }]);
  });

  it("falls back to the first other participant when last sender is not present", () => {
    const out = resolveMentions({
      participants: [self, alice, bob],
      selfId: SELF,
      text: "thanks",
      lastSender: { senderId: "ghost", senderName: "Ghost" },
    });
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("never falls back to self as the last sender", () => {
    const out = resolveMentions({
      participants: [self, alice],
      selfId: SELF,
      text: "ok",
      lastSender: { senderId: SELF, senderName: "AgentBot" },
    });
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("falls back to the first other participant with no last sender", () => {
    const out = resolveMentions({
      participants: [self, alice, bob],
      selfId: SELF,
      text: "hello",
      lastSender: null,
    });
    expect(out).toEqual([{ id: "u-alice", name: "Alice" }]);
  });

  it("returns [] when the agent is the only participant (caller enforces non-empty)", () => {
    const out = resolveMentions({
      participants: [self],
      selfId: SELF,
      text: "hello",
      lastSender: null,
    });
    expect(out).toEqual([]);
  });
});

describe("id / handle resolution (SDK-aligned)", () => {
  it("resolves Band's native @[[uuid]] id token to the participant", () => {
    const out = extractExplicitMentions(`@[[${TOM_ID}]] catch Jerry!`, [amit, tom], SELF);
    expect(out).toEqual([{ id: TOM_ID, name: "Tom", handle: "amit.gazal/tom" }]);
  });

  it("resolves an @handle (incl. the @user/agent form) to the participant", () => {
    const out = extractExplicitMentions("hey @amit.gazal/tom please", [amit, tom], SELF);
    expect(out).toEqual([{ id: TOM_ID, name: "Tom", handle: "amit.gazal/tom" }]);
  });

  it("the add-Tom bug: an explicit @[[Tom]] mention is NOT rerouted to the last sender (owner)", () => {
    const out = resolveMentions({
      participants: [amit, tom],
      selfId: SELF,
      // model addresses Tom by his id; Amit was the last (and triggering) sender
      text: `@[[${TOM_ID}]] Amit wants you to catch Jerry`,
      lastSender: { senderId: amit.id, senderName: "Amit Gazal" },
    });
    expect(out).toEqual([{ id: TOM_ID, name: "Tom", handle: "amit.gazal/tom" }]);
  });

  it("throws on a deliberate @[[uuid]] to a non-participant rather than misrouting to the owner", () => {
    expect(() =>
      resolveMentions({
        participants: [amit], // Tom is NOT in the room
        selfId: SELF,
        text: `@[[${TOM_ID}]] catch Jerry`,
        lastSender: { senderId: amit.id, senderName: "Amit Gazal" },
      }),
    ).toThrow(/Cannot resolve @mention/);
  });

  it("findUnresolvedMentionIds returns id tokens with no matching participant", () => {
    expect(findUnresolvedMentionIds(`@[[${TOM_ID}]] hi`, [amit], SELF)).toEqual([TOM_ID]);
    expect(findUnresolvedMentionIds(`@[[${TOM_ID}]] hi`, [amit, tom], SELF)).toEqual([]);
  });
});

describe("replaceUuidMentions (inbound display)", () => {
  it("rewrites @[[uuid]] tokens into @handle form", () => {
    expect(replaceUuidMentions(`@[[${amit.id}]] please add Tom`, [amit, tom])).toBe(
      "@amit.gazal please add Tom",
    );
  });

  it("leaves id tokens with no known handle untouched", () => {
    const noHandle = { id: "u-x", name: "X" };
    expect(replaceUuidMentions("@[[u-x]] hi", [noHandle])).toBe("@[[u-x]] hi");
  });
});

describe("buildParticipantsBlock (inbound roster)", () => {
  it("lists the other participants with handles and the mention instruction", () => {
    const block = buildParticipantsBlock([self, amit, tom], SELF);
    expect(block).toContain("## Participants in this room");
    expect(block).toContain("- @amit.gazal — Amit Gazal");
    expect(block).toContain("- @amit.gazal/tom — Tom");
    expect(block).toContain("write their @handle");
    expect(block).not.toContain("AgentBot"); // self excluded
  });

  it("returns an empty string when the agent is alone", () => {
    expect(buildParticipantsBlock([self], SELF)).toBe("");
  });
});

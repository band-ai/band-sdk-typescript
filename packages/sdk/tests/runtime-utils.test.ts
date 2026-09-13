import { describe, expect, it } from "vitest";

import { RetryTracker } from "@band-ai/band-sdk-core";
import {
  BASE_INSTRUCTIONS,
  buildParticipantsMessage,
  formatHistoryForLlm,
  formatMessageForLlm,
  mentionSubjectsFromMetadata,
  renderSystemPrompt,
  replaceUuidMentions,
} from "../src/runtime";
import {
  CHAT_EVENT_TYPES,
  assertChatEventType,
  isChatEventType,
} from "../src/contracts/chatEvents";

describe("runtime utilities", () => {
  it("replaces UUID mentions", () => {
    const replaced = replaceUuidMentions("hello @[[u1]]", [
      { id: "u1", handle: "john" },
    ]);
    expect(replaced).toBe("hello @john");
  });

  it("preserves exactly one prefix when replacing a UUID with a prefixed handle", () => {
    const replaced = replaceUuidMentions("hello @[[u1]]", [
      { id: "u1", handle: "@john" },
    ]);
    expect(replaced).toBe("hello @john");
  });

  describe("mentionSubjectsFromMetadata", () => {
    it("prefers handle over username and name", () => {
      expect(
        mentionSubjectsFromMetadata({
          mentions: [{ id: "u1", handle: "john", username: "jsmith", name: "John Smith" }],
        }),
      ).toEqual([{ id: "u1", handle: "john" }]);
    });

    it("resolves from username alone when handle is absent", () => {
      expect(
        mentionSubjectsFromMetadata({ mentions: [{ id: "u1", username: "jsmith" }] }),
      ).toEqual([{ id: "u1", handle: "jsmith" }]);
    });

    it("resolves from name alone when handle and username are absent", () => {
      expect(
        mentionSubjectsFromMetadata({ mentions: [{ id: "u1", name: "John Smith" }] }),
      ).toEqual([{ id: "u1", handle: "John Smith" }]);
    });

    it("falls through an empty-string handle to the next field instead of deleting the mention", () => {
      expect(
        mentionSubjectsFromMetadata({ mentions: [{ id: "u1", handle: "", username: "jsmith" }] }),
      ).toEqual([{ id: "u1", handle: "jsmith" }]);
    });

    it("omits a mention with no usable label at all, leaving its token unresolved", () => {
      expect(
        mentionSubjectsFromMetadata({ mentions: [{ id: "u1", handle: "", username: null, name: undefined }] }),
      ).toEqual([]);
    });

    it("ignores metadata that isn't shaped like a mention list", () => {
      for (const metadata of [undefined, {}, { mentions: "u1" }, { mentions: [{}, { id: 7 }] }]) {
        expect(mentionSubjectsFromMetadata(metadata)).toEqual([]);
      }
    });
  });

  it("formats message and history for llm", () => {
    const msg = formatMessageForLlm({
      id: "m1",
      sender_type: "User",
      sender_name: "Jane",
      content: "Hi",
      message_type: "text",
    });
    expect(msg.role).toBe("user");

    const history = formatHistoryForLlm(
      [
        { id: "m1", sender_type: "User", content: "one" },
        { id: "m2", sender_type: "Agent", content: "two" },
      ],
      { excludeId: "m2" },
    );
    expect(history).toHaveLength(1);
  });

  it("builds participant prompt", () => {
    const message = buildParticipantsMessage([{ type: "User", name: "Jane", handle: "jane" }]);
    expect(message).toContain("Current Participants");
    expect(message).toContain("@jane");
  });

  it("preserves exactly one prefix for a prefixed participant handle", () => {
    const message = buildParticipantsMessage([
      { type: "User", name: "Jane", handle: "@jane" },
    ]);
    expect(message).toContain("- @jane — Jane (User)");
    expect(message).not.toContain("@@jane");
  });

  it("renders system prompt", () => {
    const prompt = renderSystemPrompt({
      agentName: "Agent",
      agentDescription: "Helper",
      customSection: "Use concise output.",
    });
    expect(prompt).toContain("Use concise output.");
    expect(prompt).toContain(BASE_INSTRUCTIONS.trim().slice(0, 20));
  });

  it("tracks message retries", () => {
    const retry = new RetryTracker(1);
    expect(retry.recordAttempt("m1")).toEqual([1, false]);
    expect(retry.recordAttempt("m1")).toEqual([2, true]);
    expect(retry.isPermanentlyFailed("m1")).toBe(true);
  });

  it("provides chat event type guards", () => {
    expect(CHAT_EVENT_TYPES).toContain("tool_call");
    expect(isChatEventType("task")).toBe(true);
    expect(isChatEventType("message_created")).toBe(false);
    expect(() => assertChatEventType("message_created")).toThrow();
  });
});

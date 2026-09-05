import { describe, expect, it } from "vitest";

import { asNonEmptyString, asOptionalRecord, asRecord } from "../src/adapters/shared/coercion";
import {
  findLatestTaskMetadata,
  selectCompleteExchanges,
} from "../src/adapters/shared/history";
import { mapConversationMessages } from "../src/adapters/tool-calling/valueUtils";

describe("adapter shared utilities", () => {
  it("requires object records and keeps optional parsing available", () => {
    expect(() => asRecord(null)).toThrow("Expected value to be an object record.");
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asOptionalRecord(null)).toBeUndefined();
  });

  it("extracts non-empty trimmed strings", () => {
    expect(asNonEmptyString("  hello  ")).toBe("hello");
    expect(asNonEmptyString("   ")).toBeNull();
    expect(asNonEmptyString(42)).toBeNull();
  });

  it("finds latest matching task metadata from history", () => {
    const metadata = findLatestTaskMetadata(
      [
        { message_type: "task", metadata: { value: "" } },
        { message_type: "text", metadata: { value: "skip" } },
        { messageType: "task", metadata: { value: "match" } },
      ],
      (entry) => typeof entry.value === "string" && entry.value.length > 0,
    );

    expect(metadata).toEqual({ value: "match" });
  });

  it("maps and filters conversation messages", () => {
    const mapped = mapConversationMessages(
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
        tools: [],
      },
      (entry) => (entry.role === "assistant" ? null : entry),
    );

    expect(mapped).toEqual([{ role: "user", content: "one" }]);
  });
});

describe("selectCompleteExchanges", () => {
  const NO_LIMIT = 100;

  const turn = (role: "user" | "assistant", content: string, sender = "") => ({
    role,
    content,
    sender,
    senderType: role === "assistant" ? "Agent" : "User",
  });

  it("merges consecutive same-role messages instead of dropping them", () => {
    const result = selectCompleteExchanges(
      [
        turn("user", "[Alice]: Hey", "Alice"),
        turn("user", "[Bob]: Hi there", "Bob"),
        turn("assistant", "Hello both!", "Bot"),
      ],
      NO_LIMIT,
    );

    expect(result).toEqual([
      turn("user", "[Alice]: Hey\n[Bob]: Hi there", "Alice"),
      turn("assistant", "Hello both!", "Bot"),
    ]);
  });

  it("merges consecutive assistant messages into one turn", () => {
    const result = selectCompleteExchanges(
      [
        turn("user", "Question", "Alice"),
        turn("assistant", "Part one", "Bot"),
        turn("assistant", "Part two", "Bot"),
      ],
      NO_LIMIT,
    );

    expect(result).toEqual([
      turn("user", "Question", "Alice"),
      turn("assistant", "Part one\nPart two", "Bot"),
    ]);
  });

  it("keeps a trailing user message that has no assistant reply yet", () => {
    const result = selectCompleteExchanges(
      [
        turn("user", "First", "Alice"),
        turn("assistant", "Reply", "Bot"),
        turn("user", "Unanswered", "Alice"),
      ],
      NO_LIMIT,
    );

    expect(result.map((entry) => entry.content)).toEqual([
      "First",
      "Reply",
      "Unanswered",
    ]);
  });

  it("drops orphaned assistant messages with no preceding user turn", () => {
    const result = selectCompleteExchanges(
      [
        turn("assistant", "Unprompted", "Bot"),
        turn("user", "Question", "Alice"),
        turn("assistant", "Answer", "Bot"),
      ],
      NO_LIMIT,
    );

    expect(result.map((entry) => entry.content)).toEqual(["Question", "Answer"]);
  });

  it("skips empty content and never mutates the input", () => {
    const history = [
      turn("user", "Kept", "Alice"),
      turn("user", "", "Bob"),
      turn("assistant", "Answer", "Bot"),
    ];
    const snapshot = structuredClone(history);

    const result = selectCompleteExchanges(history, NO_LIMIT);

    expect(result.map((entry) => entry.content)).toEqual(["Kept", "Answer"]);
    expect(history).toEqual(snapshot);
  });

  it("keeps a lone trailing user message", () => {
    const result = selectCompleteExchanges([turn("user", "Only", "Alice")], NO_LIMIT);

    expect(result).toEqual([turn("user", "Only", "Alice")]);
  });

  it("drops a lone orphaned assistant message", () => {
    expect(
      selectCompleteExchanges([turn("assistant", "Only", "Bot")], NO_LIMIT),
    ).toEqual([]);
  });

  it("caps the result at `limit`, keeping the most recent turns", () => {
    const result = selectCompleteExchanges(
      [
        turn("user", "Q1", "Alice"),
        turn("assistant", "A1", "Bot"),
        turn("user", "Q2", "Alice"),
        turn("assistant", "A2", "Bot"),
        turn("user", "Q3", "Alice"),
        turn("assistant", "A3", "Bot"),
      ],
      2,
    );

    expect(result.map((entry) => entry.content)).toEqual(["Q3", "A3"]);
  });

  it("never truncates into the middle of an exchange", () => {
    // 5 turns (two pairs + a trailing unanswered question); a raw slice(-2)
    // would start on "A2", an assistant reply whose question was cut away.
    const result = selectCompleteExchanges(
      [
        turn("user", "Q1", "Alice"),
        turn("assistant", "A1", "Bot"),
        turn("user", "Q2", "Alice"),
        turn("assistant", "A2", "Bot"),
        turn("user", "Unanswered", "Alice"),
      ],
      2,
    );

    expect(result.map((entry) => entry.content)).toEqual(["Unanswered"]);
  });

  it("returns nothing when `limit` is zero", () => {
    const result = selectCompleteExchanges(
      [turn("user", "Q", "Alice"), turn("assistant", "A", "Bot")],
      0,
    );

    expect(result).toEqual([]);
  });

  it("returns everything when the history is shorter than `limit`", () => {
    const history = [turn("user", "Q", "Alice"), turn("assistant", "A", "Bot")];

    expect(selectCompleteExchanges(history, 100)).toHaveLength(2);
  });

  it("returns nothing for an empty history", () => {
    expect(selectCompleteExchanges([], NO_LIMIT)).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { asNonEmptyString, asOptionalRecord, asRecord } from "../src/adapters/shared/coercion";
import {
  findLatestTaskMetadata,
  selectCompleteExchanges,
} from "../src/adapters/shared/history";
import { withTimeout } from "../src/adapters/shared/withTimeout";
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

  describe("withTimeout", () => {
    it("resolves with the promise's value when it settles before the timeout", async () => {
      await expect(withTimeout(Promise.resolve("done"), 1_000, "timed out")).resolves.toBe("done");
    });

    it("propagates the original rejection when the promise loses before the timeout", async () => {
      await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, "timed out")).rejects.toThrow("boom");
    });

    it("rejects with the timeout message once the timeout elapses first", async () => {
      vi.useFakeTimers();
      try {
        const hung = new Promise<never>(() => undefined);
        // `.rejects` attaches its handler immediately, before the fake timer
        // fires: the rejection takes a few microtask hops to reach this
        // promise (race -> withTimeout's own await -> its returned promise),
        // and asserting only after `advanceTimersByTimeAsync` would leave it
        // briefly unhandled across those hops.
        const assertion = expect(withTimeout(hung, 1_000, "timed out after 1000ms")).rejects.toThrow(
          "timed out after 1000ms",
        );
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
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

  it("names a second assistant when one run spans two of them", () => {
    // The merged turn is attributed to a single sender downstream, so the
    // second bot's name has to survive inside the text or its reply is
    // replayed as the first bot's.
    const result = selectCompleteExchanges(
      [
        turn("user", "Question", "Alice"),
        turn("assistant", "From the first", "BotA"),
        turn("assistant", "From the second", "BotB"),
      ],
      NO_LIMIT,
    );

    expect(result).toEqual([
      turn("user", "Question", "Alice"),
      turn("assistant", "From the first\n[BotB]: From the second", "BotA"),
    ]);
  });

  it("names a returning assistant again so the block does not read as the last one named", () => {
    // A -> B -> A.  Comparing against the turn that opened the block instead
    // of the last speaker named in it leaves A's second message unlabelled
    // directly under B's labelled line, where it reads as B's.
    const result = selectCompleteExchanges(
      [
        turn("user", "Question", "Alice"),
        turn("assistant", "first from A", "BotA"),
        turn("assistant", "from B", "BotB"),
        turn("assistant", "second from A", "BotA"),
      ],
      NO_LIMIT,
    );

    expect(result[1].content).toBe(
      "first from A\n[BotB]: from B\n[BotA]: second from A",
    );
  });

  it("marks a turn that names no sender rather than folding it into the previous speaker", () => {
    const result = selectCompleteExchanges(
      [
        turn("user", "[Alice]: hey", "Alice"),
        turn("user", "anonymous line", ""),
        turn("assistant", "Hello", "Bot"),
      ],
      NO_LIMIT,
    );

    expect(result[0].content).toBe("[Alice]: hey\n[Unknown]: anonymous line");
  });

  it("does not name a user run, whose identities the converter already wrote", () => {
    // The history converters prefix user content with `[sender]: ` already;
    // prefixing again here would double it.
    const result = selectCompleteExchanges(
      [
        turn("user", "[Alice]: Hey", "Alice"),
        turn("user", "[Bob]: Hi", "Bob"),
        turn("assistant", "Hello", "Bot"),
      ],
      NO_LIMIT,
    );

    expect(result[0].content).toBe("[Alice]: Hey\n[Bob]: Hi");
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

  it("treats NaN as a mistake rather than as no limit", () => {
    // NaN fails every comparison and reaches `slice(-NaN)`, i.e. `slice(0)`,
    // which would return the whole history unbounded.
    const result = selectCompleteExchanges(
      [turn("user", "Q", "Alice"), turn("assistant", "A", "Bot")],
      Number.NaN,
    );

    expect(result).toEqual([]);
  });

  it("floors a fractional `limit` instead of letting slice round it", () => {
    const history = [
      turn("user", "Q1", "Alice"),
      turn("assistant", "A1", "Bot"),
      turn("user", "Q2", "Alice"),
      turn("assistant", "A2", "Bot"),
    ];

    expect(selectCompleteExchanges(history, 2.9).map((e) => e.content)).toEqual(
      selectCompleteExchanges(history, 2).map((e) => e.content),
    );
  });

  it("selects nothing for `limit` 1 when the newest turn is an answer", () => {
    // The single most recent turn is an assistant reply, and a reply is never
    // replayed without its question, so no one-turn window is valid.
    const result = selectCompleteExchanges(
      [turn("user", "Q", "Alice"), turn("assistant", "A", "Bot")],
      1,
    );

    expect(result).toEqual([]);
  });

  it("returns nothing when `limit` is negative", () => {
    // The old `.slice(-limit)` turned a negative into a positive index and
    // dropped that many turns off the front instead.
    const result = selectCompleteExchanges(
      [turn("user", "Q", "Alice"), turn("assistant", "A", "Bot")],
      -1,
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

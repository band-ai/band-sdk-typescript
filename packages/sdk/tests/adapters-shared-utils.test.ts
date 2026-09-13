import { describe, expect, it, vi } from "vitest";

import { asNonEmptyString, asOptionalRecord, asRecord } from "../src/adapters/shared/coercion";
import { findLatestTaskMetadata } from "../src/adapters/shared/history";
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

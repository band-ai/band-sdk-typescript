import { describe, expect, it } from "vitest";

import { asNonEmptyString, asOptionalRecord, asRecord } from "../src/core/coercion";
import { findLatestTaskMetadata } from "../src/adapters/shared/history";
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

import { describe, expect, it, vi } from "vitest";

import {
  asErrorMessage,
  asNestedMessage,
  asNonEmptyString,
  asOptionalRecord,
  asRecord,
} from "../src/adapters/shared/coercion";
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

  describe("asErrorMessage", () => {
    it("returns the message of a plain Error", () => {
      expect(asErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("appends an Error's cause when present", () => {
      const error = new Error("boom", { cause: "disk full" });
      expect(asErrorMessage(error)).toBe("boom (disk full)");
    });

    it("reads message and data off a plain JSON-RPC-shaped error object", () => {
      const error = { code: -32603, message: "Internal error", data: "agent crashed: OOM" };
      expect(asErrorMessage(error)).toBe("Internal error (agent crashed: OOM)");
    });

    it("reads data off an Error subclass carrying a data field", () => {
      class RequestError extends Error {
        public constructor(
          public readonly code: number,
          message: string,
          public readonly data?: unknown,
        ) {
          super(message);
        }
      }
      const error = new RequestError(-32603, "Internal error", { message: "agent crashed" });
      expect(asErrorMessage(error)).toBe("Internal error (agent crashed)");
    });

    it("falls back to String() for non-object values", () => {
      expect(asErrorMessage("plain string")).toBe("plain string");
      expect(asErrorMessage(42)).toBe("42");
    });

    it("terminates on a self-referential cause chain instead of overflowing the stack", () => {
      const error = new Error("outer") as Error & { cause: unknown };
      error.cause = error;
      expect(() => asErrorMessage(error)).not.toThrow();
      expect(asErrorMessage(error)).toMatch(/^outer(?: \(outer)*/);
    });

    it("terminates on a long non-cyclic cause chain instead of overflowing the stack", () => {
      let error = new Error("root cause");
      for (let i = 0; i < 10_000; i += 1) {
        const wrapper = new Error(`wrap ${i}`) as Error & { cause: unknown };
        wrapper.cause = error;
        error = wrapper;
      }
      expect(() => asErrorMessage(error)).not.toThrow();
    });

    it("treats a blank string data field as absent instead of appending an empty parenthetical", () => {
      expect(asErrorMessage({ code: -32603, message: "Internal error", data: "" })).toBe("Internal error");
      expect(asErrorMessage({ message: "Internal error", data: "   " })).toBe("Internal error");
    });

    it("renders a NaN data field visibly instead of JSON.stringify's silent 'null'", () => {
      expect(asErrorMessage({ message: "Internal error", data: Number.NaN })).toBe("Internal error (NaN)");
    });

    it("JSON.stringify's a plain object data field with no message property", () => {
      expect(asErrorMessage({ message: "Internal error", data: { code: 500, reason: "x" } }))
        .toBe('Internal error ({"code":500,"reason":"x"})');
    });

    it("falls back to String() when a circular data object can't be JSON.stringify'd", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => asErrorMessage({ message: "Internal error", data: circular })).not.toThrow();
      expect(asErrorMessage({ message: "Internal error", data: circular })).toBe("Internal error ([object Object])");
    });

    it("truncates an oversized detail instead of appending it in full", () => {
      const result = asErrorMessage({ message: "m", data: "x".repeat(1000) });
      expect(result).toContain("... (truncated)");
      expect(result.length).toBeLessThan(600);
    });

    it("still surfaces present data when the top-level object has no string message", () => {
      const result = asErrorMessage({ data: "detail" });
      expect(result).toContain("detail");
    });
  });

  describe("asNestedMessage", () => {
    it("returns the message field of a record", () => {
      expect(asNestedMessage({ message: "nested detail" })).toBe("nested detail");
    });

    it("returns null for non-records or a non-string message", () => {
      expect(asNestedMessage("not a record")).toBeNull();
      expect(asNestedMessage({ message: 42 })).toBeNull();
    });
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

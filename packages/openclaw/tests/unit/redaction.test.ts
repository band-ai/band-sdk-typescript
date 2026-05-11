import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/redaction.js";

describe("redactSecrets", () => {
  it("redacts Thenvoi API keys", () => {
    expect(redactSecrets("failed with tv_123456789abcdef")).toBe("failed with [REDACTED]");
  });

  it("redacts bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts gateway tokens", () => {
    expect(redactSecrets("gateway_token=secret-token-value")).toBe("gateway_token=[REDACTED]");
  });

  it("redacts Error messages", () => {
    expect(redactSecrets(new Error("apiKey: tv_abcdefghijk"))).toBe("apiKey: [REDACTED]");
  });
});

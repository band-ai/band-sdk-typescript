import { describe, expect, it } from "vitest";
import { redact } from "../../scripts/nemoclaw-integration-common.js";
import { redactSecrets } from "../../src/redaction.js";

describe("redactSecrets", () => {
  it("redacts Band and Thenvoi API keys", () => {
    for (const token of [
      "tv_123456789abcdef",
      "thnv_a_123456789abcdef",
      "thnv_u_123456789abcdef",
      "thnv_123456789abcdef",
      "band_a_123456789abcdef",
      "band_u_123456789abcdef",
    ]) {
      expect(redactSecrets(`failed with ${token}`)).toBe("failed with [REDACTED]");
    }
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

  it("keeps NemoClaw script redaction in sync with runtime credential prefixes", () => {
    for (const token of [
      "thnv_a_123456789abcdef",
      "thnv_u_123456789abcdef",
      "thnv_123456789abcdef",
      "band_a_123456789abcdef",
      "band_u_123456789abcdef",
    ]) {
      expect(redact(`nemoclaw failed with ${token}`)).toBe("nemoclaw failed with [REDACTED]");
    }
  });
});

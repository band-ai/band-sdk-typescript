import { describe, expect, it } from "vitest";

import { redactDiagnostics, redactDiagnosticText } from "./support/redactDiagnostics";

describe("live diagnostic redaction", () => {
  it("redacts shared credential names in structured data and quoted error text", () => {
    const credentials = {
      cookie: "session-fixture", token: "token-fixture", access_key: "access-fixture",
      api_key: "AIza-fixture", BAND_API_KEY_USER: "band-user-fixture", apiKeyBackup: "backup-fixture",
    };
    const sanitized = redactDiagnostics({ payload: credentials, usage: { output_tokens: 30, promptTokenCount: 10 },
      password: 1234, passwordTokenCount: 4321, apiKeyTokens: 5678 });
    for (const secret of Object.values(credentials)) {
      expect(JSON.stringify(sanitized)).not.toContain(secret);
      expect(redactDiagnosticText(JSON.stringify(credentials))).not.toContain(secret);
    }
    expect(sanitized).toMatchObject({ usage: { output_tokens: 30, promptTokenCount: 10 },
      password: "[REDACTED]", passwordTokenCount: "[REDACTED]", apiKeyTokens: "[REDACTED]" });
  });

  it.each(["Bearer", "ApiKey"])("redacts the entire %s authorization value", (scheme) => {
    expect(redactDiagnosticText(`authorization: ${scheme} private-fixture`)).not.toContain("private-fixture");
  });

  it("removes provisioned keys and arbitrary add-command credentials from child-process errors", () => {
    const error = new Error("Command failed: node agents.js add --api-key fixture-key\nband_a_provisioned123 failed");
    expect(redactDiagnostics(error, ["fixture-key"])).toMatchObject({
      message: "Command failed: node agents.js add --api-key [REDACTED]\n[REDACTED] failed",
    });
    expect(JSON.stringify(redactDiagnostics(error, ["fixture-key"]))).not.toContain("fixture-key");
  });

  it("redacts nested headers and key fields while preserving useful provider and tool evidence", () => {
    expect(redactDiagnostics({
      headers: { authorization: "Bearer private", "x-api-key": "private" },
      apiKey: "private", prompt: "Send pineapple", args: { scope: "subject", subject_id: "user-id" },
      output: "422 cannot_mention_self", usage: { output_tokens: 30 },
    })).toEqual({
      headers: { authorization: "[REDACTED]", "x-api-key": "[REDACTED]" },
      apiKey: "[REDACTED]", prompt: "Send pineapple", args: { scope: "subject", subject_id: "user-id" },
      output: "422 cannot_mention_self", usage: { output_tokens: 30 },
    });
    expect(redactDiagnosticText("OPENAI_API_KEY=private --token secret Bearer hidden"))
      .toBe("OPENAI_API_KEY=[REDACTED] [REDACTED] Bearer [REDACTED]");
  });
});

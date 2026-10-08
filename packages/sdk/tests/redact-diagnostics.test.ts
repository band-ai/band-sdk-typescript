import { describe, expect, it } from "vitest";

import { redactDiagnostics, redactDiagnosticText } from "./support/redactDiagnostics";

describe("live diagnostic redaction", () => {
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
      .toBe("OPENAI_API_KEY=[REDACTED] --token [REDACTED] Bearer [REDACTED]");
  });
});

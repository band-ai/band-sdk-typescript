import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/core/errors";
import { parseSessionConfig, sessionConfigSchema } from "../src/runtime/types";

describe("sessionConfig journal platform identity", () => {
  it("reports an identity that is no URL at all as an invalid field, not a thrown parse", () => {
    expect(sessionConfigSchema.safeParse({ journalPlatformIdentity: "not-a-url" }).success).toBe(false);
    expect(() => parseSessionConfig({ journalPlatformIdentity: "not-a-url" })).toThrow(ValidationError);
    expect(() => parseSessionConfig({ journalPlatformIdentity: "not-a-url" })).toThrow(/^Invalid sessionConfig: journalPlatformIdentity: /);
  });
});

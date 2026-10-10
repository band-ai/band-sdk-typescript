import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

// Use the SDK's installed Fern dependency, whose errors the plugin receives.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@band-ai/sdk"));
const { Band: BandApi } = sdkRequire("@band-ai/rest-client");
import { bandErrorText } from "../../src/tools";

describe("Band refusals", () => {
  it("keeps field reasons from Band's validation response", () => {
    const error = new BandApi.UnprocessableEntityError({ error: { code: "validation_error", message: "Request validation failed", details: { "/subject": ["must be at most 500 characters"] } } });
    expect(bandErrorText(error)).toBe("Band refused it (422): Request validation failed (/subject: must be at most 500 characters)");
  });
  it("keeps a non-active task's message with empty details", () => {
    const error = new BandApi.UnprocessableEntityError({ error: { code: "task_not_active", message: "Work fields and comments require an active task", details: {} } });
    expect(bandErrorText(error)).toBe("Band refused it (422): Work fields and comments require an active task");
  });
});

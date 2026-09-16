import { describe, expect, it } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";

/**
 * The legacy `humanApiProfile.getMyProfile` fallback derives a display name
 * from whichever field an older server happened to populate: name -> first
 * + last -> username -> id. A regression in that priority order silently
 * misnames an agent rather than crashing, so each rung is asserted directly.
 */
describe("FernRestAdapter: legacy profile name derivation", () => {
  it("derives the name from username when name and first/last name are absent", async () => {
    const adapter = new FernRestAdapter({
      humanApiProfile: {
        getMyProfile: async () => ({ data: { id: "legacy-1", username: "janedoe" } }),
      },
    });

    await expect(adapter.getAgentMe()).resolves.toMatchObject({ name: "janedoe" });
  });

  it("falls back to id as the name when no name, first/last name, or username is present", async () => {
    const adapter = new FernRestAdapter({
      humanApiProfile: {
        getMyProfile: async () => ({ data: { id: "legacy-1" } }),
      },
    });

    await expect(adapter.getAgentMe()).resolves.toMatchObject({ name: "legacy-1" });
  });
});

/**
 * `extractEnvelopeData` + `asMetadataMap` guard both identity paths against
 * a response that doesn't unwrap to an object at all — a malformed server
 * response should raise a clear error, not crash deeper in field access.
 */
describe("FernRestAdapter: malformed identity envelopes", () => {
  it("rejects a getAgentMe envelope that does not unwrap to an object", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({ data: null }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toThrow("expected object payload for AgentIdentity");
  });

  it("rejects a legacy profile envelope that does not unwrap to an object", async () => {
    const adapter = new FernRestAdapter({
      humanApiProfile: {
        getMyProfile: async () => ({ data: null }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toThrow("expected object payload");
  });

  it("rejects an identity payload whose description is the wrong type", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({ data: { id: "a1", name: "Agent", description: 42 } }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toThrow(
      "expected string or null AgentIdentity.description",
    );
  });
});

/**
 * Conformance guard: verifies the real @band-ai/rest-client@0.0.118 exports
 * every resource and method the SDK consumes, without making network calls.
 *
 * This test catches a removed or renamed generated resource that typecheck
 * alone misses (ThenvoiLink casts BandClient through `unknown`). A missing
 * method here means the SDK would throw at runtime.
 */

import { describe, it, expect } from "vitest";
import { BandClient } from "@band-ai/rest-client";

describe("BandClient conformance (0.0.118)", () => {
  // Instantiate with a dummy key — no network call is made.
  const client = new BandClient({ apiKey: "test-conformance-key" });

  /**
   * Every agentApi* resource the FernRestAdapter prefers. Each entry is
   * [namespace, [...methods]]. The adapter falls back to legacy namespaces
   * when these are absent, but the preferred set MUST exist on the current
   * generated client to avoid degraded behavior.
   */
  const requiredResources: Array<[string, string[]]> = [
    ["agentApiIdentity", ["getAgentMe"]],
    ["agentApiPeers", ["listAgentPeers"]],
    ["agentApiContacts", [
      "listAgentContacts",
      "addAgentContact",
      "removeAgentContact",
      "listAgentContactRequests",
      "respondToAgentContactRequest",
    ]],
    ["agentApiMemories", [
      "listAgentMemories",
      "createAgentMemory",
      "getAgentMemory",
      "supersedeAgentMemory",
      "archiveAgentMemory",
    ]],
    ["agentApiMessages", [
      "listAgentMessages",
      "createAgentChatMessage",
      "markAgentMessageProcessing",
      "markAgentMessageProcessed",
      "markAgentMessageFailed",
      "getAgentNextMessage",
    ]],
    ["agentApiEvents", ["createAgentChatEvent"]],
    ["agentApiChats", ["createAgentChat", "listAgentChats"]],
    ["agentApiParticipants", [
      "listAgentChatParticipants",
      "addAgentChatParticipant",
      "removeAgentChatParticipant",
    ]],
    ["agentApiContext", ["getAgentChatContext"]],
  ];

  for (const [namespace, methods] of requiredResources) {
    it(`exposes ${namespace} with ${methods.length} methods`, () => {
      const resource = (client as Record<string, unknown>)[namespace];
      expect(resource).toBeDefined();
      for (const method of methods) {
        expect(typeof (resource as Record<string, unknown>)[method]).toBe(
          "function",
        );
      }
    });
  }

  it("red-check: detects a missing method on a real namespace", () => {
    const resource = (client as Record<string, unknown>).agentApiIdentity;
    expect(resource).toBeDefined();
    expect(
      (resource as Record<string, unknown>).definitelyDoesNotExist,
    ).toBeUndefined();
  });
});

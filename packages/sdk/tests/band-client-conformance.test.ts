/**
 * Conformance guard: verifies the real @band-ai/rest-client exports every resource and
 * method the SDK consumes, and no longer exposes the legacy resources the adapter used to
 * probe, without making network calls.
 *
 * This test catches a removed or renamed generated resource at runtime. A missing method
 * here means the SDK would throw; a resurrected legacy name here means the adapter is
 * reaching a namespace it no longer supports.
 */

import { createRequire } from "node:module";

import { describe, it, expect } from "vitest";
import { BandClient } from "@band-ai/rest-client";

const require = createRequire(import.meta.url);
const restClientVersion = (
  require("@band-ai/rest-client/package.json") as { version: string }
).version;

describe(`BandClient conformance (${restClientVersion})`, () => {
  // Instantiate with a dummy key — no network call is made.
  const client = new BandClient({ apiKey: "test-conformance-key" });
  const resources = client as unknown as Record<string, unknown>;

  /**
   * Every agentApi* resource the FernRestAdapter calls. Each entry is
   * [namespace, [...methods]]. These are the only endpoints the adapter knows about, so
   * a missing one means degraded behavior at runtime.
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

  /**
   * Resources the adapter used to probe ahead of the agentApi* ones. They have never
   * existed on this client, so every probe was dead code; pin their absence so the
   * fallbacks are not reintroduced without a reason.
   */
  const removedLegacyResources = [
    "myProfile",
    "myChatMessages",
    "chatRooms",
    "chatMessages",
    "chatParticipants",
    "chatContext",
    "agentPeers",
    "agentContacts",
    "agentMemories",
  ];

  for (const [namespace, methods] of requiredResources) {
    it(`exposes ${namespace} with ${methods.length} methods`, () => {
      const resource = resources[namespace];
      expect(resource).toBeDefined();
      for (const method of methods) {
        expect(typeof (resource as Record<string, unknown>)[method]).toBe(
          "function",
        );
      }
    });
  }

  it.each(removedLegacyResources)("does not expose the legacy %s resource", (namespace) => {
    expect(resources[namespace]).toBeUndefined();
  });

  it("red-check: detects a missing method on a real namespace", () => {
    const resource = resources.agentApiIdentity;
    expect(resource).toBeDefined();
    expect(
      (resource as Record<string, unknown>).definitelyDoesNotExist,
    ).toBeUndefined();
  });
});

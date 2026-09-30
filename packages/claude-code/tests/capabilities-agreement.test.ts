import { describe, expect, it } from "vitest";

import { BandLink } from "@band-ai/sdk";
import { buildRoomScopedRegistrations } from "@band-ai/sdk/mcp";
import { FakeAgentTools } from "@band-ai/sdk/testing";

import { capabilitiesToPromptList, parseCapabilitiesFromEnv } from "../src/capabilities";
import { buildInstructions } from "../src/prompt";

/**
 * The plan requires the registered tool list, the contact-event
 * subscription, and the prompt's capability lines to agree with each other
 * and with the enable_contacts/enable_memory flags, for every combination —
 * so a bug can't silently advertise a tool the prompt never mentions, or
 * mention a tool that was never registered.
 */
const COMBINATIONS = [
  { BAND_ENABLE_CONTACTS: "false", BAND_ENABLE_MEMORY: "false" },
  { BAND_ENABLE_CONTACTS: "false", BAND_ENABLE_MEMORY: "true" },
  { BAND_ENABLE_CONTACTS: "true", BAND_ENABLE_MEMORY: "false" },
  { BAND_ENABLE_CONTACTS: "true", BAND_ENABLE_MEMORY: "true" },
] as const;

describe("capabilities agree across BandLink, tool registration, and the prompt", () => {
  it.each(COMBINATIONS.map((env) => [env] as const))("%j", (env) => {
    const capabilities = parseCapabilitiesFromEnv(env);

    // BandLink: the same object is passed straight through (no re-derivation
    // anywhere), and RoomPresence.subscribeContacts gates on link.capabilities.contacts.
    const link = new BandLink({ agentId: "agent-1", apiKey: "key", capabilities });
    expect(link.capabilities.contacts).toBe(capabilities.contacts);
    expect(link.capabilities.memory).toBe(capabilities.memory);

    // Tool registration
    const registrations = buildRoomScopedRegistrations(() => new FakeAgentTools(), {
      enableContactTools: capabilities.contacts,
      enableMemoryTools: capabilities.memory,
    });
    const toolNames = registrations.map((r) => r.name);
    expect(toolNames.includes("band_list_contacts")).toBe(capabilities.contacts);
    expect(toolNames.includes("band_list_memories")).toBe(capabilities.memory);

    // Prompt
    const instructions = buildInstructions(capabilitiesToPromptList(capabilities));
    expect(instructions.includes("band_list_contacts")).toBe(capabilities.contacts);
    expect(instructions.includes("band_list_memories")).toBe(capabilities.memory);
  });
});

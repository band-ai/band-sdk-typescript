import { z } from "zod";

import type { PromptCapability } from "./prompt.js";

/**
 * The one `AgentToolsCapabilities`-shaped object this plugin threads through
 * three consumers: `BandLink` (gates contact-event subscription —
 * `RoomPresence.subscribeContacts` checks `link.capabilities.contacts`
 * directly), `BandMcpStdioServer` (gates tool registration), and the prompt
 * builder (gates the one-line-per-capability mentions). One parse, one
 * source of truth, so the three can never silently disagree.
 *
 * Contacts default to *off*: approving a contact request widens who can
 * reach a session that runs shell commands, so that has to be opt-in.
 * Memory defaults to *on*: it only affects this agent's own persisted
 * recall, no new inbound surface.
 */
export interface PluginCapabilities {
  contacts: boolean;
  memory: boolean;
}

const BOOLEAN_ENV = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true"));

const EnvSchema = z.object({
  BAND_ENABLE_CONTACTS: BOOLEAN_ENV,
  BAND_ENABLE_MEMORY: BOOLEAN_ENV,
});

export function parseCapabilitiesFromEnv(
  env: Record<string, string | undefined> = process.env,
): PluginCapabilities {
  const parsed = EnvSchema.parse({
    BAND_ENABLE_CONTACTS: env.BAND_ENABLE_CONTACTS,
    BAND_ENABLE_MEMORY: env.BAND_ENABLE_MEMORY,
  });

  return {
    contacts: parsed.BAND_ENABLE_CONTACTS ?? false,
    memory: parsed.BAND_ENABLE_MEMORY ?? true,
  };
}

/**
 * The single derivation from `PluginCapabilities` to the prompt builder's
 * capability list, so the registered tools, the contact-event subscription,
 * and the prompt's capability lines can never silently disagree about which
 * flags are on.
 */
export function capabilitiesToPromptList(capabilities: PluginCapabilities): PromptCapability[] {
  const list: PromptCapability[] = [];
  if (capabilities.contacts) list.push("contacts");
  if (capabilities.memory) list.push("memory");
  return list;
}

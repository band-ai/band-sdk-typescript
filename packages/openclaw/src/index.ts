/**
 * @band-ai/openclaw-channel-band — OpenClaw channel plugin for the Band platform.
 *
 * Uses @thenvoi/sdk (ThenvoiLink) for all platform communication. The default
 * export is the channel plugin entry: it registers the assembled channel plugin
 * (with the live WS gateway) and, in full registration mode, the 12 band_*
 * platform-management tools.
 *
 * @packageDocumentation
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createBandChannelPlugin, BAND_CHANNEL_ID } from "./channel.js";
import { createBandGateway } from "./transport.js";
import { bandTools, executeBandTool, type BandToolContext } from "./tools.js";
import { resolveAccount } from "./state.js";

/** Resolve the tool execution context (rest + self id) for the connected account. */
function toolContext(): BandToolContext {
  // Tools get no accountId (D6), so resolve the sole connected account rather
  // than hardcoding "default" — the account is keyed by its configured id.
  const resolved = resolveAccount();
  if (!resolved) {
    throw new Error("Band account is not connected; cannot run platform tools");
  }
  return { rest: resolved.state.link.rest, selfAgentId: resolved.state.selfAgentId };
}

const plugin = createBandChannelPlugin(createBandGateway());

/**
 * Minimal portable type for the entry default export. `defineChannelPluginEntry`'s
 * own return type references non-portable internal openclaw chunks (TS2742 under
 * declaration emit); openclaw loads this entry at runtime via the manifest, so a
 * structural annotation here is correct and portable (the runtime object keeps
 * all its fields). The real return is assignable to this — no cast.
 */
export interface BandPluginEntry {
  id: string;
  name: string;
  description: string;
}

const entry: BandPluginEntry = defineChannelPluginEntry({
  id: BAND_CHANNEL_ID,
  name: "Band",
  description: "Connect OpenClaw to the Band AI agent collaboration platform",
  plugin,
  registerFull(api) {
    // Register the 12 band_* management tools. Our inputSchema is plain JSON
    // schema; the registerTool() contract is TypeBox-typed, so the tool object
    // crosses the documented JSON-schema -> TSchema interop boundary.
    for (const tool of bandTools) {
      const toolDef = {
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId: string, params: unknown) => {
          const result = await executeBandTool(toolContext(), tool.name, params ?? {});
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      };
      api.registerTool(toolDef as Parameters<typeof api.registerTool>[0]);
    }
  },
});

export default entry;

// =============================================================================
// Named exports (public API)
// =============================================================================

export { createBandChannelPlugin, BAND_CHANNEL_ID } from "./channel.js";
export {
  createBandGateway,
  createReplyDeliver,
  platformEventToInboundContext,
  roomTypeToChatType,
} from "./transport.js";
export {
  bandTools,
  getBandTool,
  executeBandTool,
  getBandToolSchemas,
  type BandTool,
  type BandToolContext,
} from "./tools.js";
export {
  resolveAccount,
  listAccountIds,
  resolveConnectionConfig,
  inspectAccount,
  validateConfig,
  DEFAULT_WS_URL,
  DEFAULT_REST_URL,
  type BandAccountConfig,
  type PluginConfig,
} from "./config.js";
export { BASE_INSTRUCTIONS, CORE_INSTRUCTIONS, CONTACT_INSTRUCTIONS, buildSystemPrompt } from "./prompts.js";
export { resolveMentions, extractExplicitMentions } from "./mentions.js";
export { getLink, getAccount, setAccount, resetAccounts } from "./state.js";

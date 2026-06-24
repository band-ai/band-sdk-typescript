/**
 * Band channel plugin assembly.
 *
 * Builds the OpenClaw `ChannelPlugin` via `createChatChannelPlugin`, wiring the
 * pieces built in earlier steps. The gateway adapter (the WS lifecycle) is
 * INJECTED so this assembly is testable in isolation and the lifecycle lives in
 * transport.ts (next step). Per the assembly findings:
 *  - gateway + mentions are spread onto the `base` object (they are top-level
 *    ChannelPlugin fields, not CreateChannelPluginBaseOptions fields) — D8/F1.
 *  - mention-gating is disabled via groups.resolveRequireMention => false (D3,
 *    corrected) so the channel trusts Band's own gating — security.dm is open.
 *  - the F2 owner-mention trim is the mentions.stripMentions adapter.
 *  - agentPrompt hosts the static BASE_INSTRUCTIONS (D5; messageToolHints only).
 *  - outbound is the attached-results adapter mapping our { messageId } onto
 *    OutboundDeliveryResult; it resolves the per-send account's link from state.
 */

import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/core";
import type {
  ChannelPlugin,
  ChannelGatewayAdapter,
  ChannelMentionAdapter,
  ChannelMessagingAdapter,
  ChannelCapabilities,
} from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildMentionRegexes } from "openclaw/plugin-sdk/channel-inbound";

import {
  resolveAccount as resolveBandAccount,
  listAccountIds as listBandAccountIds,
  inspectAccount as inspectBandAccount,
  BAND_CHANNEL_ID,
  type BandAccountConfig,
  type PluginConfig,
} from "./config.js";
import { BASE_INSTRUCTIONS } from "./prompts.js";
import { sendText as sendTextLogic, sendMedia as sendMediaLogic, type OutboundDeps } from "./outbound.js";
import { getLastSender, resolveAccount } from "./state.js";
import { bandSetupWizard, applyBandAccountConfig } from "./setup-wizard.js";

export { BAND_CHANNEL_ID };

// OpenClawConfig is a structural superset of our PluginConfig subtree (channels /
// plugins.entries). Narrow at this single integration boundary.
function asPluginConfig(cfg: OpenClawConfig): PluginConfig {
  return cfg as unknown as PluginConfig;
}

/**
 * Resolve the live outbound dependencies from the registry.
 *
 * Cross-context sends (e.g. the shared message tool invoked from a Telegram
 * session targeting Band) carry no Band accountId, so `ctx.accountId` is null;
 * `resolveAccount` then falls back to the sole connected account (the account is
 * keyed by its configured id, not "default"). An explicit id that isn't connected
 * is NOT silently substituted — it throws. Same policy as the tools path (D6).
 */
function resolveOutboundDeps(accountId?: string | null): OutboundDeps {
  const resolved = resolveAccount(accountId);
  if (!resolved) {
    throw new Error(`Band account "${accountId ?? "default"}" is not connected`);
  }
  const { accountId: id, state } = resolved;
  return {
    rest: state.link.rest,
    selfAgentId: state.selfAgentId,
    getLastSender: (roomId) => getLastSender(id, roomId) ?? null,
  };
}

/**
 * Recognize a Band send target. The shared `message` tool resolves targets via
 * the channel directory; Band has no rooms directory, so a bare room id would
 * fail with "Unknown target". `looksLikeId` tells the resolver a Band room id is
 * a valid direct target, so it skips the directory and routes the raw id to
 * outbound.sendText. Band room ids are UUIDs (the value in the [Band Room: …]
 * marker / returned by band_create_chatroom).
 */
const ROOM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const messaging: ChannelMessagingAdapter = {
  targetResolver: {
    looksLikeId: (raw) => ROOM_ID_RE.test(raw.trim()),
    hint: "<roomId> (a Band room UUID, e.g. from the [Band Room: …] marker or band_create_chatroom)",
  },
};

/** Strip a leading @agent mention so command-parse/prompt see clean text (F2). */
const mentions: ChannelMentionAdapter = {
  stripMentions: ({ text, cfg, agentId }) => {
    let out = text;
    for (const re of buildMentionRegexes(cfg, agentId)) {
      out = out.replace(re, "");
    }
    return out.trimStart();
  },
};

/**
 * Assemble the Band channel plugin. The gateway (WS lifecycle) is injected by
 * the entry point (index.ts) from transport.ts.
 */
const CAPABILITIES: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  reply: true,
  groupManagement: true,
  media: true,
};

const CONFIG_ADAPTER = {
  listAccountIds: (cfg: OpenClawConfig) => listBandAccountIds(asPluginConfig(cfg)),
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveBandAccount(asPluginConfig(cfg), accountId ?? undefined),
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    inspectBandAccount(asPluginConfig(cfg), accountId ?? undefined),
};

export function createBandChannelPlugin(
  // Optional so setup-entry can build the plugin WITHOUT importing transport
  // (the setup wizard never starts a connection). index.ts passes the real one.
  gateway: ChannelGatewayAdapter<BandAccountConfig> = {},
): ChannelPlugin<BandAccountConfig> {
  const base = {
    ...createChannelPluginBase<BandAccountConfig>({
      id: BAND_CHANNEL_ID,
      meta: {
        label: "Band",
        selectionLabel: "Band (AI collaboration)",
        blurb: "Connect to the Band AI agent collaboration platform.",
        docsPath: "/channels/band",
        aliases: ["band"],
      },
      capabilities: CAPABILITIES,
      config: CONFIG_ADAPTER,
      // Interactive `openclaw channels add` setup screen (F0 guided creds).
      setupWizard: bandSetupWizard,
      setup: {
        // Persist non-interactive `channels add --flags` input into the account.
        applyAccountConfig: ({ cfg, accountId, input }) => applyBandAccountConfig(cfg, accountId, input),
      },
      agentPrompt: {
        // Static instructions only — per-room context rides the inbound ctx
        // (the [Band Room: X] suffix), not the prompt (D5/C1).
        messageToolHints: () => [BASE_INSTRUCTIONS],
      },
      groups: {
        // Band owns mention-gating; the agent applies no DM-vs-group gating (L3).
        resolveRequireMention: () => false,
      },
    }),
    // Re-assert capabilities + config (createChannelPluginBase types them
    // optional, but ChatChannelPluginBase requires them) and attach the
    // top-level gateway + mentions adapters (not CreateChannelPluginBaseOptions
    // fields — F1/F3).
    capabilities: CAPABILITIES,
    config: CONFIG_ADAPTER,
    gateway,
    mentions,
    messaging,
  };

  return createChatChannelPlugin<BandAccountConfig>({
    base,
    security: {
      dm: {
        channelKey: BAND_CHANNEL_ID,
        // Open / process-all — Band already gated delivery (L3).
        resolvePolicy: () => "open",
        resolveAllowFrom: () => null,
        defaultPolicy: "open",
      },
    },
    threading: {
      // Band has no reply-threading; replies are routed by room + mention.
      topLevelReplyToMode: "off",
    },
    outbound: {
      base: { deliveryMode: "direct" },
      attachedResults: {
        channel: BAND_CHANNEL_ID,
        sendText: async (ctx) => {
          const { messageId } = await sendTextLogic(resolveOutboundDeps(ctx.accountId), {
            to: ctx.to,
            text: ctx.text,
          });
          return { messageId };
        },
        sendMedia: async (ctx) => {
          const { messageId } = await sendMediaLogic(resolveOutboundDeps(ctx.accountId), {
            to: ctx.to,
            text: ctx.text,
            mediaUrl: ctx.mediaUrl,
          });
          return { messageId };
        },
      },
    },
  });
}

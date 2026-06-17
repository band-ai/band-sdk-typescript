/**
 * Interactive setup wizard for the Band channel.
 *
 * Makes `openclaw channels add` (guided) prompt for the Band credentials
 * (API key + agent id, optional ws/rest URLs) and write them into
 * `channels.openclaw-channel-band.accounts.<id>`. Without this, OpenClaw reports
 * "does not have an interactive setup screen yet".
 *
 * The credential (apiKey) goes in the `credentials` array (sensitive, env-backed
 * via BAND_API_KEY); the non-secret fields go in `textInputs`. Each input owns
 * its own `applySet` that merges the value into the account config.
 */

import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  BAND_CHANNEL_ID,
  inspectAccount,
  type BandAccountConfig,
  type PluginConfig,
} from "./config.js";

const DEFAULT_ACCOUNT_ID = "default";

/** Structural view for writing our channel's account config into OpenClawConfig. */
type ConfigWithBandChannel = {
  channels?: Record<string, { enabled?: boolean; accounts?: Record<string, BandAccountConfig> }>;
};

/** Structural view for ensuring the agent can see the Band + message tools. */
type ConfigWithTools = {
  tools?: { profile?: string; allow?: string[]; alsoAllow?: string[] };
};

/**
 * Tools the agent MUST be able to see for Band to be usable: the plugin's own
 * tools (the `band_*` set, referenced by channel id) and core's shared `message`
 * tool (sending into a Band room — incl. cross-channel — flows through it).
 */
const REQUIRED_TOOLS = [BAND_CHANNEL_ID, "message"];

function mergeUnique(existing: string[] | undefined, add: string[]): string[] {
  return Array.from(new Set([...(existing ?? []), ...add]));
}

/**
 * Ensure REQUIRED_TOOLS are allowlisted so the operator doesn't have to hand-edit
 * `tools.alsoAllow`. Tool profiles (e.g. "coding") exclude plugin tools and
 * group:messaging, so a configured Band account is otherwise invisible to the
 * agent. Idempotent and additive (never removes). The config schema forbids
 * `allow` + `alsoAllow` in the same scope, so merge into whichever the operator
 * already uses; "full" exposes everything already, so leave it untouched.
 */
export function ensureBandToolsAllowed(cfg: OpenClawConfig): OpenClawConfig {
  const view = cfg as unknown as ConfigWithTools;
  const tools = { ...(view.tools ?? {}) };
  if (tools.profile === "full") return cfg;
  if (tools.allow && tools.allow.length > 0) {
    tools.allow = mergeUnique(tools.allow, REQUIRED_TOOLS);
  } else {
    tools.alsoAllow = mergeUnique(tools.alsoAllow, REQUIRED_TOOLS);
  }
  return { ...(cfg as object), tools } as OpenClawConfig;
}

/**
 * Immutably merge `patch` into `channels.openclaw-channel-band.accounts[accountId]`
 * and mark the channel enabled. OpenClawConfig.channels is strongly typed over the
 * bundled channel ids, so we narrow at this single boundary (our id is dynamic).
 */
export function setBandAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<BandAccountConfig>,
): OpenClawConfig {
  const view = cfg as unknown as ConfigWithBandChannel;
  const channels = { ...(view.channels ?? {}) };
  const channel = { ...(channels[BAND_CHANNEL_ID] ?? {}) };
  const accounts = { ...(channel.accounts ?? {}) };
  accounts[accountId] = { ...(accounts[accountId] ?? {}), ...patch };
  channel.accounts = accounts;
  channel.enabled = true;
  channels[BAND_CHANNEL_ID] = channel;
  // Also make the Band + message tools visible so the operator doesn't have to
  // hand-edit tools.alsoAllow after adding the account.
  return ensureBandToolsAllowed({ ...(cfg as object), channels } as OpenClawConfig);
}

function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  return inspectAccount(cfg as unknown as PluginConfig, accountId ?? DEFAULT_ACCOUNT_ID).configured;
}

/** Generic CLI-input field names we map onto Band account fields. */
interface BandSetupInput {
  token?: string; // --token        -> apiKey
  userId?: string; // (wizard agentId text input)
  httpUrl?: string; // --http-url    -> wsUrl
  url?: string; // --url            -> wsUrl
  baseUrl?: string; // --base-url    -> restUrl
}

/**
 * Map the non-interactive `channels add` input (ChannelSetupInput) onto our
 * account config, so flag-based setup persists too (not only the interactive
 * wizard). Used by the channel's `setup.applyAccountConfig`.
 */
export function applyBandAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: BandSetupInput,
): OpenClawConfig {
  const patch: Partial<BandAccountConfig> = {};
  if (input.token) patch.apiKey = input.token;
  if (input.userId) patch.agentId = input.userId;
  if (input.httpUrl ?? input.url) patch.wsUrl = input.httpUrl ?? input.url;
  if (input.baseUrl) patch.restUrl = input.baseUrl;
  return setBandAccountConfig(cfg, accountId, patch);
}

export const bandSetupWizard: ChannelSetupWizard = {
  channel: BAND_CHANNEL_ID,
  stepOrder: "credentials-first",
  status: {
    configuredLabel: "Band account configured",
    unconfiguredLabel: "Band account not configured",
    configuredHint: "API key + agent id present",
    unconfiguredHint: "Add a Band API key and agent id",
    resolveConfigured: ({ cfg, accountId }) => isConfigured(cfg, accountId),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: BAND_CHANNEL_ID,
      credentialLabel: "Band API key",
      preferredEnvVar: "BAND_API_KEY",
      envPrompt: "Use the BAND_API_KEY environment variable for the Band API key?",
      keepPrompt: "Keep the existing Band API key?",
      inputPrompt: "Enter your Band API key (tv_...)",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const account = (cfg as unknown as ConfigWithBandChannel).channels?.[BAND_CHANNEL_ID]?.accounts?.[accountId];
        const apiKey = account?.apiKey ?? (accountId === DEFAULT_ACCOUNT_ID ? process.env.BAND_API_KEY : undefined);
        return {
          accountConfigured: isConfigured(cfg, accountId),
          hasConfiguredValue: Boolean(account?.apiKey),
          resolvedValue: apiKey || undefined,
          envValue: accountId === DEFAULT_ACCOUNT_ID ? process.env.BAND_API_KEY || undefined : undefined,
        };
      },
      applySet: ({ cfg, accountId, resolvedValue }) =>
        setBandAccountConfig(cfg, accountId, { apiKey: resolvedValue }),
    },
  ],
  textInputs: [
    {
      inputKey: "userId",
      message: "Enter your Band agent id (UUID)",
      required: true,
      currentValue: ({ cfg, accountId }) =>
        (cfg as unknown as ConfigWithBandChannel).channels?.[BAND_CHANNEL_ID]?.accounts?.[accountId]?.agentId || undefined,
      validate: ({ value }) => (value.trim() ? undefined : "Agent id is required"),
      applySet: ({ cfg, accountId, value }) =>
        setBandAccountConfig(cfg, accountId, { agentId: value.trim() }),
    },
    {
      inputKey: "httpUrl",
      message: "Band WebSocket URL (press enter for the default)",
      required: false,
      placeholder: "wss://app.band.ai/api/v1/socket",
      currentValue: ({ cfg, accountId }) =>
        (cfg as unknown as ConfigWithBandChannel).channels?.[BAND_CHANNEL_ID]?.accounts?.[accountId]?.wsUrl || undefined,
      applySet: ({ cfg, accountId, value }) =>
        value.trim() ? setBandAccountConfig(cfg, accountId, { wsUrl: value.trim() }) : cfg,
    },
    {
      inputKey: "baseUrl",
      message: "Band REST URL (press enter for the default)",
      required: false,
      placeholder: "https://app.band.ai",
      currentValue: ({ cfg, accountId }) =>
        (cfg as unknown as ConfigWithBandChannel).channels?.[BAND_CHANNEL_ID]?.accounts?.[accountId]?.restUrl || undefined,
      applySet: ({ cfg, accountId, value }) =>
        value.trim() ? setBandAccountConfig(cfg, accountId, { restUrl: value.trim() }) : cfg,
    },
  ],
  disable: (cfg) => {
    const view = cfg as unknown as ConfigWithBandChannel;
    const channels = { ...(view.channels ?? {}) };
    channels[BAND_CHANNEL_ID] = { ...(channels[BAND_CHANNEL_ID] ?? {}), enabled: false };
    return { ...(cfg as object), channels } as OpenClawConfig;
  },
};

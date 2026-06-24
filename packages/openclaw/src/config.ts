/**
 * Configuration resolution for the Band channel.
 *
 * Pure config helpers (resolveAccount/listAccountIds/resolveConnectionConfig/
 * inspectAccount) plus a `validateConfig` whose connectivity check is injected
 * so the module stays unit-testable without a network or the SDK.
 *
 * Naming: the channel is `band` (id `openclaw-channel-band`, alias `band`).
 * Credential env vars are `BAND_*`; legacy `THENVOI_*` are still honored as a
 * fallback so existing installs don't break.
 */

import { ThenvoiLink } from "@thenvoi/sdk";

// =============================================================================
// Types
// =============================================================================

export interface BandAccountConfig {
  /** Present on the resolved account; required by createChatChannelPlugin's generic. */
  accountId?: string | null;
  enabled?: boolean;
  apiKey?: string;
  agentId?: string;
  wsUrl?: string;
  restUrl?: string;
  /** Directory for persisted state (e.g. the F1 hub id). */
  stateDir?: string;
}

type AccountsMap = Record<string, BandAccountConfig>;

export interface PluginConfig {
  channels?: {
    band?: { accounts?: AccountsMap };
    "openclaw-channel-band"?: { accounts?: AccountsMap };
  };
  plugins?: {
    entries?: {
      band?: { config?: { accounts?: AccountsMap } };
      "openclaw-channel-band"?: { config?: { accounts?: AccountsMap } };
    };
  };
}

export interface ResolvedConnection {
  apiKey: string;
  agentId: string;
  wsUrl: string;
  restUrl: string;
}

export interface AccountInspection {
  configured: boolean;
  agentId?: string;
  hasApiKey: boolean;
  wsUrl: string;
  restUrl: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/** Probes connectivity for a resolved connection; throws on failure. */
export type ConnectivityProbe = (conn: ResolvedConnection) => Promise<void>;

// =============================================================================
// Defaults
// =============================================================================

/** The channel id (also the config key under `channels.<id>`). */
export const BAND_CHANNEL_ID = "openclaw-channel-band";

export const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";
export const DEFAULT_REST_URL = "https://app.band.ai";

// =============================================================================
// Account resolution
// =============================================================================

/** Merge the plugin-entry accounts and channel accounts (channel wins). */
function mergedAccounts(config: PluginConfig): AccountsMap {
  const pluginAccounts =
    config.plugins?.entries?.["openclaw-channel-band"]?.config?.accounts ??
    config.plugins?.entries?.band?.config?.accounts ??
    {};
  const channelAccounts =
    config.channels?.["openclaw-channel-band"]?.accounts ??
    config.channels?.band?.accounts ??
    {};
  return { ...pluginAccounts, ...channelAccounts };
}

export function listAccountIds(config: PluginConfig): string[] {
  return Object.keys(mergedAccounts(config));
}

export function resolveAccount(
  config: PluginConfig,
  accountId = "default",
): BandAccountConfig {
  return mergedAccounts(config)[accountId] ?? { enabled: true };
}

// =============================================================================
// Connection resolution (account fields -> BAND_* -> THENVOI_* -> defaults)
// =============================================================================

/**
 * Single source of truth for credential/endpoint precedence:
 * account field -> BAND_* -> legacy THENVOI_* -> default. URLs always resolve
 * to a default; apiKey/agentId may be undefined (callers decide what to do).
 */
function readRawCreds(account: BandAccountConfig): {
  apiKey?: string;
  agentId?: string;
  wsUrl: string;
  restUrl: string;
} {
  return {
    apiKey: account.apiKey ?? process.env.BAND_API_KEY ?? process.env.THENVOI_API_KEY,
    agentId: account.agentId ?? process.env.BAND_AGENT_ID ?? process.env.THENVOI_AGENT_ID,
    wsUrl:
      account.wsUrl ?? process.env.BAND_WS_URL ?? process.env.THENVOI_WS_URL ?? DEFAULT_WS_URL,
    restUrl:
      account.restUrl ?? process.env.BAND_REST_URL ?? process.env.THENVOI_REST_URL ?? DEFAULT_REST_URL,
  };
}

export function resolveConnectionConfig(account: BandAccountConfig): ResolvedConnection {
  const { apiKey, agentId, wsUrl, restUrl } = readRawCreds(account);

  if (!apiKey) {
    throw new Error("Band API key is required (set account.apiKey or BAND_API_KEY)");
  }
  if (!agentId) {
    throw new Error("Band agent ID is required (set account.agentId or BAND_AGENT_ID)");
  }

  return { apiKey, agentId, wsUrl, restUrl };
}

// =============================================================================
// Inspection (secret-safe)
// =============================================================================

export function inspectAccount(config: PluginConfig, accountId = "default"): AccountInspection {
  const { apiKey, agentId, wsUrl, restUrl } = readRawCreds(resolveAccount(config, accountId));

  return {
    configured: Boolean(apiKey && agentId),
    agentId,
    hasApiKey: Boolean(apiKey),
    wsUrl,
    restUrl,
  };
}

// =============================================================================
// Validation
// =============================================================================

/** Default probe: open a temporary link, fetch agent metadata, disconnect. */
const defaultProbe: ConnectivityProbe = async (conn) => {
  let link: ThenvoiLink | null = null;
  try {
    link = new ThenvoiLink({
      agentId: conn.agentId,
      apiKey: conn.apiKey,
      wsUrl: conn.wsUrl,
      restUrl: conn.restUrl,
    });
    await link.rest.getAgentMe();
  } finally {
    if (link) {
      try {
        await link.disconnect();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
};

export async function validateConfig(
  account: BandAccountConfig,
  probe: ConnectivityProbe = defaultProbe,
): Promise<ValidationResult> {
  let conn: ResolvedConnection;
  try {
    conn = resolveConnectionConfig(account);
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  try {
    await probe(conn);
    return { valid: true };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

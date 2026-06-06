import type { ContactEventConfig } from "@thenvoi/sdk";

export interface ThenvoiAccountConfig {
  enabled?: boolean;
  apiKey?: string;
  agentId?: string;
  wsUrl?: string;
  restUrl?: string;
  contactConfig?: ContactEventConfig;
  operatorId?: string;
}

export interface PluginConfig {
  channels?: {
    thenvoi?: {
      accounts?: Record<string, ThenvoiAccountConfig>;
    };
    "openclaw-channel-thenvoi"?: {
      accounts?: Record<string, ThenvoiAccountConfig>;
    };
  };
  plugins?: {
    entries?: {
      thenvoi?: {
        config?: {
          accounts?: Record<string, ThenvoiAccountConfig>;
        };
      };
      "openclaw-channel-thenvoi"?: {
        config?: {
          accounts?: Record<string, ThenvoiAccountConfig>;
        };
      };
    };
  };
}

export interface ResolvedThenvoiAccountConfig {
  apiKey: string;
  agentId: string;
  wsUrl: string;
  restUrl: string;
}

function configuredAccounts(config: PluginConfig): Record<string, ThenvoiAccountConfig> {
  const pluginAccounts = config.plugins?.entries?.["openclaw-channel-thenvoi"]?.config?.accounts
    ?? config.plugins?.entries?.thenvoi?.config?.accounts ?? {};
  const channelAccounts = config.channels?.["openclaw-channel-thenvoi"]?.accounts
    ?? config.channels?.thenvoi?.accounts ?? {};

  return { ...pluginAccounts, ...channelAccounts };
}

function resolveEnvBackedValue(value: string | undefined, envName: string): string | undefined {
  return value && value !== `\${${envName}}` ? value : process.env[envName];
}

export function listAccountIds(config: PluginConfig): string[] {
  return Object.keys(configuredAccounts(config));
}

export function resolveAccount(config: PluginConfig, accountId?: string): ThenvoiAccountConfig {
  return configuredAccounts(config)[accountId ?? "default"] ?? { enabled: true };
}

export function resolveAccountCredentials(account: ThenvoiAccountConfig): ResolvedThenvoiAccountConfig {
  const apiKey = resolveEnvBackedValue(account.apiKey, "THENVOI_API_KEY");
  const agentId = resolveEnvBackedValue(account.agentId, "THENVOI_AGENT_ID");
  const wsUrl = resolveEnvBackedValue(account.wsUrl, "THENVOI_WS_URL") ?? "wss://app.band.ai/api/v1/socket";
  const restUrl = resolveEnvBackedValue(account.restUrl, "THENVOI_REST_URL") ?? "https://app.band.ai";

  if (!apiKey) {
    throw new Error("THENVOI_API_KEY is required");
  }
  if (!agentId) {
    throw new Error("THENVOI_AGENT_ID is required");
  }

  return { apiKey, agentId, wsUrl, restUrl };
}

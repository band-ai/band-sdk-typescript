import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { ValidationError } from "../core/errors";

export interface AgentCredentials {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  restUrl?: string;
}

export interface AgentConfigResult extends AgentCredentials {
  [key: string]: unknown;
}

const DEFAULT_CONFIG_PATH = "./agent_config.yaml";
const DEFAULT_ENV_PREFIX = "BAND_";
const LEGACY_ENV_PREFIX = "THENVOI_";

// Once-per-process dedup for legacy env-var deprecation warnings. Warnings name
// the old variable and its Band replacement only — never a secret value.
const _warnedLegacyEnvVars = new Set<string>();

function readBandFirstEnv(
  env: Record<string, string | undefined>,
  field: string,
): string | undefined {
  const bandVar = `${DEFAULT_ENV_PREFIX}${field}`;
  const bandValue = env[bandVar];
  if (bandValue !== undefined) return bandValue;
  const legacyVar = `${LEGACY_ENV_PREFIX}${field}`;
  const legacyValue = env[legacyVar];
  if (legacyValue !== undefined && !_warnedLegacyEnvVars.has(legacyVar)) {
    _warnedLegacyEnvVars.add(legacyVar);
    console.warn(`[band] ${legacyVar} is deprecated; use ${bandVar} instead`);
  }
  return legacyValue;
}

const REQUIRED_FIELDS = ["agent_id", "api_key"] as const;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf"]);

function toSnakeCase(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toSnakeCase(key)] = value;
  }
  return result;
}

function toAgentConfigResult(section: Record<string, unknown>, sourceLabel: string): AgentConfigResult {
  const missing = REQUIRED_FIELDS.filter((field) => !section[field]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields in ${sourceLabel}: ${missing.join(", ")}`,
    );
  }

  const invalid = REQUIRED_FIELDS.filter(
    (field) => {
      const value = section[field];
      return typeof value !== "string" || value.trim() === "";
    },
  );
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid fields in ${sourceLabel}: ${invalid.join(", ")} must be non-empty strings`,
    );
  }

  const { agent_id, api_key, ws_url, rest_url, ...rest } = section;

  if (ws_url !== undefined && typeof ws_url !== "string") {
    throw new ValidationError(`ws_url in ${sourceLabel} must be a string`);
  }
  if (rest_url !== undefined && typeof rest_url !== "string") {
    throw new ValidationError(`rest_url in ${sourceLabel} must be a string`);
  }

  const safeRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (!UNSAFE_KEYS.has(key)) {
      safeRest[key] = value;
    }
  }

  return {
    agentId: (agent_id as string).trim(),
    apiKey: (api_key as string).trim(),
    ...(typeof ws_url === "string" && ws_url.trim() !== "" ? { wsUrl: ws_url.trim() } : {}),
    ...(typeof rest_url === "string" && rest_url.trim() !== "" ? { restUrl: rest_url.trim() } : {}),
    ...safeRest,
  };
}

export interface LoadAgentConfigFromEnvOptions {
  env?: Record<string, string | undefined>;
  prefix?: string;
}

/** Load agent credentials from a YAML config file (defaults to `./agent_config.yaml`). */
export function loadAgentConfig(
  agentKey?: string,
  configPath?: string,
): AgentConfigResult {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new ValidationError(
      `Config file not found: ${filePath}. Copy agent_config.yaml.example to agent_config.yaml and configure your agents.`,
    );
  }

  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  if (!parsed || typeof parsed !== "object") {
    throw new ValidationError(`Invalid config file: ${filePath}. Expected a YAML object.`);
  }

  const config = parsed as Record<string, unknown>;

  // Try keyed format: config[agentKey] is an object with agent_id, api_key
  let section: Record<string, unknown>;
  if (agentKey && agentKey in config) {
    const keyed = config[agentKey];
    if (!keyed || typeof keyed !== "object") {
      throw new ValidationError(
        `Config key "${agentKey}" in ${filePath} must be an object with agent_id and api_key.`,
      );
    }
    section = normalizeKeys(keyed as Record<string, unknown>);
  } else {
    // Flat format: top-level agent_id, api_key
    section = normalizeKeys(config);
  }

  const sourceLabel = agentKey && agentKey in config
    ? `${filePath} under key "${agentKey}"`
    : filePath;
  return toAgentConfigResult(section, sourceLabel);
}

/**
 * Load agent credentials from environment variables. With no explicit prefix the
 * default is `BAND_` with a per-field fallback to the legacy `THENVOI_` variable
 * (Band wins independently for each of AGENT_ID/API_KEY/WS_URL/REST_URL, and each
 * legacy variable used warns once per process). An explicit prefix — including an
 * empty string — is used exactly, with no fallback or warning.
 */
export function loadAgentConfigFromEnv(
  options?: LoadAgentConfigFromEnvOptions,
): AgentCredentials {
  const env = options?.env ?? process.env;

  let section: Record<string, unknown>;
  let requiredHint: string;
  if (options?.prefix === undefined) {
    // Band-first default with per-field legacy fallback + once-per-process warnings.
    section = normalizeKeys({
      agent_id: readBandFirstEnv(env, "AGENT_ID"),
      api_key: readBandFirstEnv(env, "API_KEY"),
      ws_url: readBandFirstEnv(env, "WS_URL"),
      rest_url: readBandFirstEnv(env, "REST_URL"),
    });
    requiredHint = `${DEFAULT_ENV_PREFIX}AGENT_ID and ${DEFAULT_ENV_PREFIX}API_KEY (legacy ${LEGACY_ENV_PREFIX}* still accepted)`;
  } else {
    // Explicit prefix is exact — no fallback, no warning; empty prefix allowed.
    const prefix = options.prefix === "" || options.prefix.endsWith("_")
      ? options.prefix
      : `${options.prefix}_`;
    section = normalizeKeys({
      agent_id: env[`${prefix}AGENT_ID`],
      api_key: env[`${prefix}API_KEY`],
      ws_url: env[`${prefix}WS_URL`],
      rest_url: env[`${prefix}REST_URL`],
    });
    requiredHint = `${prefix}AGENT_ID and ${prefix}API_KEY`;
  }

  try {
    return toAgentConfigResult(section, `environment variables (${requiredHint})`);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(
        `${error.message}. Set ${requiredHint}, or use loadAgentConfig() for agent_config.yaml.`,
      );
    }
    throw error;
  }
}

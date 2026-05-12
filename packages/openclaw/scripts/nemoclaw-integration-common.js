import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const packageRoot = resolve(__dirname, "..");
export const DEFAULT_SANDBOX = "band-integration";
export const DEFAULT_REST_URL = "https://app.band.ai";
export const DEFAULT_WS_URL = "wss://app.band.ai/api/v1/socket";
export const PLUGIN_CONTEXT_DIR = "openclaw-channel-thenvoi";
export const PLUGIN_FILES = ["dist/index.js", "dist/index.d.ts", "openclaw.plugin.json"];
export const GENERATED_CONTEXT_MARKER = ".nemoclaw-integration-context";
export const GENERATED_CONTEXT_FILES = [
  GENERATED_CONTEXT_MARKER,
  "Dockerfile",
  "band-egress-policy.yaml",
  "openclaw-channel-thenvoi.config.example.json",
  "openclaw-channel-thenvoi.openclaw-config.json",
  `${PLUGIN_CONTEXT_DIR}/package.json`,
  ...PLUGIN_FILES.map((file) => `${PLUGIN_CONTEXT_DIR}/${file}`),
];

const PREFIXED_REDACTION_PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(gateway[-_ ]?token["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(thenvoi[-_ ]?api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(authorization["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(x-api-key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:api_?key|token|gateway_?token)=)[^\s&]+/gi,
];

const TOKEN_REDACTION_PATTERNS = [
  /\btv_[A-Za-z0-9_-]{8,}\b/g,
  /\bthnv_(?:a_|u_)?[A-Za-z0-9_-]{8,}\b/g,
  /\bband_(?:a_|u_)[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{8,}\b/g,
  /\bhf_[A-Za-z0-9_-]{8,}\b/g,
];

export function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function contextDir(opts) {
  return resolve(packageRoot, opts.context ?? `dist/nemoclaw-integration/${opts.sandbox}`);
}

export function checkGeneratedContext(opts) {
  const dir = contextDir(opts);
  const missing = GENERATED_CONTEXT_FILES.filter((file) => !existsSync(resolve(dir, file)));
  if (missing.length > 0) throw new Error(`missing generated files in ${dir}: ${missing.join(", ")}`);
  return { dir };
}

export function endpointFromUrl(raw, label) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "wss:") throw new Error("unsupported protocol");
    return { host: url.hostname, port: Number(url.port || 443), protocol: url.protocol };
  } catch {
    throw new Error(`${label} must be an https:// or wss:// URL`);
  }
}

export function hostFromUrl(raw, label) {
  return endpointFromUrl(raw, label).host;
}

export function redact(value) {
  let text = String(value instanceof Error ? value.message : value);
  for (const pattern of PREFIXED_REDACTION_PATTERNS) {
    text = text.replace(pattern, (_match, prefix) => `${prefix}[REDACTED]`);
  }
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function readRootManifestTools() {
  return readManifestTools(resolve(packageRoot, "openclaw.plugin.json"));
}

export function readContextManifestTools(dir) {
  return readManifestTools(resolve(dir, PLUGIN_CONTEXT_DIR, "openclaw.plugin.json"));
}

export function checkContextManifestTools(dir) {
  const expected = readRootManifestTools();
  const actual = readContextManifestTools(dir);
  const missing = expected.filter((tool) => !actual.includes(tool));
  const extra = actual.filter((tool) => !expected.includes(tool));
  const errors = [];

  if (missing.length > 0) errors.push(`missing tools: ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`unexpected tools: ${extra.join(", ")}`);
  if (errors.length > 0) throw new Error(errors.join("; "));

  return { tools: actual.length };
}

export function checkNemoclawList() {
  const result = runNemoclaw(["list", "--json"], "nemoclaw list --json");
  JSON.parse(result.stdout);
  return { command: "nemoclaw list --json" };
}

export function checkNemoclawStatus(sandbox) {
  runNemoclaw([sandbox, "status"], `nemoclaw ${sandbox} status`);
  return { command: `nemoclaw ${sandbox} status` };
}

export function checkNemoclawSandbox(sandbox) {
  checkNemoclawList();
  checkNemoclawStatus(sandbox);
  return { commands: ["nemoclaw list --json", `nemoclaw ${sandbox} status`] };
}

function readManifestTools(path) {
  const manifest = readJson(path);
  return manifest.capabilities?.mcp?.tools ?? [];
}

function runNemoclaw(args, label) {
  const result = spawnSync("nemoclaw", args, { encoding: "utf-8" });
  if (result.error) throw new Error("nemoclaw CLI is not installed or not on PATH");
  if (result.status !== 0) throw new Error(`${label} failed: ${redact(result.stderr || result.stdout)}`);
  return result;
}

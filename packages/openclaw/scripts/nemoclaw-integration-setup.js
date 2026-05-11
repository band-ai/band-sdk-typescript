#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_REST_URL,
  DEFAULT_SANDBOX,
  DEFAULT_WS_URL,
  GENERATED_CONTEXT_FILES,
  GENERATED_CONTEXT_MARKER,
  PLUGIN_CONTEXT_DIR,
  PLUGIN_FILES,
  endpointFromUrl,
  packageRoot,
  redact,
  requireValue,
} from "./nemoclaw-integration-common.js";

const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_PROVIDER_KEY = "inference";
const DEFAULT_PRIMARY_MODEL_REF = `${DEFAULT_PROVIDER_KEY}/${DEFAULT_MODEL}`;
const DEFAULT_INFERENCE_BASE_URL = "https://inference.local/v1";
const DEFAULT_CHAT_UI_URL = "http://127.0.0.1:18789";
const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
const PLUGIN_PATH = "/sandbox/.openclaw/extensions/openclaw-channel-thenvoi";
const PLUGIN_CONFIG_PATCH_PATH = "/tmp/openclaw-channel-thenvoi.openclaw-config.json";

const PLUGIN_PACKAGE_JSON = JSON.stringify({
  name: "openclaw-channel-thenvoi-nemoclaw",
  version: "0.0.0",
  type: "module",
  private: true,
  openclaw: {
    extensions: ["./dist/index.js"],
  },
}, null, 2);

const DOCKER_ARG_DEFAULTS = [
  ["NEMOCLAW_MODEL", DEFAULT_MODEL],
  ["NEMOCLAW_PROVIDER_KEY", DEFAULT_PROVIDER_KEY],
  ["NEMOCLAW_PRIMARY_MODEL_REF", DEFAULT_PRIMARY_MODEL_REF],
  ["NEMOCLAW_INFERENCE_BASE_URL", DEFAULT_INFERENCE_BASE_URL],
  ["NEMOCLAW_INFERENCE_API", "openai-completions"],
  ["NEMOCLAW_CONTEXT_WINDOW", "131072"],
  ["NEMOCLAW_MAX_TOKENS", "4096"],
  ["NEMOCLAW_REASONING", "false"],
  ["NEMOCLAW_INFERENCE_INPUTS", "text"],
  ["NEMOCLAW_AGENT_TIMEOUT", "600"],
  ["NEMOCLAW_AGENT_HEARTBEAT_EVERY", ""],
  ["NEMOCLAW_INFERENCE_COMPAT_B64", "e30="],
  ["CHAT_UI_URL", DEFAULT_CHAT_UI_URL],
  ["NEMOCLAW_DISABLE_DEVICE_AUTH", "0"],
];

function parseArgs(argv) {
  const opts = {
    sandbox: DEFAULT_SANDBOX,
    restUrl: DEFAULT_REST_URL,
    wsUrl: DEFAULT_WS_URL,
    dryRun: false,
    yes: false,
    embedCredentialsFromEnv: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sandbox") opts.sandbox = requireValue(argv, ++i, arg);
    else if (arg === "--from") opts.from = requireValue(argv, ++i, arg);
    else if (arg === "--base-image") opts.baseImage = requireValue(argv, ++i, arg);
    else if (arg === "--output") opts.output = requireValue(argv, ++i, arg);
    else if (arg === "--rest-url") opts.restUrl = requireValue(argv, ++i, arg);
    else if (arg === "--ws-url") opts.wsUrl = requireValue(argv, ++i, arg);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--embed-credentials-from-env") opts.embedCredentialsFromEnv = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run nemoclaw:integration:setup -- --sandbox band-integration (--from Dockerfile | --base-image image) [--dry-run] [--embed-credentials-from-env] [--yes]\n\nGenerates a NemoClaw custom-image build context for the Band OpenClaw channel.`);
}

function assertBuildOutput() {
  const missing = PLUGIN_FILES.filter((path) => !existsSync(resolve(packageRoot, path)));
  if (missing.length > 0) {
    throw new Error(`Missing build artifacts: ${missing.join(", ")}. Run pnpm --filter @thenvoi/openclaw-channel-thenvoi build first.`);
  }
}

function dockerArgs() {
  return DOCKER_ARG_DEFAULTS.map(([name, value]) => `ARG ${name}=${value}`).join("\n");
}

function openClawConfigPatchScript() {
  return [
    "const fs = require(\"node:fs\");",
    `const cfgPath = ${JSON.stringify(OPENCLAW_CONFIG_PATH)};`,
    `const cfgDir = ${JSON.stringify(OPENCLAW_CONFIG_DIR)};`,
    `const pluginPath = ${JSON.stringify(PLUGIN_PATH)};`,
    `const patchPath = ${JSON.stringify(PLUGIN_CONFIG_PATCH_PATH)};`,
    `const defaultModel = ${JSON.stringify(DEFAULT_MODEL)};`,
    `const defaultProviderKey = ${JSON.stringify(DEFAULT_PROVIDER_KEY)};`,
    `const defaultPrimaryModelRef = ${JSON.stringify(DEFAULT_PRIMARY_MODEL_REF)};`,
    `const defaultInferenceBaseUrl = ${JSON.stringify(DEFAULT_INFERENCE_BASE_URL)};`,
    `const defaultChatUiUrl = ${JSON.stringify(DEFAULT_CHAT_UI_URL)};`,
    "const env = process.env;",
    "function readJson(path, fallback) {",
    "try { return JSON.parse(fs.readFileSync(path, \"utf8\")); }",
    "catch { return fallback; }",
    "}",
    "function asInt(value, fallback) {",
    "const parsed = Number(value);",
    "return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;",
    "}",
    "function asBool(value) {",
    "return String(value || \"\").toLowerCase() === \"true\";",
    "}",
    "function readCompat() {",
    "try {",
    "return JSON.parse(Buffer.from(env.NEMOCLAW_INFERENCE_COMPAT_B64 || \"e30=\", \"base64\").toString(\"utf8\") || \"{}\");",
    "} catch { return {}; }",
    "}",
    "const cfg = readJson(cfgPath, {});",
    "const patch = readJson(patchPath, {});",
    "const compat = readCompat();",
    "const providerKey = env.NEMOCLAW_PROVIDER_KEY || defaultProviderKey;",
    "const model = env.NEMOCLAW_MODEL || defaultModel;",
    "const primary = env.NEMOCLAW_PRIMARY_MODEL_REF || providerKey + \"/\" + model;",
    "const provider = {",
    "baseUrl: env.NEMOCLAW_INFERENCE_BASE_URL || defaultInferenceBaseUrl,",
    "apiKey: \"unused\",",
    "api: env.NEMOCLAW_INFERENCE_API || \"openai-completions\",",
    "models: [{",
    "...(Object.keys(compat).length ? { compat } : {}),",
    "id: model,",
    "name: primary,",
    "reasoning: asBool(env.NEMOCLAW_REASONING),",
    "input: String(env.NEMOCLAW_INFERENCE_INPUTS || \"text\").split(\",\").map(function (value) { return value.trim(); }).filter(Boolean),",
    "cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
    "contextWindow: asInt(env.NEMOCLAW_CONTEXT_WINDOW, 131072),",
    "maxTokens: asInt(env.NEMOCLAW_MAX_TOKENS, 4096),",
    "}]",
    "};",
    "const currentModels = cfg.models || {};",
    "cfg.models = {",
    "...currentModels,",
    "mode: \"merge\",",
    "providers: { ...(currentModels.providers || {}), [providerKey]: provider },",
    "};",
    "const currentAgents = cfg.agents || {};",
    "cfg.agents = {",
    "...currentAgents,",
    "defaults: {",
    "...(currentAgents.defaults || {}),",
    "model: { primary },",
    "timeoutSeconds: asInt(env.NEMOCLAW_AGENT_TIMEOUT, 600),",
    "skipBootstrap: true,",
    "thinkingDefault: \"off\",",
    "},",
    "};",
    "const currentPlugins = cfg.plugins || {};",
    "const currentPluginLoad = currentPlugins.load || {};",
    "const patchPlugins = patch.plugins || {};",
    "const entries = {",
    "acpx: { enabled: false },",
    "bonjour: { enabled: false },",
    "qqbot: { enabled: false },",
    "...(currentPlugins.entries || {}),",
    "...(patchPlugins.entries || {}),",
    "};",
    "const loadPaths = [...new Set([...(currentPluginLoad.paths || []), pluginPath])];",
    "cfg.plugins = {",
    "...currentPlugins,",
    "load: { ...currentPluginLoad, paths: loadPaths },",
    "entries,",
    "};",
    "const currentGateway = cfg.gateway || {};",
    "const currentControlUi = currentGateway.controlUi || {};",
    "cfg.gateway = {",
    "...currentGateway,",
    "mode: \"local\",",
    "controlUi: {",
    "...currentControlUi,",
    "allowInsecureAuth: String(env.CHAT_UI_URL || \"\").startsWith(\"http://\"),",
    "dangerouslyDisableDeviceAuth: String(env.NEMOCLAW_DISABLE_DEVICE_AUTH || \"\") === \"1\",",
    "allowedOrigins: [defaultChatUiUrl],",
    "},",
    "trustedProxies: [\"127.0.0.1\", \"::1\"],",
    "auth: { ...(currentGateway.auth || {}), token: \"\" },",
    "};",
    "cfg.update = { ...(cfg.update || {}), checkOnStart: false };",
    "fs.mkdirSync(cfgDir, { recursive: true });",
    "fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));",
  ].join(" ");
}

function pluginDockerfileLayer(prefix = "") {
  return `${prefix}${dockerArgs()}

RUN mkdir -p /sandbox/.openclaw/extensions
COPY openclaw-channel-thenvoi /sandbox/.openclaw/extensions/openclaw-channel-thenvoi
RUN openclaw doctor --fix || true
COPY openclaw-channel-thenvoi.config.example.json /sandbox/.openclaw/openclaw-channel-thenvoi.config.example.json
COPY openclaw-channel-thenvoi.openclaw-config.json ${PLUGIN_CONFIG_PATCH_PATH}
RUN node -e ${JSON.stringify(openClawConfigPatchScript())}
`;
}

function dockerfile(opts) {
  if (opts.baseImage) {
    return `ARG SANDBOX_BASE=${opts.baseImage}\nFROM \${SANDBOX_BASE}\n\n${pluginDockerfileLayer()}`;
  }
  if (opts.from) {
    const baseDockerfile = readFileSync(resolve(opts.from), "utf-8");
    return `${baseDockerfile}\n\n# Added by Band NemoClaw integration setup.\n${pluginDockerfileLayer()}`;
  }
  throw new Error("Pass --base-image <image> or --from <nemoclaw-compatible-Dockerfile>. The setup command will not guess a NemoClaw base image.");
}

function policyYaml(restEndpoint, wsEndpoint) {
  const endpoints = [...new Map([restEndpoint, wsEndpoint].map((endpoint) => [`${endpoint.host}:${endpoint.port}`, endpoint])).values()];
  const policies = endpoints.map(({ host, port }) => {
    const policyName = `band-${host}-${port}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    return `  ${policyName}:\n    name: ${policyName}\n    endpoints:\n      - host: ${host}\n        port: ${port}\n        protocol: rest\n        enforcement: enforce\n        rules:\n          - allow: { method: GET, path: \"/**\" }\n          - allow: { method: POST, path: \"/**\" }\n    binaries:\n      - { path: /usr/local/bin/openclaw }`;
  }).join("\n");
  return `# Generated Band egress policy preset for NemoClaw integration.\n# Apply after onboarding with: nemoclaw <sandbox> policy-add --from-file band-egress-policy.yaml --yes\npreset:\n  name: band-openclaw-channel\n  description: Allow the OpenClaw sandbox to reach the configured Band REST/WebSocket host.\n  version: "1.0.0"\n\nnetwork_policies:\n${policies}\n`;
}

function configJson(opts, { includeCredentialPlaceholders, includeCredentialValues }) {
  const account = {
    enabled: true,
    restUrl: opts.restUrl,
    wsUrl: opts.wsUrl,
  };
  if (includeCredentialValues) {
    account.apiKey = requireEnv("THENVOI_API_KEY");
    account.agentId = requireEnv("THENVOI_AGENT_ID");
  } else if (includeCredentialPlaceholders) {
    account.apiKey = "${THENVOI_API_KEY}";
    account.agentId = "${THENVOI_AGENT_ID}";
  }
  return JSON.stringify({
    plugins: {
      entries: {
        "openclaw-channel-thenvoi": {
          enabled: true,
          config: {
            accounts: {
              default: account,
            },
          },
        },
      },
    },
  }, null, 2);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when --embed-credentials-from-env is set`);
  return value;
}

function outputDir(opts) {
  return resolve(packageRoot, opts.output ?? `dist/nemoclaw-integration/${opts.sandbox}`);
}

function assertGeneratedContext(out) {
  if (!existsSync(resolve(out, GENERATED_CONTEXT_MARKER))) {
    throw new Error(`Refusing to replace ${out}: missing ${GENERATED_CONTEXT_MARKER}. Choose an empty --output directory or remove it manually.`);
  }
}

function removeGeneratedFiles(out) {
  for (const file of [...GENERATED_CONTEXT_FILES, "README.md"]) {
    rmSync(resolve(out, file), { recursive: true, force: true });
  }
  rmSync(resolve(out, PLUGIN_CONTEXT_DIR), { recursive: true, force: true });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertBuildOutput();
  const restEndpoint = endpointFromUrl(opts.restUrl, "--rest-url");
  const wsEndpoint = endpointFromUrl(opts.wsUrl, "--ws-url");
  const out = outputDir(opts);
  const files = {
    "Dockerfile": dockerfile(opts),
    "openclaw-channel-thenvoi.config.example.json": configJson(opts, { includeCredentialPlaceholders: true, includeCredentialValues: false }),
    "openclaw-channel-thenvoi.openclaw-config.json": configJson(opts, {
      includeCredentialPlaceholders: false,
      includeCredentialValues: opts.embedCredentialsFromEnv,
    }),
    "band-egress-policy.yaml": policyYaml(restEndpoint, wsEndpoint),
    [`${PLUGIN_CONTEXT_DIR}/package.json`]: PLUGIN_PACKAGE_JSON,
  };

  console.log(`Band/NemoClaw integration setup for sandbox: ${opts.sandbox}`);
  console.log(`Output directory: ${out}`);
  console.log(`Band REST endpoint: ${restEndpoint.host}:${restEndpoint.port}`);
  console.log(`Band WS endpoint: ${wsEndpoint.host}:${wsEndpoint.port}`);

  if (opts.dryRun) {
    console.log("Dry run: would write files:");
    for (const name of [...Object.keys(files), `${PLUGIN_CONTEXT_DIR}/openclaw.plugin.json`, `${PLUGIN_CONTEXT_DIR}/dist/*`]) console.log(`- ${name}`);
    console.log(`Next: nemoclaw onboard --from ${resolve(out, "Dockerfile")} --name ${opts.sandbox}`);
    return;
  }

  if (existsSync(out)) {
    if (!opts.yes) throw new Error(`Output directory already exists: ${out}. Pass --yes to replace generated integration files.`);
    assertGeneratedContext(out);
    removeGeneratedFiles(out);
  }

  mkdirSync(resolve(out, PLUGIN_CONTEXT_DIR), { recursive: true });
  writeFileSync(resolve(out, GENERATED_CONTEXT_MARKER), "generated by nemoclaw:integration:setup\n");
  for (const [name, content] of Object.entries(files)) {
    const target = resolve(out, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  copyFileSync(resolve(packageRoot, "openclaw.plugin.json"), resolve(out, PLUGIN_CONTEXT_DIR, "openclaw.plugin.json"));
  for (const entry of readdirSync(resolve(packageRoot, "dist"), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = resolve(out, PLUGIN_CONTEXT_DIR, "dist", entry.name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(packageRoot, "dist", entry.name), target);
  }

  console.log(`Wrote ${readdirSync(out).length} top-level entries.`);
  console.log(`Next: nemoclaw onboard --from ${resolve(out, "Dockerfile")} --name ${opts.sandbox}`);
}

try {
  main();
} catch (error) {
  console.error(redact(error));
  process.exit(1);
}

#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SANDBOX,
  checkContextManifestTools,
  checkGeneratedContext,
  checkNemoclawList,
  checkNemoclawStatus,
  contextDir,
  endpointFromUrl,
  readJson,
  redact,
  requireValue,
} from "./nemoclaw-integration-common.js";

function parseArgs(argv) {
  const opts = { sandbox: DEFAULT_SANDBOX, context: undefined, contextOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sandbox") opts.sandbox = requireValue(argv, ++i, arg);
    else if (arg === "--context") opts.context = requireValue(argv, ++i, arg);
    else if (arg === "--context-only") opts.contextOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm run nemoclaw:integration:preflight -- --sandbox band-integration [--context path] [--context-only]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function layer(name, fn) {
  try {
    const evidence = fn();
    return { layer: name, status: "pass", evidence };
  } catch (error) {
    return { layer: name, status: "fail", message: redact(error) };
  }
}

function checkTools(opts) {
  const dir = contextDir(opts);
  const evidence = checkContextManifestTools(dir);
  const manifest = readJson(resolve(dir, "openclaw-channel-thenvoi/openclaw.plugin.json"));
  if (typeof manifest.entry !== "string" || !manifest.entry) throw new Error("plugin manifest missing entry");
  if (!existsSync(resolve(dir, "openclaw-channel-thenvoi", manifest.entry))) {
    throw new Error(`plugin manifest entry does not exist in generated context: ${manifest.entry}`);
  }
  const packageJson = readJson(resolve(dir, "openclaw-channel-thenvoi/package.json"));
  const extensions = packageJson.openclaw?.extensions ?? [];
  if (!Array.isArray(extensions) || !extensions.includes(`./${manifest.entry}`)) {
    throw new Error(`plugin package.json must declare openclaw.extensions entry ./${manifest.entry}`);
  }
  return { ...evidence, entry: manifest.entry, packageExtensions: extensions.length };
}

function checkPolicy(opts) {
  const dir = contextDir(opts);
  const policy = readFileSync(resolve(dir, "band-egress-policy.yaml"), "utf-8");
  const config = readJson(resolve(dir, "openclaw-channel-thenvoi.config.example.json"));
  const account = config.plugins?.entries?.["openclaw-channel-thenvoi"]?.config?.accounts?.default;
  const endpoints = [endpointFromUrl(account?.restUrl, "config template restUrl"), endpointFromUrl(account?.wsUrl, "config template wsUrl")];
  const hosts = endpoints.map((endpoint) => endpoint.host);
  if (!policy.includes("preset:")) throw new Error("policy missing preset metadata root");
  if (!policy.includes("name: band-openclaw-channel")) throw new Error("policy preset.name must be the lowercase NemoClaw preset id");
  if (!policy.includes("network_policies:")) throw new Error("policy missing network_policies root");
  for (const endpoint of new Map(endpoints.map((value) => [`${value.host}:${value.port}`, value])).values()) {
    if (!policy.includes(`host: ${endpoint.host}`)) throw new Error(`policy missing ${endpoint.host} host`);
    if (!policy.includes(`port: ${endpoint.port}`)) throw new Error(`policy missing ${endpoint.host}:${endpoint.port} port`);
  }
  if (policy.includes("host: *") || policy.includes("host: \"*\"")) throw new Error("policy must not use wildcard egress");
  if (!policy.includes("access: full")) throw new Error("policy missing full Band HTTP/WebSocket access");
  if (!policy.includes("tls: skip")) throw new Error("policy missing Band CONNECT tunnel allowance");
  return { file: "band-egress-policy.yaml", hosts: [...new Set(hosts)] };
}

function checkConfigTemplate(opts) {
  const dir = contextDir(opts);
  const config = readFileSync(resolve(dir, "openclaw-channel-thenvoi.config.example.json"), "utf-8");
  if (!config.includes("${THENVOI_API_KEY}")) throw new Error("config template missing THENVOI_API_KEY placeholder");
  if (!config.includes("${THENVOI_AGENT_ID}")) throw new Error("config template missing THENVOI_AGENT_ID placeholder");
  if (/(?:tv_|band_a_)[A-Za-z0-9_-]{8,}/.test(config)) throw new Error("config template contains a real-looking Band API key");

  const runtimeConfig = readJson(resolve(dir, "openclaw-channel-thenvoi.openclaw-config.json"));
  const account = runtimeConfig.plugins?.entries?.["openclaw-channel-thenvoi"]?.config?.accounts?.default;
  if (account?.enabled !== true) throw new Error("runtime OpenClaw config must enable the default Band account");
  if (!account.restUrl || !account.wsUrl) throw new Error("runtime OpenClaw config missing Band REST/WebSocket URLs");

  return {
    files: ["openclaw-channel-thenvoi.config.example.json", "openclaw-channel-thenvoi.openclaw-config.json"],
    placeholders: ["THENVOI_API_KEY", "THENVOI_AGENT_ID"],
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [
    layer("build_context", () => checkGeneratedContext(opts)),
    layer("manifest_tools", () => checkTools(opts)),
    layer("band_egress_policy", () => checkPolicy(opts)),
    layer("band_config_template", () => checkConfigTemplate(opts)),
  ];
  if (!opts.contextOnly) {
    results.push(layer("nemoclaw_cli", checkNemoclawList), layer("sandbox_status", () => checkNemoclawStatus(opts.sandbox)));
  }
  console.log(JSON.stringify({ mode: opts.contextOnly ? "context" : "offline", sandbox: opts.sandbox, results }, null, 2));
  if (results.some((result) => result.status === "fail")) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(redact(error));
  process.exit(1);
}

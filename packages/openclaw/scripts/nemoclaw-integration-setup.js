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

function pluginDockerfileLayer(prefix = "") {
  return `${prefix}RUN mkdir -p /sandbox/.openclaw/extensions\nCOPY openclaw-channel-thenvoi /sandbox/.openclaw/extensions/openclaw-channel-thenvoi\nRUN openclaw doctor --fix\nCOPY openclaw-channel-thenvoi.config.example.json /sandbox/.openclaw/openclaw-channel-thenvoi.config.example.json\nCOPY openclaw-channel-thenvoi.openclaw-config.json /tmp/openclaw-channel-thenvoi.openclaw-config.json\nRUN node -e 'const fs=require("node:fs"); const cfgPath="/sandbox/.openclaw/openclaw.json"; const cfg=JSON.parse(fs.readFileSync(cfgPath,"utf8")); const patch=JSON.parse(fs.readFileSync("/tmp/openclaw-channel-thenvoi.openclaw-config.json","utf8")); cfg.plugins={...(cfg.plugins||{}), entries:{...((cfg.plugins||{}).entries||{}), ...patch.plugins.entries}}; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));'\n`;
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
  };

  console.log(`Band/NemoClaw integration setup for sandbox: ${opts.sandbox}`);
  console.log(`Output directory: ${out}`);
  console.log(`Band REST endpoint: ${restEndpoint.host}:${restEndpoint.port}`);
  console.log(`Band WS endpoint: ${wsEndpoint.host}:${wsEndpoint.port}`);

  if (opts.dryRun) {
    console.log("Dry run: would write files:");
    for (const name of [...Object.keys(files), ...PLUGIN_FILES.map((name) => `${PLUGIN_CONTEXT_DIR}/${name}`)]) console.log(`- ${name}`);
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
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
  for (const file of PLUGIN_FILES) {
    const source = resolve(packageRoot, file);
    const target = resolve(out, PLUGIN_CONTEXT_DIR, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
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

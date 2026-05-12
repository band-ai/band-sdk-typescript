#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  DEFAULT_REST_URL,
  DEFAULT_SANDBOX,
  DEFAULT_WS_URL,
  endpointFromUrl,
  redact,
  requireValue,
} from "./nemoclaw-integration-common.js";

function parseArgs(argv) {
  const opts = {
    sandbox: DEFAULT_SANDBOX,
    restUrl: process.env.THENVOI_REST_URL ?? DEFAULT_REST_URL,
    wsUrl: process.env.THENVOI_WS_URL ?? DEFAULT_WS_URL,
    restart: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sandbox") opts.sandbox = requireValue(argv, ++i, arg);
    else if (arg === "--rest-url") opts.restUrl = requireValue(argv, ++i, arg);
    else if (arg === "--ws-url") opts.wsUrl = requireValue(argv, ++i, arg);
    else if (arg === "--no-restart") opts.restart = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  endpointFromUrl(opts.restUrl, "--rest-url");
  endpointFromUrl(opts.wsUrl, "--ws-url");
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run nemoclaw:integration:configure -- --sandbox band-integration [--no-restart]\n\nWrites non-secret Band account settings into the running NemoClaw sandbox OpenClaw config with nemoclaw <sandbox> config set. The Band API key is kept as the \${THENVOI_API_KEY} runtime placeholder so it is not exposed in the config command argv.`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configSetArgs(sandbox, key, value, restart) {
  const args = [
    sandbox,
    "config",
    "set",
    "--key",
    key,
    "--value",
    value,
    "--config-accept-new-path",
  ];
  if (restart) args.push("--restart");
  return args;
}

function runConfigSet(args) {
  const result = spawnSync("nemoclaw", args, {
    encoding: "utf-8",
    env: { ...process.env, NEMOCLAW_CONFIG_ACCEPT_NEW_PATH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error("nemoclaw CLI is not installed or not on PATH");
  if (result.status !== 0) {
    throw new Error(redact(result.stderr || result.stdout || `nemoclaw ${args.slice(0, 3).join(" ")} failed`));
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const values = [
    ["plugins.entries.openclaw-channel-thenvoi.config.accounts.default.restUrl", opts.restUrl],
    ["plugins.entries.openclaw-channel-thenvoi.config.accounts.default.wsUrl", opts.wsUrl],
    ["plugins.entries.openclaw-channel-thenvoi.config.accounts.default.agentId", requireEnv("THENVOI_AGENT_ID")],
    ["plugins.entries.openclaw-channel-thenvoi.config.accounts.default.apiKey", "${THENVOI_API_KEY}"],
  ];

  if (process.env.THENVOI_OPERATOR_ID) {
    values.push(["plugins.entries.openclaw-channel-thenvoi.config.accounts.default.operatorId", process.env.THENVOI_OPERATOR_ID]);
  }

  if (process.env.THENVOI_CONTACT_STRATEGY) {
    values.push([
      "plugins.entries.openclaw-channel-thenvoi.config.accounts.default.contactConfig.strategy",
      process.env.THENVOI_CONTACT_STRATEGY,
    ]);
    values.push([
      "plugins.entries.openclaw-channel-thenvoi.config.accounts.default.contactConfig.broadcastChanges",
      "true",
    ]);
    if (process.env.THENVOI_CONTACT_HUB_TASK_ID) {
      values.push([
        "plugins.entries.openclaw-channel-thenvoi.config.accounts.default.contactConfig.hubTaskId",
        process.env.THENVOI_CONTACT_HUB_TASK_ID,
      ]);
    }
  }

  values.forEach(([key, value], index) => {
    runConfigSet(configSetArgs(opts.sandbox, key, value, opts.restart && index === values.length - 1));
  });

  console.log(`Configured Band account metadata for NemoClaw sandbox '${opts.sandbox}'. The apiKey config remains the \${THENVOI_API_KEY} runtime placeholder; no Band API key was passed to nemoclaw config set.`);
}

try {
  main();
} catch (error) {
  console.error(redact(error));
  process.exit(1);
}

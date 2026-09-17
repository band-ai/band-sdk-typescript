#!/usr/bin/env node
/**
 * Startup smoke for runnable examples: spawn the documented tsx entry, confirm
 * the process stays alive past the readiness window, then tear down.
 *
 * Uses repo `.env.test` (via --env-file) and `agent_config.yaml` in the SDK
 * package (run `pnpm run examples:config` first). Skips examples whose declared
 * env dependencies are absent unless --no-skip-missing-env.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discover, sdkRoot } from "./examples-discover.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = sdkRoot(__dirname);
const REPO_ROOT = path.resolve(SDK_ROOT, "..", "..");

const STARTUP_READINESS_MS = 2000;
const TERMINATE_GRACE_MS = 8000;

/** Env vars that must be set (by name) before attempting a family. */
const FAMILY_ENV_GATES = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  "claude-sdk": ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  "copilot-acp": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL"],
  "omp-acp": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "a2a-bridge": ["A2A_AGENT_URL"],
  letta: ["LETTA_BASE_URL"],
  parlant: ["PARLANT_API_KEY"],
  "linear-band": ["LINEAR_API_KEY"],
};

/**
 * @param {string} family
 * @param {NodeJS.ProcessEnv} env
 */
function familyEnvSatisfied(family, env) {
  const gates = FAMILY_ENV_GATES[family];
  if (!gates) {
    return true;
  }
  return gates.some((name) => Boolean(env[name]));
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} signal
 */
function signalProcessGroup(child, signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
async function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGINT");
  await new Promise((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS));
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGKILL");
}

/**
 * @param {string} examplePath relative to SDK_ROOT
 * @param {{ envFile: string, env: NodeJS.ProcessEnv, logDir: string }} options
 */
async function runOne(examplePath, options) {
  const tsxCli = path.join(SDK_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    throw new Error("tsx is not installed — run pnpm install in packages/sdk");
  }
  const absExample = path.join(SDK_ROOT, examplePath);
  const logPath = path.join(options.logDir, `${examplePath.replace(/\//g, "_")}.log`);
  const logFd = fs.openSync(logPath, "w");

  const child = spawn(
    process.execPath,
    ["--env-file", options.envFile, tsxCli, absExample],
    {
      cwd: SDK_ROOT,
      env: { ...options.env },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  fs.closeSync(logFd);

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  await new Promise((resolve) => setTimeout(resolve, STARTUP_READINESS_MS));
  if (child.exitCode !== null || child.signalCode !== null) {
    const outcome = await exitPromise;
    return {
      status: "fail",
      detail: `exited during startup (${outcome.code ?? outcome.signal}); log: ${logPath}`,
    };
  }

  await terminateProcess(child);
  await exitPromise;
  return { status: "pass", detail: "OK_RUNNING" };
}

function parseArgs(argv) {
  /** @type {{ json: boolean, family: string | null, skipMissingEnv: boolean, envFile: string, only: string[] }} */
  const args = {
    json: false,
    family: null,
    skipMissingEnv: true,
    envFile: path.join(REPO_ROOT, ".env.test"),
    only: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--family" && argv[i + 1]) {
      args.family = argv[++i];
    } else if (arg === "--env-file" && argv[i + 1]) {
      args.envFile = path.resolve(argv[++i]);
    } else if (arg === "--only" && argv[i + 1]) {
      args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--no-skip-missing-env") {
      args.skipMissingEnv = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node examples-smoke-startup.mjs [--family NAME] [--only path.ts,...] [--env-file PATH] [--json] [--no-skip-missing-env]`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.join(SDK_ROOT, "agent_config.yaml");
  if (!fs.existsSync(configPath)) {
    console.error("Missing packages/sdk/agent_config.yaml — run: pnpm run examples:config");
    process.exit(1);
  }
  if (!fs.existsSync(args.envFile)) {
    console.error(`Env file not found: ${args.envFile}`);
    process.exit(1);
  }

  const env = { ...process.env };
  for (const line of fs.readFileSync(args.envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in env)) {
      env[key] = value;
    }
  }

  let examples = discover({ family: args.family });
  if (args.only.length > 0) {
    const wanted = new Set(args.only);
    examples = examples.filter((item) => wanted.has(item.path));
  }

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "band-ts-example-smoke-"));
  /** @type {{ path: string, status: string, detail: string }[]} */
  const results = [];

  for (const example of examples) {
    if (args.skipMissingEnv && !familyEnvSatisfied(example.family, env)) {
      results.push({ path: example.path, status: "skip", detail: "missing family env gate" });
      console.log(`SKIP ${example.path} — missing env for family ${example.family || "(root)"}`);
      continue;
    }
    try {
      const outcome = await runOne(example.path, { envFile: args.envFile, env, logDir });
      results.push({ path: example.path, status: outcome.status, detail: outcome.detail });
      console.log(`${outcome.status.toUpperCase()} ${example.path} — ${outcome.detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ path: example.path, status: "fail", detail });
      console.log(`FAIL ${example.path} — ${detail}`);
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`SUMMARY passed=${passed} failed=${failed} skipped=${skipped}`);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

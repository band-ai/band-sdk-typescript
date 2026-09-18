#!/usr/bin/env node
/**
 * Discover runnable TS examples and the configuration they consume.
 *
 * stdout is this tool's interface (table or --json). Mirrors band-sdk-python
 * `.claude/skills/bug-hunting-via-example/scripts/discover.py` for this repo's
 * examples/*.ts trees + isDirectExecution entry points.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function sdkRoot(fromDir = __dirname) {
  const root = path.resolve(fromDir, "..");
  if (!fs.existsSync(path.join(root, "package.json")) || !fs.existsSync(path.join(root, "examples"))) {
    throw new Error(`${path.basename(__filename)} must live under packages/sdk/scripts/; got ${root}`);
  }
  return root;
}

const SDK_ROOT = sdkRoot();
const EXAMPLES_ROOT = path.join(SDK_ROOT, "examples");

const DOCUMENTED_COMMAND = /^\s*(pnpm exec tsx\s+\S+|tsx\s+\S+|node\s+--env-file=\S+\s+\S+\s+examples\/\S+)\s*$/gm;

const LOAD_AGENT_CONFIG = /loadAgentConfig\s*\(\s*["']([^"']+)["']/g;
const LOAD_FROM_ENV = /loadAgentConfigFromEnv\s*\(/;
const DIRECT_EXEC = /isDirectExecution\s*\(\s*import\.meta\.url\s*\)/;
const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const ENV_BRACKET = /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g;

/** @typedef {{ path: string, family: string, summary: string, configKeys: string[], environment: string[], documentedCommands: string[], runnable: boolean }} Example */

/**
 * @param {string} relativeToExamples
 */
function exampleFamily(relativeToExamples) {
  const parts = relativeToExamples.split(path.sep).filter(Boolean);
  return parts.length > 1 ? parts[0] : "";
}

/**
 * @param {string} source
 */
function docstringSummary(source) {
  const block = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!block) {
    return "";
  }
  for (const line of block[1].split("\n")) {
    const trimmed = line.replace(/^\s*\*\s?/, "").trim();
    if (trimmed && !trimmed.startsWith("@") && !trimmed.toLowerCase().startsWith("run")) {
      return trimmed;
    }
  }
  return "";
}

/**
 * @param {string} source
 */
function documentedCommands(source) {
  const block = source.match(/\/\*\*([\s\S]*?)\*\//);
  const haystack = block ? block[1] : source;
  const found = [...haystack.matchAll(DOCUMENTED_COMMAND)].map((m) => m[1].trim());
  return [...new Set(found)];
}

/**
 * @param {string} source
 */
function inspectConfiguration(source) {
  /** @type {Set<string>} */
  const configKeys = new Set();
  for (const match of source.matchAll(LOAD_AGENT_CONFIG)) {
    configKeys.add(match[1]);
  }
  /** @type {Set<string>} */
  const environment = new Set();
  if (LOAD_FROM_ENV.test(source)) {
    environment.add("(loadAgentConfigFromEnv)");
  }
  for (const match of source.matchAll(ENV_READ)) {
    environment.add(match[1]);
  }
  for (const match of source.matchAll(ENV_BRACKET)) {
    environment.add(match[1]);
  }
  return { configKeys, environment };
}

/**
 * @param {string} filePath
 * @returns {Example | null}
 */
function inspectExample(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!DIRECT_EXEC.test(source)) {
    return null;
  }
  const { configKeys, environment } = inspectConfiguration(source);
  if (configKeys.size === 0 && !LOAD_FROM_ENV.test(source)) {
    return null;
  }
  const rel = path.relative(SDK_ROOT, filePath);
  const relExamples = path.relative(EXAMPLES_ROOT, filePath);
  return {
    path: rel.split(path.sep).join("/"),
    family: exampleFamily(relExamples),
    summary: docstringSummary(source),
    configKeys: [...configKeys].sort(),
    environment: [...environment].sort(),
    documentedCommands: documentedCommands(source),
    runnable: true,
  };
}

/**
 * @param {{ family?: string | null }} options
 * @returns {Example[]}
 */
export function discover(options = {}) {
  /** @type {Example[]} */
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const item = inspectExample(full);
        if (item) {
          found.push(item);
        }
      }
    }
  };
  walk(EXAMPLES_ROOT);
  found.sort((a, b) => a.path.localeCompare(b.path));
  if (options.family) {
    return found.filter((item) => item.family === options.family);
  }
  return found;
}

function parseArgs(argv) {
  const args = { json: false, family: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--json") {
      args.json = true;
    } else if (argv[i] === "--family" && argv[i + 1]) {
      args.family = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: node examples-discover.mjs [--json] [--family NAME]`);
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const examples = discover({ family: args.family });
  if (args.json) {
    console.log(JSON.stringify(examples, null, 2));
    return;
  }
  for (const example of examples) {
    const keys = example.configKeys.join(",") || "-";
    const summary = example.summary || "(no summary)";
    console.log(`${example.path}\tconfig=${keys}\t${summary}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

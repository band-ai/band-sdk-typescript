/**
 * Run real examples through live Band provisioning (independent topology).
 *
 * POSIX-only process groups; YAML plan format matches band-sdk-python's
 * bug-hunting-via-example runner seam (simplified: independent scenarios only).
 *
 * Usage (from packages/sdk):
 *   node --env-file=../../.env.test ./node_modules/tsx/dist/cli.mjs scripts/example-runner.ts /tmp/plan.yaml --dry-run
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dump as dumpYaml, load as loadYaml } from "js-yaml";

import { assertReplyOnlyBarrier } from "./example-runner-barriers.js";

import { FernRestAdapter } from "../src/rest";
import { BandClient } from "@band-ai/rest-client";
import {
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sweepOrphans,
  type ProvisionedAgent,
} from "../tests/integration/support/liveHarness";

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SDK_ROOT, "..", "..");

const STARTUP_READINESS_MS = 2000;
const TERMINATE_GRACE_MS = 8000;
const STEP_TIMEOUT_MS = 120_000;

const PROCESS_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

const DRIVER_CREDENTIAL_PREFIX = "BAND_API_KEY";
const HARNESS_ENDPOINT_VARIABLES = new Set(["BAND_REST_URL", "BAND_WS_URL", "BAND_BASE_URL"]);

interface Step {
  prompt: string;
  barrier: "reply" | "processed";
  containsAny: string[];
}

interface ExampleSpec {
  id: string;
  path: string;
  configKey: string;
  command: string[];
  environment: Record<string, string>;
  forwardEnv: string[];
  steps: Step[];
}

interface Plan {
  examples: ExampleSpec[];
}

interface Result {
  scenario: string;
  example: string;
  status: "pass" | "fail";
  detail?: string;
}

function recordResult(results: Result[], result: Result): void {
  results.push(result);
  const detail = result.detail ? ` — ${result.detail}` : "";
  console.log(`${result.status.toUpperCase()} ${result.scenario} ${result.example}${detail}`);
}

async function resolveExamplePath(relativePath: string): Promise<string> {
  const resolved = path.resolve(SDK_ROOT, relativePath);
  if (!resolved.startsWith(SDK_ROOT) || !resolved.endsWith(".ts")) {
    throw new Error(`example path is outside packages/sdk or not a .ts file: ${relativePath}`);
  }
  try {
    await access(resolved, fsConstants.R_OK);
  } catch {
    throw new Error(`example path does not exist: ${relativePath}`);
  }
  return resolved;
}

function parseStep(raw: unknown, label: string): Step {
  if (!raw || typeof raw !== "object" || !("prompt" in raw) || typeof (raw as Step).prompt !== "string") {
    throw new Error(`${label} requires prompt`);
  }
  const step = raw as {
    prompt: string;
    barrier?: string;
    contains_any?: string[];
  };
  const barrier = step.barrier ?? "reply";
  assertReplyOnlyBarrier(barrier);
  const containsAny = Array.isArray(step.contains_any)
    ? step.contains_any.filter((item): item is string => typeof item === "string")
    : [];
  return { prompt: step.prompt, barrier: barrier as Step["barrier"], containsAny };
}

async function parseExample(raw: unknown, index: number): Promise<ExampleSpec> {
  const label = `examples[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new Error(`${label} must be a mapping`);
  }
  const item = raw as Record<string, unknown>;
  const id = item.id;
  const configKey = item.config_key;
  const examplePath = item.path;
  if (typeof id !== "string" || !id) {
    throw new Error(`${label}.id must be a non-empty string`);
  }
  if (typeof configKey !== "string" || !configKey) {
    throw new Error(`${label}.config_key must be a non-empty string`);
  }
  if (typeof examplePath !== "string" || !examplePath) {
    throw new Error(`${label}.path must be a non-empty string`);
  }
  await resolveExamplePath(examplePath);

  const command = Array.isArray(item.command)
    ? item.command.filter((part): part is string => typeof part === "string")
    : [];
  const environment =
    item.env && typeof item.env === "object" && !Array.isArray(item.env)
      ? Object.fromEntries(
          Object.entries(item.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        )
      : {};
  const forwardEnv = Array.isArray(item.forward_env)
    ? item.forward_env.filter((name): name is string => typeof name === "string")
    : [];
  const stepsRaw = item.steps;
  const steps = Array.isArray(stepsRaw)
    ? stepsRaw.map((step, stepIndex) => parseStep(step, `${label}.steps[${stepIndex}]`))
    : [];

  const configured = new Set([...Object.keys(environment), ...forwardEnv]);
  for (const name of configured) {
    if (HARNESS_ENDPOINT_VARIABLES.has(name)) {
      throw new Error(`harness endpoint variables cannot be configured by a plan: ${name}`);
    }
    if (name.startsWith(DRIVER_CREDENTIAL_PREFIX)) {
      throw new Error(`a child example must never receive the run's Band user key: ${name}`);
    }
  }

  return { id, path: examplePath, configKey, command, environment, forwardEnv, steps };
}

async function loadPlan(planPath: string): Promise<Plan> {
  const raw = loadYaml(await readFile(planPath, "utf8")) as Record<string, unknown> | null;
  if (!raw || raw.version !== 1) {
    throw new Error("plan.version must be 1");
  }
  const examplesRaw = raw.examples;
  if (!Array.isArray(examplesRaw) || examplesRaw.length === 0) {
    throw new Error("plan.examples must be a non-empty list");
  }
  const examples = await Promise.all(examplesRaw.map((item, index) => parseExample(item, index)));
  const ids = examples.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("example ids must be unique");
  }
  return { examples };
}

function formatTemplate(
  value: string,
  values: { marker: string; roomId?: string; repo: string; path: string; workdir: string },
): string {
  return value
    .replaceAll("{marker}", values.marker)
    .replaceAll("{room_id}", values.roomId ?? "")
    .replaceAll("{repo}", values.repo)
    .replaceAll("{path}", values.path)
    .replaceAll("{workdir}", values.workdir);
}

async function writeAgentConfig(
  configKey: string,
  agent: ProvisionedAgent,
  workdir: string,
  restUrl: string,
  wsUrl: string | undefined,
): Promise<void> {
  const profile: Record<string, string> = {
    agent_id: agent.id,
    api_key: agent.apiKey,
    rest_url: restUrl,
  };
  if (wsUrl) {
    profile.ws_url = wsUrl;
  }
  const document = dumpYaml({ [configKey]: profile });
  await writeFile(path.join(workdir, "agent_config.yaml"), document, { mode: 0o600 });
}

function exampleCommand(spec: ExampleSpec, workdir: string, absoluteExamplePath: string): string[] {
  const values = { repo: REPO_ROOT, path: absoluteExamplePath, workdir };
  if (spec.command.length > 0) {
    return spec.command.map((part) => formatTemplate(part, { marker: "", ...values }));
  }
  const tsxCli = path.join(SDK_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return [process.execPath, tsxCli, values.path];
}

function exampleEnvironment(
  spec: ExampleSpec,
  workdir: string,
  restUrl: string,
  wsUrl: string | undefined,
  absoluteExamplePath: string,
): NodeJS.ProcessEnv {
  const values = { repo: REPO_ROOT, path: absoluteExamplePath, workdir };
  const environment: NodeJS.ProcessEnv = {};
  for (const name of PROCESS_ENV_ALLOWLIST) {
    if (process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  for (const name of spec.forwardEnv) {
    if (process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries(spec.environment)) {
    environment[name] = formatTemplate(value, { marker: "", ...values });
  }
  environment.BAND_REST_URL = restUrl;
  if (wsUrl) {
    environment.BAND_WS_URL = wsUrl;
  }
  return environment;
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
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

async function startExample(
  spec: ExampleSpec,
  agent: ProvisionedAgent,
  restUrl: string,
  wsUrl: string | undefined,
  logPath: string,
  absoluteExamplePath: string,
): Promise<{ child: ReturnType<typeof spawn>; workdir: string; logPath: string }> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), `band-example-${spec.id}-`));
  await writeAgentConfig(spec.configKey, agent, workdir, restUrl, wsUrl);
  const logFd = await import("node:fs/promises").then((fs) => fs.open(logPath, "w"));
  const argv = exampleCommand(spec, workdir, absoluteExamplePath);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: workdir,
    env: exampleEnvironment(spec, workdir, restUrl, wsUrl, absoluteExamplePath),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  await logFd.close();

  await new Promise((resolve) => setTimeout(resolve, STARTUP_READINESS_MS));
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${spec.id} exited during startup; child log: ${logPath}`);
  }
  return { child, workdir, logPath };
}

async function waitForReply(
  userRest: FernRestAdapter,
  roomId: string,
  agentId: string,
  sinceIso: string,
  expectedSubstrings: string[],
): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const needles = expectedSubstrings.map((value) => value.toLowerCase()).filter(Boolean);
  while (Date.now() < deadline) {
    try {
      const page = await userRest.listMessages({ chatId: roomId, page: 1, pageSize: 100 });
      const match = page.data.some(
        (message) =>
          message.sender_id === agentId
          && typeof message.inserted_at === "string"
          && message.inserted_at >= sinceIso
          && needles.some((needle) => message.content.toLowerCase().includes(needle)),
      );
      if (match) {
        return;
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`waitForReply timed out after ${STEP_TIMEOUT_MS}ms`);
}

async function exerciseExample(
  spec: ExampleSpec,
  results: Result[],
  runId: string,
): Promise<void> {
  const { restUrl, wsUrl, userClient, userApiKey } = loadLiveEnv();
  const userRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: userApiKey }));
  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let child: ReturnType<typeof spawn> | null = null;
  let workdir: string | null = null;
  const logPath = path.join(os.tmpdir(), `band-example-${spec.id}-${runId}.log`);

  try {
    const agent = await provisionAgent(userClient, runId, "example-runner", spec.id);
    provisioned.push(agent);
    const absoluteExamplePath = await resolveExamplePath(spec.path);
    const started = await startExample(spec, agent, restUrl, wsUrl, logPath, absoluteExamplePath);
    child = started.child;
    workdir = started.workdir;

    const chat = await userRest.createChat();
    roomIds.push(chat.id);
    await userRest.addChatParticipant(chat.id, { participantId: agent.id, role: "member" });

    const steps =
      spec.steps.length > 0
        ? spec.steps
        : [{ prompt: "Reply with the exact marker {marker}.", barrier: "reply" as const, containsAny: ["{marker}"] }];

    for (const [index, step] of steps.entries()) {
      const marker = `HUNT-${randomUUID().slice(0, 10)}`;
      const prompt = formatTemplate(step.prompt, {
        marker,
        roomId: chat.id,
        repo: REPO_ROOT,
        path: absoluteExamplePath,
        workdir: workdir ?? "",
      });
      const before = new Date().toISOString();
      await userRest.createChatMessage(chat.id, {
        content: prompt,
        mentions: [{ id: agent.id, handle: agent.name }],
      });
      const expected = step.containsAny.length > 0
        ? step.containsAny.map((value) =>
            formatTemplate(value, {
              marker,
              roomId: chat.id,
              repo: REPO_ROOT,
              path: absoluteExamplePath,
              workdir: workdir ?? "",
            }),
          )
        : [marker];
      await waitForReply(userRest, chat.id, agent.id, before, expected);
      recordResult(results, {
        scenario: "independent",
        example: spec.id,
        status: "pass",
        detail: `step ${index + 1}`,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordResult(results, { scenario: "independent", example: spec.id, status: "fail", detail });
  } finally {
    if (child) {
      await terminateProcess(child);
    }
    if (workdir) {
      await rm(workdir, { recursive: true, force: true });
    }
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, "example-runner");
  }
}

async function runPlan(planPath: string, dryRun: boolean): Promise<Result[]> {
  const plan = await loadPlan(planPath);
  if (dryRun) {
    console.log(`valid plan: ${plan.examples.length} examples; topology=independent`);
    return [];
  }
  const runId = randomUUID().slice(0, 8);
  const { userClient } = loadLiveEnv();
  try {
    await sweepOrphans(userClient, runId);
  } catch (error) {
    console.warn(`example-runner orphan sweep skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const results: Result[] = [];
  for (const spec of plan.examples) {
    await exerciseExample(spec, results, runId);
  }
  return results;
}

function reportScorecard(results: Result[]): void {
  const passed = results.filter((item) => item.status === "pass").length;
  const failed = results.filter((item) => item.status === "fail").length;
  console.log(`SUMMARY passed=${passed} failed=${failed}`);
}

async function main(): Promise<void> {
  const planArg = process.argv[2];
  if (!planArg) {
    console.error("Usage: tsx scripts/example-runner.ts <plan.yaml> [--dry-run]");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const results = await runPlan(path.resolve(planArg), dryRun);
  reportScorecard(results);
  if (results.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
}

void main();

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { namedWorkflowSteps } from "./workflow-test-utils.mjs";
import { renderDigest } from "../.github/scripts/post-core-coverage-digest.mjs";
import { buildApiCoverage } from "../.github/scripts/build-core-api-coverage.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github/workflows/typescript-core-coverage.yml");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function coreTagPrefix(workflow) {
  const match = workflow.match(/^ {6}CORE_TAG_PREFIX: (\S+)$/m);
  assert.ok(match, "workflow must declare env.CORE_TAG_PREFIX");
  return match[1];
}

async function loadSteps() {
  const workflow = await readFile(workflowPath, "utf8");
  return { workflow, steps: namedWorkflowSteps(workflow), CORE_TAG_PREFIX: coreTagPrefix(workflow) };
}

function findStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow step "${name}" must exist`);
  return step;
}

// The pin step's body is `run: |` at 8-space indent followed by 10-space
// indented script lines; this mirrors that exact indentation rather than
// a generic YAML block-scalar parse, since it only needs to run this one
// step's script the same way GitHub Actions does.
function extractRunScript(stepBody) {
  const lines = stepBody.split("\n");
  const runIndex = lines.findIndex((line) => line === "        run: |");
  assert.ok(runIndex >= 0, "step has no `run: |` block");
  const scriptLines = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line === "" || line.startsWith("          ")) {
      scriptLines.push(line === "" ? "" : line.slice(10));
    } else {
      break;
    }
  }
  return scriptLines.join("\n");
}

function extractPreReleaseGuardScript(pinScript) {
  const match = pinScript.match(/VERSION="\$version" node -e '\n([\s\S]*?)\n'/);
  assert.ok(match, "could not extract the pre-release guard's embedded node -e script");
  return match[1];
}

test("pin step's pre-release guard accepts a stable version", async () => {
  const { steps, CORE_TAG_PREFIX } = await loadSteps();
  const script = extractPreReleaseGuardScript(extractRunScript(findStep(steps, "Resolve pinned band-sdk-core version").body));
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, VERSION: "2.4.0", CORE_TAG_PREFIX },
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const version of ["2.4.0-dev.3", "2.4.0-rc.1"]) {
  test(`pin step's pre-release guard rejects ${version}`, async () => {
    const { steps, CORE_TAG_PREFIX } = await loadSteps();
    const script = extractPreReleaseGuardScript(extractRunScript(findStep(steps, "Resolve pinned band-sdk-core version").body));
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, VERSION: version, CORE_TAG_PREFIX },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is a pre-release/);
    assert.match(result.stderr, new RegExp(escapeRegExp(`${CORE_TAG_PREFIX}${version}`)));
  });
}

test("pin step is named 'pin' and the checkout ref consumes its declared output", async () => {
  const { steps } = await loadSteps();
  const pin = findStep(steps, "Resolve pinned band-sdk-core version");
  assert.match(pin.body, /^        id: pin$/m);
  assert.match(pin.body, /env\.CORE_TAG_PREFIX/);

  const checkout = findStep(steps, "Checkout band-sdk-core at the pinned version");
  assert.match(
    checkout.body,
    /ref: \$\{\{ env\.CORE_TAG_PREFIX \}\}\$\{\{ steps\.pin\.outputs\.version \}\}/,
  );
});

test("SDK checkout fetches history required by its contract tests", async () => {
  const { steps } = await loadSteps();
  const checkout = findStep(steps, "Checkout band-sdk-typescript");

  assert.match(checkout.body, /^          fetch-depth: 0$/m);
});

test("Core checkout uses the scoped read secret", async () => {
  const { steps } = await loadSteps();
  const checkout = findStep(steps, "Checkout band-sdk-core at the pinned version");

  assert.match(checkout.body, /token: \$\{\{ secrets\.CORE_SDK_READ_KEY \}\}/);
  assert.equal(
    steps.some((step) => step.name === "Generate GitHub App Token (scoped to band-sdk-core)"),
    false,
  );
});

test("weekly report schedules a separate mention digest", async () => {
  const { workflow } = await loadSteps();
  assert.match(workflow, /^    - cron: "47 20 \* \* 0" # Sunday night:/m);
  assert.match(workflow, /report-weekly:\n    name: report weekly coverage\n    needs: coverage\n    if: "!cancelled\(\) && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)"/);
  assert.match(workflow, /permissions:\n      contents: write/);
  assert.match(workflow, /run: bash \.github\/scripts\/read-integrations-mentions\.sh/);
  assert.match(workflow, /run: node \.github\/scripts\/post-core-coverage-digest\.mjs/);
  assert.match(workflow, /RECIPIENTS: \$\{\{ github\.event_name == 'schedule' && steps\.mentions\.outputs\.mentions \|\| format\('@\{0\}', github\.triggering_actor\) \}\}/);
});

test("weekly digest distinguishes API exercise from glue coverage and missing measurements", () => {
  const lcov = "SF:band_sdk_core.js\nLF:24\nLH:12\nFNF:5\nFNH:3\nend_of_record";
  const options = { lcov, label: "Core", recipients: "@tester", runUrl: "https://example.test/run", result: "failure" };
  const digest = renderDigest({ ...options, apiCoverage: { version: "2.5.0", apis: [
    { group: "First", name: "get value", status: "exercised" },
    { group: "Second", name: "get value", status: "unexercised" },
    { group: "Second", name: "newApi", status: "unmapped" },
  ] } });
  assert.match(digest, /Public APIs \| 🔴 \*\*33\.33%\*\* · 1\/3 exercised · 1 missing/);
  assert.match(digest, /1 public APIs could not be mapped/);
  assert.match(digest, /Second \| 🔴 \*\*0\.00%\*\* · 0\/2 exercised · 1 missing/);
  assert.match(digest, /\*\*Second:\*\* `get value`/);
  assert.match(digest, /First \| `get value`/);
  assert.match(digest, /Glue lines \| 🟠 \*\*50\.00%\*\* · 12\/24 covered/);
  assert.match(digest, /Rust\/WASM implementation coverage is outside this report/);
  assert.match(renderDigest(options), /Public API coverage unavailable/);
  assert.match(renderDigest({ ...options, lcov: undefined }), /Coverage unavailable/);
});

test("real V8 coverage maps duplicate members, constructors and static methods without generated helpers", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "core-api-")));
  const javascript = [
    "class First {",
    "  constructor() {}",
    "  get value() { return 1; }",
    "  static default() { return new First(); }",
    "  free() {}",
    "}",
    "class Second {",
    "  constructor() {}",
    "  get value() { return 2; }",
    "}",
    "function standalone() { return 3; }",
    "new Second();",
    "First.default().value;",
  ].join("\n");
  const declarations = [
    "export class First { constructor(); readonly value: number; static default(): First; }",
    "export class Second { constructor(); readonly value: number; }",
    "export function standalone(): number;",
  ].join("\n");
  const sourcePath = join(directory, "fixture.cjs");
  try {
    await writeFile(sourcePath, javascript);
    const run = spawnSync("pnpm", ["exec", "c8", "--temp-directory", join(directory, "v8"), "--allow-external", "--exclude-node-modules=false", "--include", sourcePath, "--reports-dir", directory, "-r", "json", "node", sourcePath], {
      cwd: join(root, "packages/sdk"), encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const coverage = Object.values(JSON.parse(await readFile(join(directory, "coverage-final.json"), "utf8")))[0];
    const report = buildApiCoverage({ declarations, javascript, coverage, version: "fixture" });
    assert.deepEqual(report.apis.map(({ group, name, status }) => [group, name, status]), [
      ["First", "constructor", "exercised"],
      ["First", "get value", "exercised"],
      ["First", "static default", "exercised"],
      ["Second", "constructor", "exercised"],
      ["Second", "get value", "unexercised"],
      ["Functions", "standalone", "unexercised"],
    ]);
    const unmapped = buildApiCoverage({ declarations: declarations + "\nexport function missing(): void;", javascript, coverage, version: "fixture" });
    assert.equal(unmapped.apis.at(-1).status, "unmapped");
    assert.throws(() => buildApiCoverage({ declarations: "export const unknownApi: number;", javascript, coverage }), /Unsupported public declaration/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withStubbedPnpmLs(lsJson, CORE_TAG_PREFIX, callback) {
  const directory = await mkdtemp(join(tmpdir(), "pin-step-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh\nif [ "$1" = "--filter" ] && [ "$2" = "@band-ai/sdk" ] && [ "$3" = "ls" ] && [ "$4" = "@band-ai/band-sdk-core" ] && [ "$5" = "--json" ] && [ "$6" = "--depth" ] && [ "$7" = "0" ]; then\n  echo '${lsJson}'\n  exit 0\nfi\necho "unexpected pnpm ls arguments: $*" >&2\nexit 1\n`,
  );
  await chmod(join(bin, "pnpm"), 0o755);
  const githubOutput = join(directory, "github-output");
  await writeFile(githubOutput, "");
  try {
    await callback({ directory, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_OUTPUT: githubOutput, CORE_TAG_PREFIX } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withFailingPnpmLs(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pin-step-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pnpm"), `#!/bin/sh\necho "simulated pnpm ls failure" >&2\nexit 1\n`);
  await chmod(join(bin, "pnpm"), 0o755);
  const githubOutput = join(directory, "github-output");
  await writeFile(githubOutput, "");
  try {
    await callback({ directory, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_OUTPUT: githubOutput } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("pin step reports a clear diagnostic when pnpm ls itself fails, instead of aborting silently", async () => {
  const { steps } = await loadSteps();
  const script = extractRunScript(findStep(steps, "Resolve pinned band-sdk-core version").body);

  await withFailingPnpmLs(async ({ directory, env }) => {
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: directory, encoding: "utf8", env });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::pnpm ls for @band-ai\/band-sdk-core failed/);
    assert.equal(await readFile(join(directory, "github-output"), "utf8"), "");
  });
});

for (const [scenario, lsJson] of [
  ["the dependency is missing", "[{}]"],
  ["the dependency has no version field", JSON.stringify([{ dependencies: { "@band-ai/band-sdk-core": {} } }])],
]) {
  test(`pin step reports a clear diagnostic naming the raw pnpm ls output when ${scenario}, instead of a raw stack trace`, async () => {
    const { steps, CORE_TAG_PREFIX } = await loadSteps();
    const script = extractRunScript(findStep(steps, "Resolve pinned band-sdk-core version").body);

    await withStubbedPnpmLs(lsJson, CORE_TAG_PREFIX, async ({ directory, env }) => {
      const result = spawnSync("bash", ["-e", "-c", script], { cwd: directory, encoding: "utf8", env });

      assert.notEqual(result.status, 0);
      // GitHub Actions recognizes `::error::` as a workflow command from stdout.
      assert.match(result.stdout, /::error::failed to resolve @band-ai\/band-sdk-core version/);
      assert.match(result.stdout, new RegExp(escapeRegExp(lsJson)), "the raw pnpm ls output must be printed for diagnosis");
      assert.doesNotMatch(result.stderr, /at \[eval\]|runScriptInThisContext/, "must not leak a raw Node stack trace");
      assert.equal(await readFile(join(directory, "github-output"), "utf8"), "");
    });
  });
}

test("pin step resolves a well-formed version and writes it to GITHUB_OUTPUT", async () => {
  const { steps, CORE_TAG_PREFIX } = await loadSteps();
  const script = extractRunScript(findStep(steps, "Resolve pinned band-sdk-core version").body);
  const lsJson = JSON.stringify([{ dependencies: { "@band-ai/band-sdk-core": { version: "2.4.0" } } }]);

  await withStubbedPnpmLs(lsJson, CORE_TAG_PREFIX, async ({ directory, env }) => {
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: directory, encoding: "utf8", env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(directory, "github-output"), "utf8"), "version=2.4.0\n");
  });
});

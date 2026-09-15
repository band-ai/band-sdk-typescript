import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { namedWorkflowSteps } from "./workflow-test-utils.mjs";
import { parseLcov, renderDigest } from "../.github/scripts/post-core-coverage-digest.mjs";

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
  assert.match(workflow, /^    - cron: "47 4 \* \* 1" # Mondays 04:47 UTC$/m);
  assert.match(workflow, /report-weekly:\n    name: report weekly coverage\n    needs: coverage\n    if: "!cancelled\(\) && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)"/);
  assert.match(workflow, /permissions:\n      contents: write/);
  assert.match(workflow, /run: bash \.github\/scripts\/read-integrations-mentions\.sh/);
  assert.match(workflow, /run: node \.github\/scripts\/post-core-coverage-digest\.mjs/);
  assert.match(workflow, /RECIPIENTS: \$\{\{ github\.event_name == 'schedule' && steps\.mentions\.outputs\.mentions \|\| format\('@\{0\}', github\.triggering_actor\) \}\}/);
});

test("weekly digest identifies low and completely uncovered files", () => {
  const lcov = ["SF:/work/crates/core/src/covered.rs", "FNF:2", "FNH:2", "FN:1,covered", "FNDA:1,covered", "DA:1,1", "DA:2,1", "LF:10", "LH:10", "end_of_record", "SF:/work/crates/core/src/low.rs", "FNF:2", "FNH:1", "FN:10,used", "FNDA:1,used", "FN:12,uncovered", "FNDA:0,uncovered", "DA:10,1", "DA:11,1", "DA:12,0", "DA:13,0", "LF:10", "LH:2", "end_of_record", "SF:/work/crates/core/src/none.rs", "FNF:1", "FNH:0", "FN:20,missing", "FNDA:0,missing", "DA:20,0", "DA:21,0", "DA:22,0", "DA:23,0", "LF:4", "LH:0", "end_of_record"].join("\n");
  assert.deepEqual(parseLcov(lcov).map((record) => record.path), ["crates/core/src/covered.rs", "crates/core/src/low.rs", "crates/core/src/none.rs"]);
  const digest = renderDigest({ lcov, label: "Core", recipients: "@bandzalkin", runUrl: "https://example.test/run", result: "success" });
  assert.match(digest, /Weekly Core coverage report/);
  assert.match(digest, /\| Lines \| 12\/24 \| 12 \| 50\.00% \|/);
  assert.match(digest, /\| Functions \| 3\/5 \| 2 \| 60\.00% \|/);
  assert.match(digest, /`crates\/core\/src\/none\.rs` \| 0\/4 \(0\.00%\) \| 20-23/);
  assert.match(digest, /`crates\/core\/src\/low\.rs` \| 2\/10 \(20\.00%\) \| 12-13/);
  assert.match(digest, /\| 12 \| `uncovered` \|/);
  assert.doesNotMatch(digest, /covered\.rs/);
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

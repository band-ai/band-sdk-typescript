import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { namedWorkflowSteps } from "./workflow-test-utils.mjs";

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

async function withStubbedPnpmLs(lsJson, CORE_TAG_PREFIX, callback) {
  const directory = await mkdtemp(join(tmpdir(), "pin-step-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh\nif [ "$1" = "--filter" ]; then\n  echo '${lsJson}'\n  exit 0\nfi\nexit 1\n`,
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

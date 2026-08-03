import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coordinationScript = join(root, "scripts/assert-coordinated-release.mjs");
const readyScript = join(root, "scripts/assert-release-ready.mjs");

const targets = {
  "@band-ai/sdk": "0.1.8",
  "@band-ai/openclaw-channel-band": "0.1.11",
};

function run(script, cwd, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function withReleaseRoot(callback) {
  const directory = await mkdtemp(join(tmpdir(), "release-hardening-"));
  await writeFile(
    join(directory, ".release-coordination.json"),
    `${JSON.stringify({ packages: targets }, null, 2)}\n`,
  );
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("coordination manifest pins both preflight package targets", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, ".release-coordination.json"), "utf8"),
  );
  assert.deepEqual(manifest, { packages: targets });
});

test("coordinated release accepts no release outputs", async () => {
  await withReleaseRoot(async (directory) => {
    const result = run(coordinationScript, directory, {
      SDK_RELEASE_CREATED: "false",
      SDK_RELEASE_VERSION: "",
      OPENCLAW_RELEASE_CREATED: "false",
      OPENCLAW_RELEASE_VERSION: "",
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("coordinated release accepts the exact two-package output", async () => {
  await withReleaseRoot(async (directory) => {
    const result = run(coordinationScript, directory, {
      SDK_RELEASE_CREATED: "true",
      SDK_RELEASE_VERSION: "0.1.8",
      OPENCLAW_RELEASE_CREATED: "true",
      OPENCLAW_RELEASE_VERSION: "0.1.11",
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

for (const scenario of [
  {
    name: "only the SDK is released",
    env: {
      SDK_RELEASE_CREATED: "true",
      SDK_RELEASE_VERSION: "0.1.8",
      OPENCLAW_RELEASE_CREATED: "false",
      OPENCLAW_RELEASE_VERSION: "",
    },
  },
  {
    name: "only OpenClaw is released",
    env: {
      SDK_RELEASE_CREATED: "false",
      SDK_RELEASE_VERSION: "",
      OPENCLAW_RELEASE_CREATED: "true",
      OPENCLAW_RELEASE_VERSION: "0.1.11",
    },
  },
  {
    name: "the SDK version misses its target",
    env: {
      SDK_RELEASE_CREATED: "true",
      SDK_RELEASE_VERSION: "0.1.9",
      OPENCLAW_RELEASE_CREATED: "true",
      OPENCLAW_RELEASE_VERSION: "0.1.11",
    },
  },
  {
    name: "the OpenClaw version misses its target",
    env: {
      SDK_RELEASE_CREATED: "true",
      SDK_RELEASE_VERSION: "0.1.8",
      OPENCLAW_RELEASE_CREATED: "true",
      OPENCLAW_RELEASE_VERSION: "0.1.12",
    },
  },
  {
    name: "a release-created output is malformed",
    env: {
      SDK_RELEASE_CREATED: "yes",
      SDK_RELEASE_VERSION: "0.1.8",
      OPENCLAW_RELEASE_CREATED: "true",
      OPENCLAW_RELEASE_VERSION: "0.1.11",
    },
  },
]) {
  test(`coordinated release rejects when ${scenario.name}`, async () => {
    await withReleaseRoot(async (directory) => {
      const result = run(coordinationScript, directory, scenario.env);
      assert.notEqual(result.status, 0);
    });
  });
}

for (const [name, manifest] of [
  ["a missing package target", { packages: { "@band-ai/sdk": "0.1.8" } }],
  [
    "an unexpected package target",
    { packages: { ...targets, "@band-ai/unexpected": "1.0.0" } },
  ],
  ["an empty target version", { packages: { ...targets, "@band-ai/sdk": "" } }],
  [
    "a non-semantic target version",
    { packages: { ...targets, "@band-ai/sdk": "next" } },
  ],
]) {
  test(`coordinated release rejects ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-hardening-manifest-"));
    try {
      await writeFile(
        join(directory, ".release-coordination.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const result = run(coordinationScript, directory, {
        SDK_RELEASE_CREATED: "false",
        OPENCLAW_RELEASE_CREATED: "false",
      });
      assert.notEqual(result.status, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("release-ready guard passes without a hold and fails with one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-ready-"));
  try {
    assert.equal(run(readyScript, directory).status, 0);
    await writeFile(join(directory, ".release-hold"), "rename in progress\n");
    assert.notEqual(run(readyScript, directory).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function namedWorkflowSteps(workflow) {
  const starts = [...workflow.matchAll(/^      - name: (.+)$/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    body: workflow.slice(match.index, starts[index + 1]?.index ?? workflow.length),
    index: match.index,
  }));
}

test("release workflow enters PR-only mode before release-please when held", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const releaseMode = steps.find((step) => step.name === "Determine release mode");
  const releasePlease = steps.find((step) => step.name === "Release Please");

  assert.ok(releaseMode);
  assert.ok(releasePlease);
  assert.ok(releaseMode.index < releasePlease.index);
  assert.match(releaseMode.body, /id: release_mode/);
  assert.match(releaseMode.body, /\[ -f \.release-hold \]/);
  assert.match(releaseMode.body, /skip_github_release=true/);
  assert.match(releaseMode.body, /skip_github_release=false/);
  assert.match(releaseMode.body, /GITHUB_OUTPUT/);
  assert.match(
    releasePlease.body,
    /skip-github-release: \$\{\{ steps\.release_mode\.outputs\.skip_github_release \}\}/,
  );
});

test("release workflow enforces coordination before package work and readiness before each publish", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const releasePlease = step("Release Please");
  const coordination = step("Verify coordinated release outputs");
  const installPnpm = step("Install pnpm");
  const sdkPublish = step("Publish SDK to npm (@band-ai)");
  const openclawPublish = step("Publish OpenClaw to npm (@band-ai)");

  assert.ok(releasePlease);
  assert.ok(coordination);
  assert.ok(installPnpm);
  assert.ok(sdkPublish);
  assert.ok(openclawPublish);
  assert.ok(releasePlease.index < coordination.index);
  assert.ok(coordination.index < installPnpm.index);
  assert.ok(installPnpm.index < sdkPublish.index);
  assert.ok(sdkPublish.index < openclawPublish.index);
  assert.match(coordination.body, /node scripts\/assert-coordinated-release\.mjs/);
  assert.doesNotMatch(coordination.body, /^        if:/m);
  assert.match(sdkPublish.body, /node scripts\/assert-release-ready\.mjs/);
  assert.match(openclawPublish.body, /node scripts\/assert-release-ready\.mjs/);
});

test("release workflow pins every action to a full commit SHA", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const refs = [...workflow.matchAll(/^\s*uses: (\S+?)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );

  assert.ok(refs.length > 0, "release workflow must use at least one action");
  for (const ref of refs) {
    // Local (`./.github/...`) references are already immutable with the commit.
    if (ref.startsWith("./")) continue;
    const [action, rev] = ref.split("@");
    assert.match(
      rev ?? "",
      /^[0-9a-f]{40}$/,
      `${action} must be pinned to a 40-character commit SHA, not "${rev}"`,
    );
  }
});

test("CI validates pull requests to main and the legacy dev compatibility lane", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /pull_request:\n {4}branches: \[main, dev\]\n/);
});

test("CI grants its token only the read permissions required by checkout and paths-filter", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.match(
    workflow,
    /permissions:\n {2}contents: read\n {2}pull-requests: read\n/,
  );
  assert.doesNotMatch(workflow, /^ {2}[a-z-]+: write$/m);
});

test("releases and new dependency updates target main, not the dev compatibility lane", async () => {
  const releaseWorkflow = await readFile(
    join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const dependabot = await readFile(join(root, ".github/dependabot.yml"), "utf8");

  assert.match(releaseWorkflow, /push:\n {4}branches: \[main\]\n/);
  assert.doesNotMatch(releaseWorkflow, /branches: \[[^\]]*\bdev\b/);

  const targets = [...dependabot.matchAll(/target-branch: ["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(targets.length > 0, "Dependabot must declare its target branches");
  assert.deepEqual(new Set(targets), new Set(["main"]));
  assert.match(dependabot, /reviewers:\n {6}- ["']band-ai\/integrations["']/);
  assert.doesNotMatch(dependabot, /thenvoi\/integrations-team/);
});

test("CI exposes one always-reporting aggregate status covering every job", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  const start = workflow.indexOf("\n  ci-status:");
  assert.notEqual(start, -1, "ci-status job must exist for branch protection");
  const block = workflow.slice(start);

  // Must always report: jobs skipped by the paths filter never produce a check
  // context, so a conditional aggregate would hang a docs-only PR forever.
  assert.match(block, /^    if: always\(\)$/m);
  // A skipped dependency is a pass; anything else (failure, cancelled) is not.
  assert.match(block, /success\|skipped\)/);
  assert.match(block, /exit 1/);

  const jobsSection = workflow.slice(workflow.indexOf("\njobs:"));
  const jobNames = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(
    (match) => match[1],
  );
  assert.ok(jobNames.includes("ci-status"));

  const needs = block
    .match(/^    needs: \[([^\]]+)\]$/m)?.[1]
    .split(",")
    .map((name) => name.trim());
  assert.ok(needs, "ci-status must declare its dependencies as a list");
  assert.deepEqual(
    [...needs].sort(),
    jobNames.filter((name) => name !== "ci-status").sort(),
    "ci-status must depend on every other CI job, or a failure could slip through",
  );
});

test("CI uses exact nonempty package filters and selects both packages for control paths", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.doesNotMatch(workflow, /@thenvoi\/openclaw-channel-thenvoi/);
  const filteredCommands = [
    ...workflow.matchAll(/run: (pnpm [^\n]*--filter [^\n]+)/g),
  ];
  assert.equal(filteredCommands.length, 10);
  for (const command of filteredCommands) {
    assert.match(command[1], /^pnpm --fail-if-no-match --filter /);
  }
  assert.match(workflow, /pnpm --fail-if-no-match --filter @thenvoi\/sdk/);
  assert.match(
    workflow,
    /pnpm --fail-if-no-match --filter @band-ai\/openclaw-channel-band/,
  );

  for (const requiredPath of [
    ".github/**",
    "scripts/**",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "release-please-config.json",
    ".release-please-manifest.json",
    ".release-coordination.json",
    ".release-hold",
  ]) {
    const escaped = requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = workflow.match(new RegExp(`['\"]${escaped}['\"]`, "g")) ?? [];
    assert.equal(occurrences.length, 2, `${requiredPath} must select both packages`);
  }
});

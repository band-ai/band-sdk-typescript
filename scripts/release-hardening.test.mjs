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

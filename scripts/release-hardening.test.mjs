import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseOutputsScript = join(root, "scripts/assert-release-outputs.mjs");
const readyScript = join(root, "scripts/assert-release-ready.mjs");
const intentScript = join(root, "scripts/assert-release-intent.mjs");
const publishScript = join(root, "scripts/publish-if-needed.mjs");

function run(script, cwd, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runCommand(command, args, cwd, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function writeReleaseState(directory, { sdk, openclaw, hold = false }) {
  await mkdir(join(directory, "packages/sdk"), { recursive: true });
  await mkdir(join(directory, "packages/openclaw"), { recursive: true });
  await writeFile(
    join(directory, ".release-please-manifest.json"),
    `${JSON.stringify({ "packages/sdk": sdk, "packages/openclaw": openclaw }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "packages/sdk/package.json"),
    `${JSON.stringify({ name: "@thenvoi/sdk", version: sdk }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "packages/openclaw/package.json"),
    `${JSON.stringify({ name: "@band-ai/openclaw-channel-band", version: openclaw }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "packages/openclaw/openclaw.plugin.json"),
    `${JSON.stringify({ version: openclaw }, null, 2)}\n`,
  );
  if (hold) await writeFile(join(directory, ".release-hold"), "release held\n");
}

async function withReleaseHistory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "release-intent-"));
  try {
    assert.equal(runCommand("git", ["init", "-q"], directory).status, 0);
    assert.equal(
      runCommand("git", ["config", "user.email", "test@example.com"], directory)
        .status,
      0,
    );
    assert.equal(
      runCommand("git", ["config", "user.name", "Release Test"], directory).status,
      0,
    );
    await writeReleaseState(directory, { sdk: "0.1.7", openclaw: "0.1.10" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "initial"], directory).status, 0);
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withReleaseRoot(callback) {
  const directory = await mkdtemp(join(tmpdir(), "release-hardening-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const scenario of [
  ["no releases", "false", "", "false", ""],
  ["SDK only", "true", "0.1.8", "false", ""],
  ["OpenClaw only", "false", "", "true", "0.1.11"],
  ["both packages independently", "true", "0.1.8", "true", "7.4.2"],
]) {
  test(`release outputs accept ${scenario[0]}`, async () => {
    await withReleaseRoot(async (directory) => {
      const result = run(releaseOutputsScript, directory, {
        SDK_RELEASE_CREATED: scenario[1], SDK_RELEASE_VERSION: scenario[2],
        OPENCLAW_RELEASE_CREATED: scenario[3], OPENCLAW_RELEASE_VERSION: scenario[4],
      });
      assert.equal(result.status, 0, result.stderr);
    });
  });
}

for (const scenario of [
  ["malformed SDK created flag", "yes", "0.1.8", "false", ""],
  ["SDK missing version", "true", "", "false", ""],
  ["OpenClaw unstable version", "false", "", "true", "1.0.0-rc.1"],
  ["version without a created release", "false", "0.1.8", "false", ""],
]) {
  test(`release outputs reject ${scenario[0]}`, async () => {
    await withReleaseRoot(async (directory) => {
      const result = run(releaseOutputsScript, directory, {
        SDK_RELEASE_CREATED: scenario[1], SDK_RELEASE_VERSION: scenario[2],
        OPENCLAW_RELEASE_CREATED: scenario[3], OPENCLAW_RELEASE_VERSION: scenario[4],
      });
      assert.notEqual(result.status, 0);
    });
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

test("release-ready guard rejects a hold added after the selected release commit", async () => {
  await withReleaseHistory(async (directory) => {
    const releaseCommit = runCommand("git", ["rev-parse", "HEAD"], directory).stdout.trim();
    await writeFile(join(directory, ".release-hold"), "emergency hold\n");
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "hold current main"], directory).status, 0);
    assert.equal(runCommand("git", ["branch", "current-main"], directory).status, 0);
    assert.equal(runCommand("git", ["checkout", "--detach", releaseCommit], directory).status, 0);

    const result = run(readyScript, directory, { RELEASE_HOLD_REF: "current-main" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release hold/i);
  });
});

test("release-ready guard fails closed when the authoritative hold ref is unavailable", async () => {
  await withReleaseHistory(async (directory) => {
    const result = run(readyScript, directory, {
      RELEASE_HOLD_REF: "refs/remotes/origin/missing",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot resolve authoritative release-hold ref/i);
  });
});

test("release intent accepts an ordinary commit with unchanged package versions", async () => {
  await withReleaseHistory(async (directory) => {
    await writeFile(join(directory, "README.md"), "ordinary change\n");
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "docs"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent rejects a version transition while release hold exists", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, {
      sdk: "0.1.8",
      openclaw: "0.1.11",
      hold: true,
    });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release hold/i);
  });
});

test("release intent accepts an atomic SDK-only version transition", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.10" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "partial release"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent accepts an atomic OpenClaw-only version transition", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.7", openclaw: "0.1.11" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "openclaw release"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent rejects an SDK manifest/package mismatch", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.10" });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest["packages/sdk"] = "0.1.9";
    await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "mismatch"], directory).status, 0);
    assert.notEqual(run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" }).status, 0);
  });
});

test("release intent rejects an OpenClaw manifest/package/plugin mismatch", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.7", openclaw: "0.1.11" });
    await writeFile(join(directory, "packages/openclaw/openclaw.plugin.json"), '{"version":"0.1.12"}\n');
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "mismatch"], directory).status, 0);
    assert.notEqual(run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" }).status, 0);
  });
});

test("release intent fails closed when no baseline is supplied for an ordinary release check", async () => {
  await withReleaseHistory(async (directory) => {
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RELEASE_BASE_COMMIT is required/i);
  });
});

test("release intent rejects the zero-commit baseline sentinel", async () => {
  await withReleaseHistory(async (directory) => {
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "0".repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unusable/i);
    assert.match(result.stderr, /recover-package/i);
  });
});

test("recovery does not require a baseline, guarding against hoisting the baseline check above it", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.10" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "sdk-v0.1.8"], directory).status, 0);
    const result = run(intentScript, directory, {
      RECOVERY_PACKAGE: "sdk",
      REQUIRE_RELEASE_TAG: "true",
      RELEASE_BASE_COMMIT: "",
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

for (const [selector, tag] of [["sdk", "sdk-v0.1.8"], ["openclaw", "openclaw-channel-band-v0.1.11"]]) {
test(`release intent accepts ${selector} recovery only from its exact tag`, async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.11" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", tag], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: selector, REQUIRE_RELEASE_TAG: "true" });
    assert.equal(result.status, 0, result.stderr);
  });
});
}

test("SDK recovery rejects an SDK manifest/package mismatch", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.10" });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest["packages/sdk"] = "0.1.9";
    await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "mismatch"], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: "sdk" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sdk current manifest and package versions must match exactly/i);
  });
});

for (const selector of ["sdk", "openclaw"]) {
  test(`${selector} recovery rejects an active release hold`, async () => {
    await withReleaseHistory(async (directory) => {
      await writeFile(join(directory, ".release-hold"), "emergency hold\n");
      const result = run(intentScript, directory, { RECOVERY_PACKAGE: selector });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release hold/i);
    });
  });
}

test("SDK recovery ignores an inconsistent unselected OpenClaw tuple", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.11" });
    await writeFile(join(directory, "packages/openclaw/openclaw.plugin.json"), '{"version":"9.9.9"}\n');
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "sdk-v0.1.8"], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: "sdk", REQUIRE_RELEASE_TAG: "true" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("OpenClaw recovery ignores an inconsistent unselected SDK tuple", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.11" });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest["packages/sdk"] = "9.9.9";
    await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "openclaw-channel-band-v0.1.11"], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: "openclaw", REQUIRE_RELEASE_TAG: "true" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent rejects recovery when the selected package tag identifies other bytes", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.10" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "sdk-v0.1.8"], directory).status, 0);
    await writeFile(join(directory, "README.md"), "later bytes\n");
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "later"], directory).status, 0);
    const result = run(intentScript, directory, {
      RECOVERY_PACKAGE: "sdk",
      REQUIRE_RELEASE_TAG: "true",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release tag/i);
  });
});

test("release intent rejects OpenClaw recovery when its tag identifies other bytes", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { sdk: "0.1.7", openclaw: "0.1.11" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "openclaw-channel-band-v0.1.11"], directory).status, 0);
    await writeFile(join(directory, "README.md"), "later bytes\n");
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "later"], directory).status, 0);
    const result = run(intentScript, directory, {
      RECOVERY_PACKAGE: "openclaw",
      REQUIRE_RELEASE_TAG: "true",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release tag/i);
  });
});

test("release intent uses the PR base across a multi-commit release topology", async () => {
  await withReleaseHistory(async (directory) => {
    const baseline = runCommand("git", ["rev-parse", "HEAD"], directory).stdout.trim();
    await writeReleaseState(directory, { sdk: "0.1.8", openclaw: "0.1.11" });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release versions"], directory).status, 0);
    await writeFile(join(directory, ".release-hold"), "release held\n");
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "hold release"], directory).status, 0);

    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: baseline });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release hold/i);
  });
});

async function withFakeNpm(viewMode, callback, { createTarball = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "release-publish-"));
  const bin = join(directory, "bin");
  const log = join(directory, "npm.log");
  await mkdir(bin);
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "@band-ai/example", version: "1.2.3" })}\n`,
  );
  await mkdir(join(directory, "release-artifacts"));
  if (createTarball) {
    await writeFile(
      join(directory, "release-artifacts/band-ai-example-1.2.3.tgz"),
      "fake tarball\n",
    );
  }
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >> "$FAKE_NPM_LOG"\nif [ "$1" = view ]; then\n  if [ "$FAKE_NPM_VIEW" = found ]; then echo '"1.2.3"'; exit 0; fi\n  if [ "$FAKE_NPM_VIEW" = missing ]; then echo 'E404 Not Found' >&2; exit 1; fi\n  echo 'network failure' >&2; exit 1\nfi\nexit 0\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  try {
    await callback(directory, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: log,
      FAKE_NPM_VIEW: viewMode,
      PUBLISH_PACKAGE_NAME: "@band-ai/example",
      PUBLISH_PACKAGE_VERSION: "1.2.3",
      // Relative, nested path: exactly what the publish job passes in CI.
      PUBLISH_TARBALL: "release-artifacts/band-ai-example-1.2.3.tgz",
    }, log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("idempotent publisher skips an exact version already on npm", async () => {
  await withFakeNpm("found", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(log, "utf8"), /^view /m);
    assert.doesNotMatch(await readFile(log, "utf8"), /^publish /m);
  });
});

test("idempotent publisher publishes only when npm confirms the version is absent", async () => {
  await withFakeNpm("missing", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.equal(result.status, 0, result.stderr);
    // The tarball must reach npm as an absolute path; a bare "dir/pkg.tgz" is
    // parsed as a GitHub shorthand and publish tries to git-clone it instead.
    assert.match(
      await readFile(log, "utf8"),
      /^publish \/\S*\/release-artifacts\/band-ai-example-1\.2\.3\.tgz --ignore-scripts --provenance --access public$/m,
    );
  });
});

test("idempotent publisher fails closed when the npm lookup is inconclusive", async () => {
  await withFakeNpm("error", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(await readFile(log, "utf8"), /^publish /m);
  });
});

test("idempotent publisher fails fast with a named path when the tarball is missing", async () => {
  await withFakeNpm("missing", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /band-ai-example-1\.2\.3\.tgz/);
    assert.match(result.stderr, /not found/i);
    const logged = await readFile(log, "utf8").catch(() => "");
    assert.doesNotMatch(logged, /^publish /m);
  }, { createTarball: false });
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
  const recoverySource = steps.find((step) => step.name === "Checkout recovery source");
  const releaseIntent = steps.find((step) => step.name === "Verify release intent");
  const releasePlease = steps.find((step) => step.name === "Release Please");

  assert.ok(releaseMode);
  assert.ok(recoverySource);
  assert.ok(releaseIntent);
  assert.ok(releasePlease);
  assert.ok(releaseMode.index < releasePlease.index);
  assert.ok(recoverySource.index < releaseIntent.index);
  assert.ok(releaseIntent.index < releasePlease.index);
  assert.match(releaseIntent.body, /node scripts\/assert-release-intent\.mjs/);
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

test("release workflow validates independent outputs before package work and readiness before each publish", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const releasePlease = step("Release Please");
  const releaseState = step("Resolve release state");
  const outputValidation = step("Verify independent release outputs");
  const installPnpm = step("Install pnpm");
  const sdkPack = step("Pack SDK (@band-ai)");
  const openclawPack = step("Pack OpenClaw (@band-ai)");
  const sdkPublish = step("Publish SDK to npm (@band-ai)");
  const openclawPublish = step("Publish OpenClaw to npm (@band-ai)");

  assert.ok(releasePlease);
  assert.ok(releaseState);
  assert.ok(outputValidation);
  assert.ok(installPnpm);
  assert.ok(sdkPack);
  assert.ok(openclawPack);
  assert.ok(sdkPublish);
  assert.ok(openclawPublish);
  assert.ok(releasePlease.index < releaseState.index);
  assert.ok(releaseState.index < outputValidation.index);
  assert.ok(outputValidation.index < installPnpm.index);
  assert.ok(installPnpm.index < sdkPack.index);
  assert.ok(sdkPack.index < openclawPack.index);
  assert.ok(installPnpm.index < sdkPublish.index);
  assert.ok(sdkPublish.index < openclawPublish.index);
  assert.match(outputValidation.body, /node scripts\/assert-release-outputs\.mjs/);
  assert.match(outputValidation.body, /steps\.release_state\.outputs\.sdk_created/);
  assert.doesNotMatch(outputValidation.body, /^        if:/m);
  assert.match(sdkPack.body, /node scripts\/assert-release-ready\.mjs/);
  assert.match(openclawPack.body, /node scripts\/assert-release-ready\.mjs/);
  assert.match(sdkPublish.body, /node scripts\/assert-release-ready\.mjs/);
  assert.match(openclawPublish.body, /node scripts\/assert-release-ready\.mjs/);
  assert.match(sdkPublish.body, /node scripts\/publish-if-needed\.mjs/);
  assert.match(openclawPublish.body, /node scripts\/publish-if-needed\.mjs/);
  assert.match(sdkPublish.body, /git fetch origin main:refs\/remotes\/origin\/main/);
  assert.match(openclawPublish.body, /git fetch origin main:refs\/remotes\/origin\/main/);
  assert.match(sdkPublish.body, /RELEASE_HOLD_REF: refs\/remotes\/origin\/main/);
  assert.match(openclawPublish.body, /RELEASE_HOLD_REF: refs\/remotes\/origin\/main/);
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

test("release workflow restricts authority and pins the npm publish toolchain", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");

  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(workflow, /recover-package:/);
  assert.match(
    workflow,
    /description: Run automatic Release Please, or recover one package from its exact tagged release commit/,
  );
  assert.match(workflow, /options: \[automatic, sdk, openclaw\]/);
  assert.match(workflow, /default: automatic/);
  assert.match(
    workflow,
    /if: inputs\['recover-package'\] == 'automatic' \|\| inputs\['recover-package'\] == ''/,
  );
  assert.match(workflow, /automatic\|''\)/);
  assert.match(
    workflow,
    /if: inputs\['recover-package'\] == 'sdk' \|\| inputs\['recover-package'\] == 'openclaw'/,
  );
  assert.match(
    workflow,
    /REQUIRE_RELEASE_TAG: \$\{\{ inputs\['recover-package'\] == 'sdk' \|\| inputs\['recover-package'\] == 'openclaw' \}\}/,
  );
  assert.match(workflow, /recover-package must be automatic, sdk, or openclaw/);
  assert.match(workflow, /release-commit:/);
  assert.match(workflow, /release-commit must be an exact lowercase 40-character commit SHA/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git checkout --detach/);
  assert.match(workflow, /RECOVERY_PACKAGE:/);
  assert.match(workflow, /REQUIRE_RELEASE_TAG:/);
  assert.match(workflow, /RELEASE_BASE_COMMIT:/);
  assert.match(workflow, /permissions:\n {2}contents: read\n\nconcurrency:/);
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
  const releaseJob = workflow.slice(
    workflow.indexOf("\n  release:"),
    workflow.indexOf("\n  publish:"),
  );
  assert.match(publishJob, /permissions:\n {6}contents: read\n {6}id-token: write\n/);
  assert.doesNotMatch(releaseJob, /id-token: write/);
  assert.doesNotMatch(publishJob, /pnpm install|pnpm build|npm install/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(publishJob, /node-version: 24\.18\.1/);
  assert.match(publishJob, /bundles npm 11\.16\.0/);
  assert.doesNotMatch(workflow, /npm@latest/);
  assert.doesNotMatch(workflow, /^\s*npm publish /m);
  const publisher = await readFile(join(root, "scripts/publish-if-needed.mjs"), "utf8");
  assert.match(publisher, /"--ignore-scripts"/);
  assert.equal(
    (workflow.match(/node scripts\/publish-if-needed\.mjs/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf("- name: Resolve release state")),
    /if: steps\.release\.outputs/,
  );
});

test("release workflow resolves the intent baseline explicitly instead of relying on the script default", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const baseline = step("Resolve release baseline");
  const releaseIntent = step("Verify release intent");

  assert.ok(baseline, "release.yml must resolve the intent baseline in its own step");
  assert.ok(releaseIntent);
  assert.ok(baseline.index < releaseIntent.index);
  assert.match(baseline.body, /id: release_baseline/);
  assert.match(baseline.body, /github\.event_name/);
  assert.match(baseline.body, /github\.event\.before/);
  assert.match(baseline.body, /GITHUB_OUTPUT/);
  assert.match(
    releaseIntent.body,
    /RELEASE_BASE_COMMIT: \$\{\{ steps\.release_baseline\.outputs\.commit \}\}/,
  );
  assert.doesNotMatch(releaseIntent.body, /github\.event\.before/);
});

test("release workflow keeps the artifact download path in sync with the publish tarball prefixes", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const upload = step("Upload release bundle");
  const download = step("Download verified release bundle");
  const sdkPublish = step("Publish SDK to npm (@band-ai)");
  const openclawPublish = step("Publish OpenClaw to npm (@band-ai)");

  assert.ok(upload);
  assert.ok(download);
  assert.ok(sdkPublish);
  assert.ok(openclawPublish);

  const uploadName = upload.body.match(/^\s+name: (.+)$/m)?.[1];
  const downloadName = download.body.match(/^\s+name: (.+)$/m)?.[1];
  assert.ok(uploadName, "upload step must declare an artifact name");
  assert.ok(downloadName, "download step must declare an artifact name");
  // The upload step (job: release) can read `steps.source.outputs.commit`
  // directly; the download step (job: publish) cannot see another job's
  // steps and must instead go through that job's declared output. Confirm
  // they still name the same artifact by following that indirection rather
  // than requiring identical expression text.
  assert.equal(
    uploadName,
    "release-bundle-${{ steps.source.outputs.commit }}",
  );
  assert.equal(
    downloadName,
    "release-bundle-${{ needs.release.outputs.source_commit }}",
  );
  assert.match(
    workflow,
    /source_commit: \$\{\{ steps\.source\.outputs\.commit \}\}/,
    "needs.release.outputs.source_commit must be declared as steps.source.outputs.commit, so upload and download name the same artifact",
  );

  const sdkTarball = sdkPublish.body.match(/PUBLISH_TARBALL: (\S+)/)?.[1];
  const openclawTarball = openclawPublish.body.match(/PUBLISH_TARBALL: (\S+)/)?.[1];
  assert.ok(sdkTarball, "SDK publish step must declare PUBLISH_TARBALL");
  assert.ok(openclawTarball, "OpenClaw publish step must declare PUBLISH_TARBALL");

  const prefix = (tarball) => tarball.slice(0, tarball.lastIndexOf("/"));
  const sdkPrefix = prefix(sdkTarball);
  const openclawPrefix = prefix(openclawTarball);
  assert.equal(
    openclawPrefix,
    sdkPrefix,
    "both publish steps must expect their tarball under the same directory prefix",
  );

  const downloadPath = download.body.match(/^\s+path: (.+)$/m)?.[1];
  assert.equal(
    downloadPath,
    sdkPrefix,
    "download step must extract into the exact directory prefix the publish steps read from",
  );

  // 1-day retention is a deliberate choice (docs/ci-cd-workflows.md), but it
  // must stay a conscious one — nobody should silently extend how long
  // publishable bytes sit in artifact storage.
  assert.match(upload.body, /^\s+retention-days: 1$/m);
});

test("CI validates pull requests to main and the legacy dev compatibility lane", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /pull_request:\n {4}branches: \[main, dev\]\n/);
  assert.match(
    workflow,
    /RELEASE_BASE_COMMIT: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
});

test("CI grants its token only the read permissions required by checkout and paths-filter", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.match(
    workflow,
    /permissions:\n {2}contents: read\n {2}pull-requests: read\n/,
  );
  assert.doesNotMatch(workflow, /^\s+[a-z-]+: write$/m);
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

test("published packages point at the repository that signs their provenance", async () => {
  // npm validates repository.url against the provenance statement, so a stale
  // URL (e.g. the pre-rename thenvoi remote) fails publish with a 422.
  for (const pkg of ["packages/sdk", "packages/openclaw"]) {
    const manifest = JSON.parse(
      await readFile(join(root, pkg, "package.json"), "utf8"),
    );
    assert.equal(
      manifest.repository?.url,
      "git+https://github.com/band-ai/band-sdk-typescript.git",
      `${pkg} must declare the repository that builds and signs it`,
    );
    assert.equal(manifest.repository?.directory, pkg);
  }
});

test("CI exposes one always-reporting aggregate status covering every job", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  const start = workflow.indexOf("\n  ci-status:");
  assert.notEqual(start, -1, "ci-status job must exist for branch protection");
  const block = workflow.slice(start);

  // The aggregate must always report one stable context even when its
  // intentionally conditional lint/test dependencies are skipped.
  assert.match(block, /^    if: always\(\)$/m);
  assert.match(block, /changes:\$\{\{ needs\.changes\.result \}\}:success/);
  assert.match(block, /packaging:\$\{\{ needs\.packaging\.result \}\}:success/);
  assert.match(block, /lint:\$\{\{ needs\.lint\.result \}\}:success\|skipped/);
  assert.match(block, /test:\$\{\{ needs\.test\.result \}\}:success\|skipped/);
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
    ".release-hold",
  ]) {
    const escaped = requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = workflow.match(new RegExp(`['\"]${escaped}['\"]`, "g")) ?? [];
    assert.equal(occurrences.length, 2, `${requiredPath} must select both packages`);
  }
});

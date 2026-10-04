import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { namedWorkflowSteps } from "./workflow-test-utils.mjs";
import { assertPackageContents } from "./assert-package-contents.mjs";
import { RELEASE_PACKAGES, releasePackage, tarballName } from "./release-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseStateScript = join(root, "scripts/resolve-release-state.mjs");
const packScript = join(root, "scripts/pack-release.mjs");
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

const sdkPath = releasePackage("sdk").path;
const openclawPath = releasePackage("openclaw").path;

const UNRELEASED_VERSION = "0.0.0";
/** The versions every release-history fixture starts from. */
const BASELINE_VERSIONS = { sdk: "0.1.7", openclaw: "0.1.10" };

// Lays out every listed package at `versions[key]`, or unreleased when a test
// doesn't name it; `paths` relocates one, as a commit from before a package move
// would have it, and `omit` leaves out one added since.
async function writeReleaseState(directory, { versions, paths = {}, omit = [], hold = false }) {
  const manifest = {};
  const config = { packages: {} };
  for (const pkg of RELEASE_PACKAGES.filter((candidate) => !omit.includes(candidate.key))) {
    const path = paths[pkg.key] ?? pkg.path;
    const version = versions[pkg.key] ?? UNRELEASED_VERSION;
    manifest[path] = version;
    config.packages[path] = { "package-name": pkg.name };
    for (const file of pkg.versionFiles) {
      await mkdir(dirname(join(directory, path, file)), { recursive: true });
      await writeFile(join(directory, path, file), `${JSON.stringify({ name: pkg.name, version }, null, 2)}\n`);
    }
  }
  await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, "release-please-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  if (hold) await writeFile(join(directory, ".release-hold"), "release held\n");
}

async function withReleaseHistory(callback, { paths, omit } = {}) {
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
    await writeReleaseState(directory, { versions: BASELINE_VERSIONS, paths, omit });
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

/** Release Please's action outputs for the packages it created, keyed by package path. */
function releasePleaseOutputs(created) {
  return Object.fromEntries(Object.entries(created).flatMap(([key, version]) => [
    [`${releasePackage(key).path}--release_created`, "true"],
    [`${releasePackage(key).path}--version`, version],
  ]));
}

/** Run the release-state script and return its `packages` output, or the failed run. */
async function resolveReleaseState(directory, env) {
  const outputFile = join(directory, "github-output");
  await writeFile(outputFile, "");
  const result = run(releaseStateScript, directory, { GITHUB_OUTPUT: outputFile, ...env });
  if (result.status !== 0) return { result };
  const line = (await readFile(outputFile, "utf8")).match(/^packages=(.*)$/m)?.[1];
  return { result, packages: JSON.parse(line) };
}

for (const [scenario, created] of [
  ["no releases", {}],
  ["SDK only", { sdk: "0.1.8" }],
  ["OpenClaw only", { openclaw: "0.1.11" }],
  ["both packages independently", { sdk: "0.1.8", openclaw: "7.4.2" }],
]) {
  test(`release state selects ${scenario} in list order`, async () => {
    await withReleaseRoot(async (directory) => {
      const { result, packages } = await resolveReleaseState(directory, {
        RELEASE_PLEASE_OUTPUTS: JSON.stringify(releasePleaseOutputs(created)),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        packages.map(({ key, version }) => [key, version]),
        RELEASE_PACKAGES.filter((pkg) => pkg.key in created).map((pkg) => [pkg.key, created[pkg.key]]),
      );
    });
  });
}

test("release state names the tarball npm pack writes for each selected package", async () => {
  await withReleaseRoot(async (directory) => {
    const { packages } = await resolveReleaseState(directory, {
      RELEASE_PLEASE_OUTPUTS: JSON.stringify(releasePleaseOutputs({ sdk: "0.1.8", openclaw: "0.1.11" })),
    });
    assert.deepEqual(packages.map((pkg) => pkg.tarball), [
      "band-ai-sdk-0.1.8.tgz",
      "band-ai-openclaw-channel-band-0.1.11.tgz",
    ]);
  });
});

for (const [scenario, outputs] of [
  ["a malformed created flag", { [`${openclawPath}--release_created`]: "yes", [`${openclawPath}--version`]: "0.1.11" }],
  ["a created release without a version", { [`${openclawPath}--release_created`]: "true" }],
  ["an unstable version", releasePleaseOutputs({ openclaw: "1.0.0-rc.1" })],
  ["a version without a created release", { [`${openclawPath}--version`]: "0.1.11" }],
]) {
  test(`release state rejects ${scenario}`, async () => {
    await withReleaseRoot(async (directory) => {
      const { result } = await resolveReleaseState(directory, { RELEASE_PLEASE_OUTPUTS: JSON.stringify(outputs) });
      assert.notEqual(result.status, 0);
    });
  });
}

test("release state fails closed without Release Please outputs on an automatic run", async () => {
  await withReleaseRoot(async (directory) => {
    const { result } = await resolveReleaseState(directory, { RELEASE_PLEASE_OUTPUTS: "" });
    assert.notEqual(result.status, 0);
  });
});

test("release state selects only the recovered package at its checked-out version", async () => {
  await withReleaseRoot(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
    const { result, packages } = await resolveReleaseState(directory, { RECOVERY_PACKAGE: "openclaw" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(packages.map(({ key, path, version }) => [key, path, version]), [["openclaw", openclawPath, "0.1.11"]]);
  });
});

test("release state rejects an unknown recovery package", async () => {
  await withReleaseRoot(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
    const { result } = await resolveReleaseState(directory, { RECOVERY_PACKAGE: "nope" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release package must be one of "sdk", "openclaw"/);
  });
});

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
      versions: { sdk: "0.1.8", openclaw: "0.1.11" },
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.10" } });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "partial release"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent accepts an atomic OpenClaw-only version transition", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.7", openclaw: "0.1.11" } });
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "openclaw release"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("release intent rejects an SDK manifest/package mismatch", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.10" } });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest[sdkPath] = "0.1.9";
    await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "mismatch"], directory).status, 0);
    assert.notEqual(run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" }).status, 0);
  });
});

test("release intent rejects an OpenClaw manifest/package/plugin mismatch", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.7", openclaw: "0.1.11" } });
    await writeFile(join(directory, openclawPath, "openclaw.plugin.json"), '{"version":"0.1.12"}\n');
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.10" } });
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.10" } });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest[sdkPath] = "0.1.9";
    await writeFile(join(directory, ".release-please-manifest.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "mismatch"], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: "sdk" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sdk version fields must match/i);
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
    await writeFile(join(directory, openclawPath, "openclaw.plugin.json"), '{"version":"9.9.9"}\n');
    assert.equal(runCommand("git", ["add", "."], directory).status, 0);
    assert.equal(runCommand("git", ["commit", "-qm", "release"], directory).status, 0);
    assert.equal(runCommand("git", ["tag", "sdk-v0.1.8"], directory).status, 0);
    const result = run(intentScript, directory, { RECOVERY_PACKAGE: "sdk", REQUIRE_RELEASE_TAG: "true" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("OpenClaw recovery ignores an inconsistent unselected SDK tuple", async () => {
  await withReleaseHistory(async (directory) => {
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
    const manifest = JSON.parse(await readFile(join(directory, ".release-please-manifest.json"), "utf8"));
    manifest[sdkPath] = "9.9.9";
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.10" } });
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.7", openclaw: "0.1.11" } });
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
    await writeReleaseState(directory, { versions: { sdk: "0.1.8", openclaw: "0.1.11" } });
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

const formerOpenclawPath = "former/openclaw";

/** Commit the listed layout over a baseline that kept OpenClaw at `formerOpenclawPath`. */
async function commitOpenclawMove(directory, versions) {
  await rm(join(directory, formerOpenclawPath), { recursive: true });
  await writeReleaseState(directory, { versions });
  assert.equal(runCommand("git", ["add", "-A"], directory).status, 0);
  assert.equal(runCommand("git", ["commit", "-qm", "move openclaw"], directory).status, 0);
}

test("release intent follows a moved package to its baseline path by package name", async () => {
  await withReleaseHistory(async (directory) => {
    await commitOpenclawMove(directory, BASELINE_VERSIONS);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No release version transition detected/);
  }, { paths: { openclaw: formerOpenclawPath } });
});

test("release intent still requires an atomic transition for a moved package", async () => {
  await withReleaseHistory(async (directory) => {
    await commitOpenclawMove(directory, { sdk: "0.1.7", openclaw: "0.1.11" });
    await writeFile(join(directory, openclawPath, "openclaw.plugin.json"), '{"version":"0.1.10"}\n');
    assert.equal(runCommand("git", ["commit", "-qam", "stale plugin version"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD~2" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /transition must be atomic/);
  }, { paths: { openclaw: formerOpenclawPath } });
});

const addedPackage = RELEASE_PACKAGES.at(-1);

/** Commit the listed layout over a baseline that didn't list `addedPackage` yet. */
async function commitAddedPackage(directory, { hold = false } = {}) {
  await writeReleaseState(directory, { versions: BASELINE_VERSIONS, hold });
  assert.equal(runCommand("git", ["add", "-A"], directory).status, 0);
  assert.equal(runCommand("git", ["commit", "-qm", "add package"], directory).status, 0);
}

test("release intent accepts a package added since the baseline at matching stable versions", async () => {
  await withReleaseHistory(async (directory) => {
    await commitAddedPackage(directory);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.equal(result.status, 0, result.stderr);
  }, { omit: [addedPackage.key] });
});

test("release intent rejects a package added since the baseline with mismatched versions", async () => {
  await withReleaseHistory(async (directory) => {
    await commitAddedPackage(directory);
    await writeFile(join(directory, addedPackage.path, addedPackage.versionFiles.at(-1)), '{"version":"0.0.1"}\n');
    assert.equal(runCommand("git", ["commit", "-qam", "mismatch"], directory).status, 0);
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD~2" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version fields must match/);
  }, { omit: [addedPackage.key] });
});

test("release intent rejects a package added since the baseline while release hold exists", async () => {
  await withReleaseHistory(async (directory) => {
    await commitAddedPackage(directory, { hold: true });
    const result = run(intentScript, directory, { RELEASE_BASE_COMMIT: "HEAD^" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release hold/i);
  }, { omit: [addedPackage.key] });
});

// `withFakeNpm` puts a `#!/bin/sh` stub on PATH (joined with ":") to stand in for
// npm, and `publish-if-needed.mjs` spawns a bare `npm` with no shell. Both are
// POSIX-only, and the publish job they model only ever runs on ubuntu-latest.
// Skipping is deliberate: a permanently red suite on Windows is what teaches
// contributors to stop reading it.
const SKIP_ON_WINDOWS = process.platform === "win32"
  ? { skip: "fake-npm stub and bare `npm` lookup require a POSIX shell" }
  : {};

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

test("idempotent publisher skips an exact version already on npm", SKIP_ON_WINDOWS, async () => {
  await withFakeNpm("found", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(log, "utf8"), /^view /m);
    assert.doesNotMatch(await readFile(log, "utf8"), /^publish /m);
  });
});

test("idempotent publisher publishes only when npm confirms the version is absent", SKIP_ON_WINDOWS, async () => {
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

test("idempotent publisher fails closed when the npm lookup is inconclusive", SKIP_ON_WINDOWS, async () => {
  await withFakeNpm("error", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(await readFile(log, "utf8"), /^publish /m);
  });
});

test("idempotent publisher fails fast with a named path when the tarball is missing", SKIP_ON_WINDOWS, async () => {
  await withFakeNpm("missing", async (directory, env, log) => {
    const result = run(publishScript, directory, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /band-ai-example-1\.2\.3\.tgz/);
    assert.match(result.stderr, /not found/i);
    const logged = await readFile(log, "utf8").catch(() => "");
    assert.doesNotMatch(logged, /^publish /m);
  }, { createTarball: false });
});

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

test("release workflow resolves release state before package work and checks readiness before packing and each publish", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const releasePlease = step("Release Please");
  const releaseState = step("Resolve release state");
  const installPnpm = step("Install pnpm");
  const pack = step("Pack released packages (@band-ai)");
  const publish = step("Publish to npm (@band-ai)");

  assert.ok(releasePlease);
  assert.ok(releaseState);
  assert.ok(installPnpm);
  assert.ok(pack);
  assert.ok(publish);
  assert.ok(releasePlease.index < releaseState.index);
  assert.ok(releaseState.index < installPnpm.index);
  assert.ok(installPnpm.index < pack.index);
  assert.ok(pack.index < publish.index);
  assert.match(releaseState.body, /node scripts\/resolve-release-state\.mjs/);
  assert.match(releaseState.body, /RELEASE_PLEASE_OUTPUTS: \$\{\{ toJSON\(steps\.release\.outputs\) \}\}/);
  assert.doesNotMatch(releaseState.body, /^        if:/m);
  assert.match(pack.body, /node scripts\/assert-release-ready\.mjs\n\s+node scripts\/pack-release\.mjs/);
  assert.match(publish.body, /git fetch origin main:refs\/remotes\/origin\/main\n\s+node scripts\/assert-release-ready\.mjs\n\s+node scripts\/publish-if-needed\.mjs/);
  assert.match(publish.body, /RELEASE_HOLD_REF: refs\/remotes\/origin\/main/);
});

test("release workflow publishes each released package in its own job, one at a time in list order", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));

  assert.match(workflow, /packages: \$\{\{ steps\.release_state\.outputs\.packages \}\}/);
  assert.match(publishJob, /^    if: needs\.release\.outputs\.packages != '\[\]'$/m);
  assert.match(publishJob, /max-parallel: 1\n/);
  assert.match(publishJob, /package: \$\{\{ fromJSON\(needs\.release\.outputs\.packages\) \}\}/);
  assert.doesNotMatch(publishJob, /fail-fast: false/);
});

test("release workflow copies the SDK README before checking and packing the packlists", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const readmeCopy = step("Copy README into SDK package");
  const pack = step("Pack released packages (@band-ai)");

  assert.ok(readmeCopy, "Copy README step must exist");
  assert.ok(pack);
  assert.ok(readmeCopy.index < pack.index);
  assert.match(readmeCopy.body, /if: contains\(fromJSON\(steps\.release_state\.outputs\.packages\)\.\*\.key, 'sdk'\)/);
  // The packlist check is what fails a release that would ship without these.
  assert.ok(releasePackage("sdk").contents.required.includes("README.md"));
  assert.ok(releasePackage("openclaw").contents.required.includes("dist/band_sdk_core_bg.wasm"));
});

test("pack-release writes each listed package's tarball under the name the publish job expects", async () => {
  await withReleaseRoot(async (directory) => {
    for (const pkg of RELEASE_PACKAGES) {
      await mkdir(join(directory, pkg.key), { recursive: true });
      await writeFile(join(directory, pkg.key, "package.json"), JSON.stringify({ name: pkg.name, version: "1.2.3" }));
    }
    const selected = RELEASE_PACKAGES.map((pkg) => ({ path: pkg.key, contents: { minFiles: 1, required: ["package.json"] } }));

    const result = runCommand(process.execPath, [packScript, "release-artifacts"], directory, {
      SELECTED_PACKAGES: JSON.stringify(selected),
      npm_config_cache: join(directory, ".npm-cache"),
    });

    assert.equal(result.status, 0, result.stderr);
    for (const pkg of RELEASE_PACKAGES) {
      const tarball = join(directory, "release-artifacts", tarballName(pkg, "1.2.3"));
      assert.ok(existsSync(tarball), `npm pack must write ${tarball} for ${pkg.name}`);
    }
  });
});

test("pack-release checks each packlist before packing and stops at the first bad one", async () => {
  await withReleaseRoot(async (directory) => {
    const writePackage = async (name, files) => {
      await mkdir(join(directory, name, "dist"), { recursive: true });
      await writeFile(join(directory, name, "dist/index.js"), "export {};\n");
      await writeFile(join(directory, name, "package.json"), JSON.stringify({ name, version: "1.2.3", files }));
    };
    await writePackage("good", ["dist"]);
    await writePackage("bad", []);
    const contents = { minFiles: 2, required: ["dist/index.js", "package.json"] };

    const result = runCommand(process.execPath, [packScript, "release-artifacts"], directory, {
      SELECTED_PACKAGES: JSON.stringify([{ path: "good", contents }, { path: "bad", contents }]),
      npm_config_cache: join(directory, ".npm-cache"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required entries in bad packlist: dist\/index\.js/);
    assert.ok(existsSync(join(directory, "release-artifacts/good-1.2.3.tgz")));
    assert.ok(!existsSync(join(directory, "release-artifacts/bad-1.2.3.tgz")));
  });
});

test("plugin builds copy wasm via the shared tsup onSuccess and CI packaging requires it", () => {
  const openclawPkg = JSON.parse(readFileSync(join(root, openclawPath, "package.json"), "utf8"));
  // copy-wasm must not be a separate package pin — resolve through @band-ai/sdk.
  assert.equal(openclawPkg.devDependencies?.["@band-ai/band-sdk-core"], undefined);
  assert.match(openclawPkg.scripts.build, /tsup/);
  assert.doesNotMatch(openclawPkg.scripts.build, /copy-wasm/);
  assert.match(openclawPkg.scripts.build, /sync-plugin-version/);

  for (const pluginPath of [openclawPath, releasePackage("claude-code").path]) {
    const tsupConfig = readFileSync(join(root, pluginPath, "tsup.config.ts"), "utf8");
    assert.match(tsupConfig, /import \{ inlinedSdkBundleOptions \} from "\.\.\/\.\.\/scripts\/inlined-sdk-bundle\.mjs"/);
    assert.match(tsupConfig, /\.\.\.inlinedSdkBundleOptions/);
  }
  const bundleScript = readFileSync(join(root, "scripts/inlined-sdk-bundle.mjs"), "utf8");
  // Exit must sit inside the catch body: before the line that closes it.
  assert.match(
    bundleScript,
    /async onSuccess\(\) \{.*?try \{.*?copyWasm\(process\.cwd\(\)\).*?\} catch \(error\) \{(?:(?!\n {4}\}).)*process\.exit\(1\)/s,
  );

  const stageLink = readFileSync(join(root, openclawPath, "scripts/stage-link.mjs"), "utf8");
  assert.match(stageLink, /CORE_WASM_FILENAME/);
  assert.match(
    stageLink,
    /statSync\(wasmPath\)\.size === 0/,
  );

  // CI checks every listed package's packlist, OpenClaw's wasm included.
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /for \(const pkg of RELEASE_PACKAGES\) assertPackageContents\(pkg\.path, pkg\.contents\)/);
  assert.ok(releasePackage("openclaw").contents.required.includes("dist/band_sdk_core_bg.wasm"));
  // The plugin stamps the core version from the same lookup copy-wasm uses.
  const syncVersion = readFileSync(join(root, openclawPath, "scripts/sync-plugin-version.js"), "utf8");
  assert.match(syncVersion, /bandSdkCoreVersion/);
  assert.match(syncVersion, /resolveCoreEntry\(/);

  const pluginJson = JSON.parse(readFileSync(join(root, openclawPath, "openclaw.plugin.json"), "utf8"));
  assert.equal(typeof pluginJson.bandSdkCoreVersion, "string");
  assert.match(pluginJson.bandSdkCoreVersion, /^\d+\.\d+\.\d+/);
});

test("assert-package-contents rejects missing entries, low file counts, and excluded-but-existing files", async () => {
  await withReleaseRoot(async (directory) => {
    // A minimal package with dist included and an extra file NOT in "files"
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "dist/index.js"), "export {};\n");
    // extra.json exists on disk but is NOT listed in "files" — npm won't pack it
    await writeFile(join(directory, "extra.json"), "{}");
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "test-pkg-contents",
      version: "0.0.0",
      files: ["dist"],
    }));

    // dist/index.js is packed and package.json is always packed
    assertPackageContents(directory, { minFiles: 1, required: ["dist/index.js", "package.json"] });

    // extra.json exists on disk but is excluded from "files"
    assert.throws(
      () => assertPackageContents(directory, { minFiles: 1, required: ["extra.json"] }),
      /missing required/i,
    );
    assert.throws(
      () => assertPackageContents(directory, { minFiles: 1, required: ["README.md"] }),
      /missing required/i,
    );
    assert.throws(
      () => assertPackageContents(directory, { minFiles: 999, required: ["dist/index.js"] }),
      /floor not met/i,
    );
  });
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
  assert.deepEqual(
    workflow.match(/options: \[([^\]]*)\]/)?.[1].split(", "),
    ["automatic", ...RELEASE_PACKAGES.map((pkg) => pkg.key)],
    "recover-package must offer automatic and exactly the listed release packages",
  );
  assert.match(workflow, /default: automatic/);
  assert.match(
    workflow,
    /RECOVERY_PACKAGE: \$\{\{ inputs\['recover-package'\] != 'automatic' && inputs\['recover-package'\] \|\| '' \}\}/,
  );
  assert.match(workflow, /- name: Checkout recovery source\n {8}if: env\.RECOVERY_PACKAGE != ''\n/);
  assert.match(workflow, /- name: Release Please\n {8}if: env\.RECOVERY_PACKAGE == ''\n/);
  assert.match(workflow, /REQUIRE_RELEASE_TAG: \$\{\{ env\.RECOVERY_PACKAGE != '' \}\}/);
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
    1,
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

test("release workflow packs, uploads, downloads and publishes from one artifact directory", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const steps = namedWorkflowSteps(workflow);
  const step = (name) => steps.find((candidate) => candidate.name === name);
  const upload = step("Upload release bundle");
  const download = step("Download verified release bundle");
  const pack = step("Pack released packages (@band-ai)");
  const publish = step("Publish to npm (@band-ai)");

  assert.ok(upload);
  assert.ok(download);
  assert.ok(pack);
  assert.ok(publish);

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

  const tarball = publish.body.match(/PUBLISH_TARBALL: (.+)$/m)?.[1];
  assert.equal(tarball, "release-artifacts/${{ matrix.package.tarball }}");
  const tarballDir = tarball.slice(0, tarball.lastIndexOf("/"));
  assert.match(pack.body, new RegExp(`node scripts/pack-release\\.mjs ${tarballDir}\\n`));
  assert.equal(
    upload.body.match(/^\s+path: \|\n\s+(\S+)\/$/m)?.[1],
    tarballDir,
    "upload step must bundle the directory pack-release writes to",
  );
  assert.equal(
    download.body.match(/^\s+path: (.+)$/m)?.[1],
    tarballDir,
    "download step must extract into the exact directory the publish step reads from",
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

test("CI re-validates the trunk after a merge, over the whole tree, without cancelling itself", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  // Without a push trigger the suite only ever ran against a PR's merge commit,
  // so a red build that landed anyway stopped being reported once merged.
  assert.match(workflow, /\n {2}push:\n {4}branches: \[main\]\n/);

  // A trunk run that gets superseded leaves that commit with no verdict, which
  // reopens the same gap from the other side.
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );

  // Path filtering is a PR-time optimisation. On the trunk both packages must be
  // selected, or `ci-status` would go green having skipped lint and test.
  for (const output of ["sdk", "openclaw"]) {
    assert.match(
      workflow,
      new RegExp(
        `${output}: \\$\\{\\{ github\\.event_name == 'push' && 'true' \\|\\| steps\\.filter\\.outputs\\.${output} \\}\\}`,
      ),
      `${output} must be forced true on a push so trunk validation cannot be skipped`,
    );
  }

  // Release intent is a merge gate with no baseline on a push; running it there
  // would fail every trunk build on a missing RELEASE_BASE_COMMIT.
  assert.match(
    workflow,
    /- name: Verify release intent\n {8}if: github\.event_name == 'pull_request'\n/,
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

test("the release package list agrees with the Release Please config, manifest and package names", async () => {
  const config = JSON.parse(await readFile(join(root, "release-please-config.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, ".release-please-manifest.json"), "utf8"));
  const paths = RELEASE_PACKAGES.map((pkg) => pkg.path);

  assert.deepEqual(Object.keys(config.packages).sort(), [...paths].sort());
  assert.deepEqual(Object.keys(manifest).sort(), [...paths].sort());
  for (const pkg of RELEASE_PACKAGES) {
    const options = config.packages[pkg.path];
    assert.equal(options["package-name"], pkg.name);
    assert.deepEqual(
      ["package.json", ...(options["extra-files"] ?? []).map((file) => file.path)],
      pkg.versionFiles,
      `${pkg.name} versionFiles must be exactly the files Release Please bumps`,
    );
    const packageJson = JSON.parse(await readFile(join(root, pkg.path, "package.json"), "utf8"));
    assert.equal(packageJson.name, pkg.name);
  }
});

test("published packages point at the repository that signs their provenance", async () => {
  // npm validates repository.url against the provenance statement, so a stale
  // URL (e.g. the pre-rename thenvoi remote) fails publish with a 422.
  for (const { path: pkg } of RELEASE_PACKAGES) {
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

/** What CI must run for every released package. */
const CI_PACKAGE_SCRIPTS = ["typecheck", "lint", "test"];

test("CI uses exact nonempty package filters and selects every package for control paths", async () => {
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

  assert.doesNotMatch(workflow, /@thenvoi\/openclaw-channel-thenvoi/);
  const filteredCommands = [
    ...workflow.matchAll(/run: (pnpm [^\n]*--filter [^\n]+)/g),
  ];
  assert.equal(filteredCommands.length, (workflow.match(/--filter /g) ?? []).length, "every filter must be a run command");
  for (const command of filteredCommands) {
    assert.match(command[1], /^pnpm --fail-if-no-match --filter /);
  }
  for (const pkg of RELEASE_PACKAGES) {
    for (const script of CI_PACKAGE_SCRIPTS) {
      assert.ok(workflow.includes(`pnpm --fail-if-no-match --filter ${pkg.name} ${script}`), `CI must ${script} ${pkg.name}`);
    }
  }

  const sharedFilter = workflow.match(/^ {12}shared: &shared\n((?: {14}- .+\n)+)/m)?.[1] ?? "";
  assert.equal(
    (workflow.match(/^ {14}- \*shared$/gm) ?? []).length,
    RELEASE_PACKAGES.length,
    "every package filter must select the shared control paths",
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
    assert.ok(sharedFilter.includes(`'${requiredPath}'`), `${requiredPath} must be a shared control path`);
  }
});

test("pnpm overrides live in pnpm-workspace.yaml, not root package.json", async () => {
  const pkgRaw = await readFile(join(root, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.pnpm, undefined, "root package.json must not have a pnpm field (overrides moved to pnpm-workspace.yaml)");

  const workspaceRaw = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspaceRaw, /^overrides:/m, "pnpm-workspace.yaml must contain an overrides section");
  // Spot-check a few known overrides
  assert.match(workspaceRaw, /postcss/);
  assert.match(workspaceRaw, /protobufjs/);
  assert.match(workspaceRaw, /fast-uri/);
});

import { access } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  RELEASE_PACKAGES,
  STABLE_SEMANTIC_VERSION,
  releasePackage,
  releaseTag,
} from "./release-packages.mjs";

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function resolveBaseline() {
  const baseline = process.env.RELEASE_BASE_COMMIT;
  if (!baseline) {
    throw new Error(
      "RELEASE_BASE_COMMIT is required to validate an ordinary release version transition",
    );
  }
  if (/^0{40}$/.test(baseline)) {
    throw new Error(
      `release baseline ${baseline} is unusable (zero-commit sentinel); use the recover-package path instead`,
    );
  }
  return baseline;
}

function readBaselineJson(baseline, path) {
  const result = spawnSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot inspect release baseline ${baseline} for ${path}`);
  return JSON.parse(result.stdout);
}

/** The manifest version, then each version file's version, of `pkg` stored at `path`. */
function versionTuple(pkg, path, manifest, readPackageJson) {
  return [manifest[path], ...pkg.versionFiles.map((file) => readPackageJson(`${path}/${file}`).version)];
}

/** Where `pkg` lived at the baseline: Release Please tracks a package by name, so it may have moved. */
function baselinePath(baselineConfig, pkg) {
  const entry = Object.entries(baselineConfig.packages)
    .find(([, options]) => options["package-name"] === pkg.name);
  if (!entry) throw new Error(`${pkg.name} is not a Release Please package at the release baseline`);
  return entry[0];
}

function resolveCommit(revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`release tag ${revision} does not resolve to a commit`);
  return result.stdout.trim();
}

function assertMatchingStableVersion(label, versions) {
  if (!versions.every((value) => value === versions[0])) throw new Error(`${label} version fields must match`);
  if (!STABLE_SEMANTIC_VERSION.test(versions[0])) throw new Error(`${label} version must be stable semantic version`);
}

function assertAtomic(label, current, baseline) {
  const changed = current.map((value, index) => value !== baseline[index]);
  if (changed.some(Boolean) && !changed.every(Boolean)) {
    throw new Error(`${label} manifest and package version transition must be atomic`);
  }
  if (changed.some(Boolean)) assertMatchingStableVersion(label, current);
  return changed.some(Boolean);
}

async function assertNoHold() {
  try {
    await access(resolve(root, ".release-hold"), constants.F_OK);
    throw new Error("release hold forbids merging or executing a release version transition");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function verifyRecoveryIntent(pkg, manifest) {
  await assertNoHold();
  const versions = versionTuple(pkg, pkg.path, manifest, readJson);
  assertMatchingStableVersion(pkg.key, versions);
  if (process.env.REQUIRE_RELEASE_TAG === "true") {
    const tag = releaseTag(pkg, versions[0]);
    if (resolveCommit(tag) !== resolveCommit("HEAD")) throw new Error(`release tag ${tag} does not identify the checked-out release commit`);
  }
  console.log(`Exact ${pkg.key} recovery intent verified.`);
}

async function verifyReleaseTransitions(manifest) {
  const baseline = resolveBaseline();
  const parentManifest = readBaselineJson(baseline, ".release-please-manifest.json");
  const parentConfig = readBaselineJson(baseline, "release-please-config.json");
  const readParentJson = (path) => readBaselineJson(baseline, path);
  const changed = RELEASE_PACKAGES.map((pkg) => assertAtomic(
    pkg.name,
    versionTuple(pkg, pkg.path, manifest, readJson),
    versionTuple(pkg, baselinePath(parentConfig, pkg), parentManifest, readParentJson),
  )).some(Boolean);
  if (changed) await assertNoHold();
  console.log(changed ? "Independent package release intent verified." : "No release version transition detected; release intent passed.");
}

try {
  const manifest = readJson(".release-please-manifest.json");
  const recoveryKey = process.env.RECOVERY_PACKAGE;
  if (recoveryKey) {
    await verifyRecoveryIntent(releasePackage(recoveryKey), manifest);
  } else {
    await verifyReleaseTransitions(manifest);
  }
} catch (error) {
  console.error(`Release intent rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

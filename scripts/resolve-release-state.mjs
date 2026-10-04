/**
 * Resolve which packages this release run publishes and write them to the
 * `packages` step output as a JSON array, in publish order.
 *
 * Automatic runs read Release Please's per-package outputs from
 * RELEASE_PLEASE_OUTPUTS (`toJSON(steps.release.outputs)`); a recovery run
 * releases only RECOVERY_PACKAGE at its checked-out version.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_PACKAGES,
  STABLE_SEMANTIC_VERSION,
  releasePackage,
  tarballName,
} from "./release-packages.mjs";

function parseCreated(name, value) {
  if (value === "true") return true;
  if (value === "false" || value === "" || value === undefined) return false;
  throw new Error(`${name} must be "true", "false", or empty`);
}

function automaticReleases(outputs) {
  return RELEASE_PACKAGES.flatMap((pkg) => {
    const createdOutput = `${pkg.path}--release_created`;
    const versionOutput = `${pkg.path}--version`;
    const version = outputs[versionOutput] ?? "";
    if (!parseCreated(createdOutput, outputs[createdOutput])) {
      if (version !== "") throw new Error(`${versionOutput} must be empty when no release is created`);
      return [];
    }
    return [{ pkg, version }];
  });
}

function recoveredRelease(key) {
  const pkg = releasePackage(key);
  const { version } = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
  return [{ pkg, version }];
}

try {
  const recoveryKey = process.env.RECOVERY_PACKAGE || "";
  const releases = recoveryKey
    ? recoveredRelease(recoveryKey)
    : automaticReleases(JSON.parse(process.env.RELEASE_PLEASE_OUTPUTS ?? ""));
  for (const { pkg, version } of releases) {
    if (!STABLE_SEMANTIC_VERSION.test(version)) {
      throw new Error(`${pkg.name} release version must be a stable semantic version, got "${version}"`);
    }
  }
  const packages = releases.map(({ pkg, version }) => ({ ...pkg, version, tarball: tarballName(pkg, version) }));
  appendFileSync(process.env.GITHUB_OUTPUT, `packages=${JSON.stringify(packages)}\n`);
  console.log(`Releasing: ${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ") || "nothing"}`);
} catch (error) {
  console.error(`Release state rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

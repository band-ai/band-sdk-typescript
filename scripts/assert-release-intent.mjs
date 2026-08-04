import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const stableSemanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function readBaselineJson(path) {
  const baseline = process.env.RELEASE_BASE_COMMIT || "HEAD^";
  const result = spawnSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot inspect release baseline ${baseline} for ${path}`);
  return JSON.parse(result.stdout);
}

function resolveCommit(revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`release tag ${revision} does not resolve to a commit`);
  return result.stdout.trim();
}

function assertAtomic(label, current, baseline) {
  const changed = current.map((value, index) => value !== baseline[index]);
  if (changed.some(Boolean) && !changed.every(Boolean)) {
    throw new Error(`${label} manifest and package version transition must be atomic`);
  }
  if (changed.some(Boolean)) {
    if (!current.every((value) => value === current[0])) throw new Error(`${label} version fields must match`);
    if (!stableSemanticVersion.test(current[0])) throw new Error(`${label} version must be stable semantic version`);
  }
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

try {
  const [manifest, sdkPackage, openclawPackage, openclawPlugin] = await Promise.all([
    readJson(".release-please-manifest.json"), readJson("packages/sdk/package.json"),
    readJson("packages/openclaw/package.json"), readJson("packages/openclaw/openclaw.plugin.json"),
  ]);
  const recoveryPackage = process.env.RECOVERY_PACKAGE || "";
  if (recoveryPackage && !["sdk", "openclaw"].includes(recoveryPackage)) {
    throw new Error('RECOVERY_PACKAGE must be "sdk" or "openclaw"');
  }

  if (recoveryPackage) {
    await assertNoHold();
    const versions = recoveryPackage === "sdk"
      ? [manifest["packages/sdk"], sdkPackage.version]
      : [manifest["packages/openclaw"], openclawPackage.version, openclawPlugin.version];
    if (!versions.every((value) => value === versions[0]) || !stableSemanticVersion.test(versions[0])) {
      throw new Error(`${recoveryPackage} current manifest and package versions must match exactly`);
    }
    if (process.env.REQUIRE_RELEASE_TAG === "true") {
      const tag = recoveryPackage === "sdk" ? `sdk-v${versions[0]}` : `openclaw-channel-band-v${versions[0]}`;
      if (resolveCommit(tag) !== resolveCommit("HEAD")) throw new Error(`release tag ${tag} does not identify the checked-out release commit`);
    }
    console.log(`Exact ${recoveryPackage} recovery intent verified.`);
  } else {
    const parentManifest = readBaselineJson(".release-please-manifest.json");
    const parentSdk = readBaselineJson("packages/sdk/package.json");
    const parentOpenclaw = readBaselineJson("packages/openclaw/package.json");
    const parentPlugin = readBaselineJson("packages/openclaw/openclaw.plugin.json");
    const sdkChanged = assertAtomic("SDK", [manifest["packages/sdk"], sdkPackage.version], [parentManifest["packages/sdk"], parentSdk.version]);
    const openclawChanged = assertAtomic("OpenClaw", [manifest["packages/openclaw"], openclawPackage.version, openclawPlugin.version], [parentManifest["packages/openclaw"], parentOpenclaw.version, parentPlugin.version]);
    if (sdkChanged || openclawChanged) await assertNoHold();
    console.log(sdkChanged || openclawChanged ? "Independent package release intent verified." : "No release version transition detected; release intent passed.");
  }
} catch (error) {
  console.error(`Release intent rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

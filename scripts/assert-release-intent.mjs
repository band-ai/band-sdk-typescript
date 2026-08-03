import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const expectedPackages = ["@band-ai/sdk", "@band-ai/openclaw-channel-band"];
const stableSemanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function readBaselineJson(path) {
  const baseline = process.env.RELEASE_BASE_COMMIT || "HEAD^";
  const result = spawnSync("git", ["show", `${baseline}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`cannot inspect release baseline ${baseline} for ${path}`);
  }
  return JSON.parse(result.stdout);
}

function validateTargets(manifest) {
  const packages = manifest?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error(".release-coordination.json must contain a packages object");
  }
  if (
    JSON.stringify(Object.keys(packages).sort()) !==
    JSON.stringify([...expectedPackages].sort())
  ) {
    throw new Error("release intent must define exactly both coordinated targets");
  }
  for (const name of expectedPackages) {
    if (typeof packages[name] !== "string" || !stableSemanticVersion.test(packages[name])) {
      throw new Error(`${name} must have a stable semantic coordinated target`);
    }
  }
  return packages;
}

function resolveCommit(revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`release tag ${revision} does not resolve to a commit`);
  }
  return result.stdout.trim();
}

try {
  const [manifest, sdkPackage, openclawPackage, openclawPlugin] = await Promise.all([
    readJson(".release-please-manifest.json"),
    readJson("packages/sdk/package.json"),
    readJson("packages/openclaw/package.json"),
    readJson("packages/openclaw/openclaw.plugin.json"),
  ]);
  const parentManifest = readBaselineJson(".release-please-manifest.json");
  const parentSdk = readBaselineJson("packages/sdk/package.json");
  const parentOpenclaw = readBaselineJson("packages/openclaw/package.json");
  const parentPlugin = readBaselineJson("packages/openclaw/openclaw.plugin.json");

  const versionChanged =
    manifest["packages/sdk"] !== parentManifest["packages/sdk"] ||
    manifest["packages/openclaw"] !== parentManifest["packages/openclaw"] ||
    sdkPackage.version !== parentSdk.version ||
    openclawPackage.version !== parentOpenclaw.version ||
    openclawPlugin.version !== parentPlugin.version;

  const requireCoordinatedCurrent =
    process.env.REQUIRE_COORDINATED_CURRENT === "true";

  if (!versionChanged && !requireCoordinatedCurrent) {
    console.log("No release version transition detected; release intent passed.");
  } else {
    try {
      await access(resolve(root, ".release-hold"), constants.F_OK);
      throw new Error("release hold forbids merging or executing a release version transition");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const targets = validateTargets(await readJson(".release-coordination.json"));
    const actual = {
      "manifest SDK": manifest["packages/sdk"],
      "SDK package": sdkPackage.version,
      "manifest OpenClaw": manifest["packages/openclaw"],
      "OpenClaw package": openclawPackage.version,
      "OpenClaw plugin": openclawPlugin.version,
    };
    const expected = {
      "manifest SDK": targets["@band-ai/sdk"],
      "SDK package": targets["@band-ai/sdk"],
      "manifest OpenClaw": targets["@band-ai/openclaw-channel-band"],
      "OpenClaw package": targets["@band-ai/openclaw-channel-band"],
      "OpenClaw plugin": targets["@band-ai/openclaw-channel-band"],
    };
    for (const [field, value] of Object.entries(actual)) {
      if (value !== expected[field]) {
        throw new Error(
          `${field} version ${JSON.stringify(value)} does not match its coordinated target ${JSON.stringify(expected[field])}`,
        );
      }
    }
    if (process.env.REQUIRE_RELEASE_TAGS === "true") {
      const head = resolveCommit("HEAD");
      const releaseTags = [
        `sdk-v${sdkPackage.version}`,
        `openclaw-channel-band-v${openclawPackage.version}`,
      ];
      for (const tag of releaseTags) {
        if (resolveCommit(tag) !== head) {
          throw new Error(`release tag ${tag} does not identify the checked-out release commit`);
        }
      }
    }
    console.log("Exact coordinated release version transition verified before release creation.");
  }
} catch (error) {
  console.error(`Release intent rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

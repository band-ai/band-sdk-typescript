import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPath = resolve(process.cwd(), ".release-coordination.json");
const expectedPackages = ["@band-ai/sdk", "@band-ai/openclaw-channel-band"];
const stableSemanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error(`Coordinated release rejected: ${message}`);
  process.exitCode = 1;
}

function parseReleaseCreated(name, value) {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`${name} must be "true", "false", or empty`);
}

try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packages = manifest?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error(".release-coordination.json must contain a packages object");
  }

  const packageNames = Object.keys(packages).sort();
  const expectedNames = [...expectedPackages].sort();
  if (JSON.stringify(packageNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`coordination targets must be exactly ${expectedNames.join(", ")}`);
  }

  for (const packageName of expectedPackages) {
    if (
      typeof packages[packageName] !== "string" ||
      !stableSemanticVersion.test(packages[packageName])
    ) {
      throw new Error(`${packageName} must have a stable semantic target version`);
    }
  }

  const sdkCreated = parseReleaseCreated(
    "SDK_RELEASE_CREATED",
    process.env.SDK_RELEASE_CREATED,
  );
  const openclawCreated = parseReleaseCreated(
    "OPENCLAW_RELEASE_CREATED",
    process.env.OPENCLAW_RELEASE_CREATED,
  );

  if (!sdkCreated && !openclawCreated) {
    console.log("No package releases were created; coordination check passed.");
  } else if (!sdkCreated || !openclawCreated) {
    fail("both package releases must be created together");
  } else {
    const sdkVersion = process.env.SDK_RELEASE_VERSION ?? "";
    const openclawVersion = process.env.OPENCLAW_RELEASE_VERSION ?? "";
    if (sdkVersion !== packages["@band-ai/sdk"]) {
      fail(`@band-ai/sdk version ${JSON.stringify(sdkVersion)} does not match target ${packages["@band-ai/sdk"]}`);
    } else if (openclawVersion !== packages["@band-ai/openclaw-channel-band"]) {
      fail(`@band-ai/openclaw-channel-band version ${JSON.stringify(openclawVersion)} does not match target ${packages["@band-ai/openclaw-channel-band"]}`);
    } else {
      console.log(`Coordinated release targets matched: @band-ai/sdk@${sdkVersion} and @band-ai/openclaw-channel-band@${openclawVersion}.`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

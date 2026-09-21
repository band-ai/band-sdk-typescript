/**
 * Sync the version from package.json into both the source and dist openclaw.plugin.json.
 * Run after tsup builds the dist/ directory.
 *
 * This ensures the source plugin.json stays in sync with package.json
 * (release-please bumps package.json but not plugin.json).
 * Also stamps bandSdkCoreVersion from the same @band-ai/sdk → band-sdk-core
 * resolve graph copy-wasm uses, so NemoClaw repairs can pack a matching wasm.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const pluginPath = "openclaw.plugin.json";
const distPluginPath = "dist/openclaw.plugin.json";

const requireFromHere = createRequire(fileURLToPath(import.meta.url));
const sdkEntry = requireFromHere.resolve("@band-ai/sdk");
const requireFromSdk = createRequire(sdkEntry);
const coreEntry = requireFromSdk.resolve("@band-ai/band-sdk-core");
const coreVersion = JSON.parse(
  readFileSync(join(dirname(coreEntry), "package.json"), "utf8"),
).version;

// Sync source plugin.json
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
let sourceChanged = false;
if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  sourceChanged = true;
}
if (plugin.bandSdkCoreVersion !== coreVersion) {
  plugin.bandSdkCoreVersion = coreVersion;
  sourceChanged = true;
}
if (sourceChanged) {
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(
    `[sync-plugin-version] Updated source ${pluginPath} to plugin=${pkg.version} core=${coreVersion}`,
  );
}

// Sync dist plugin.json
writeFileSync(distPluginPath, JSON.stringify(plugin, null, 2) + "\n");
console.log(
  `[sync-plugin-version] Set ${distPluginPath} plugin=${pkg.version} core=${coreVersion}`,
);

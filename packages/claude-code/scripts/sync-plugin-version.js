/**
 * Sync package.json's version into .claude-plugin/plugin.json's $.version.
 * Run after tsup builds dist/. release-please bumps package.json but not
 * plugin.json, so this keeps the plugin manifest's version from drifting.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));

if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`[sync-plugin-version] Updated ${pluginPath} to ${pkg.version}`);
}

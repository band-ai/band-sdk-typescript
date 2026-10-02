import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const requireFromPlugin = createRequire(join(pluginRoot, "package.json"));

export function resolveBandSkillPath() {
  const sdkEntryPath = requireFromPlugin.resolve("@band-ai/sdk");
  return join(dirname(dirname(sdkEntryPath)), "skills", "band", "SKILL.md");
}

export function copyBandSkill(
  destinationPath = join(pluginRoot, "skills", "band", "SKILL.md"),
  sourcePath = resolveBandSkillPath(),
) {
  if (statSync(sourcePath).size === 0) {
    throw new Error(`[copy-band-skill] source skill is empty: ${sourcePath}`);
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  if (statSync(destinationPath).size === 0) {
    throw new Error(`[copy-band-skill] copied skill is empty: ${destinationPath}`);
  }
  return destinationPath;
}

function isCliEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isCliEntry()) {
  const destination = copyBandSkill();
  console.log(`[copy-band-skill] wrote ${destination}`);
}

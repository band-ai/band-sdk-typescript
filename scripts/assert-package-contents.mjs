/**
 * Assert that a package's npm-authoritative packlist contains all required
 * entries and meets a reviewed file-count floor.
 *
 * Usage:
 *   node scripts/assert-package-contents.mjs <package-dir> <min-file-count> [required-entry...]
 *
 * Example (SDK after README copy):
 *   node scripts/assert-package-contents.mjs packages/sdk 75 dist/index.js README.md package.json
 *
 * Uses `npm pack --dry-run --json --ignore-scripts` for the authoritative list
 * of files npm would actually publish — not filesystem existence, which can
 * miss a `files`-field exclusion.
 *
 * Exits non-zero if any required entry is missing from the packlist or if the
 * packed file count falls below the floor.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const [, , packageDir, minCountRaw, ...requiredEntries] = process.argv;

if (!packageDir || !minCountRaw) {
  console.error("Usage: assert-package-contents.mjs <package-dir> <min-file-count> [required-entry...]");
  process.exit(1);
}

const root = resolve(packageDir);
const minCount = Number(minCountRaw);

if (!Number.isFinite(minCount) || minCount < 1) {
  console.error(`Invalid min-file-count: ${minCountRaw}`);
  process.exit(1);
}

// Get the authoritative packlist from npm
let packOutput;
try {
  packOutput = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (error) {
  console.error(`Failed to run npm pack --dry-run in ${packageDir}: ${error.message}`);
  process.exit(1);
}

let packData;
try {
  packData = JSON.parse(packOutput);
} catch {
  console.error(`Failed to parse npm pack output in ${packageDir}`);
  process.exit(1);
}

const packedFiles = packData[0]?.files ?? [];
const packedPaths = new Set(packedFiles.map((f) => f.path));
const totalFiles = packedPaths.size;

// Check required entries are in the packlist
const missing = requiredEntries.filter((entry) => !packedPaths.has(entry));

if (missing.length > 0) {
  console.error(
    `Missing required entries in ${packageDir} packlist: ${missing.join(", ")}`,
  );
  process.exit(1);
}

// Check file count floor
if (totalFiles < minCount) {
  console.error(
    `Package content floor not met in ${packageDir}: npm would pack ${totalFiles} files, expected >= ${minCount}`,
  );
  process.exit(1);
}

console.log(`Package content OK: ${packageDir} packs ${totalFiles} files (floor: ${minCount})`);

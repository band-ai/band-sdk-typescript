/**
 * Assert that a package's npm-authoritative packlist contains all required
 * entries and meets a reviewed file-count floor.
 *
 * Uses `npm pack --dry-run --json --ignore-scripts` for the authoritative list
 * of files npm would actually publish — not filesystem existence, which can
 * miss a `files`-field exclusion.
 */

import { execFileSync } from "node:child_process";

export function assertPackageContents(packageDir, { minFiles, required }) {
  const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const packedPaths = new Set((JSON.parse(packOutput)[0]?.files ?? []).map((file) => file.path));

  const missing = required.filter((entry) => !packedPaths.has(entry));
  if (missing.length > 0) {
    throw new Error(`Missing required entries in ${packageDir} packlist: ${missing.join(", ")}`);
  }
  if (packedPaths.size < minFiles) {
    throw new Error(
      `Package content floor not met in ${packageDir}: npm would pack ${packedPaths.size} files, expected >= ${minFiles}`,
    );
  }
  console.log(`Package content OK: ${packageDir} packs ${packedPaths.size} files (floor: ${minFiles})`);
}

/**
 * Check the packlist of each package this run releases, then pack it.
 *
 * Usage: SELECTED_PACKAGES=<release_state packages output> node scripts/pack-release.mjs <destination-dir>
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertPackageContents } from "./assert-package-contents.mjs";

const destination = resolve(process.argv[2]);
mkdirSync(destination, { recursive: true });

for (const pkg of JSON.parse(process.env.SELECTED_PACKAGES)) {
  assertPackageContents(pkg.path, pkg.contents);
  execFileSync("npm", ["pack", "--pack-destination", destination], { cwd: pkg.path, stdio: "inherit" });
}

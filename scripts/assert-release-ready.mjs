import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const holdPath = resolve(process.cwd(), ".release-hold");

try {
  await access(holdPath, constants.F_OK);
  console.error("Release rejected: .release-hold is present.");
  process.exitCode = 1;
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log("Release-ready check passed: no .release-hold is present.");
  } else {
    console.error(`Release-ready check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

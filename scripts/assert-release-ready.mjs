import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const holdPath = resolve(process.cwd(), ".release-hold");

function assertRefNotHeld(ref) {
  const revision = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  if (revision.status !== 0) {
    throw new Error(`cannot resolve authoritative release-hold ref ${ref}`);
  }
  const hold = spawnSync("git", ["ls-tree", "--name-only", "-z", ref, "--", ".release-hold"], {
    encoding: "utf8",
  });
  if (hold.status !== 0) {
    throw new Error(`cannot inspect authoritative release-hold ref ${ref}`);
  }
  if (hold.stdout.length > 0) {
    throw new Error(`release hold is present on authoritative ref ${ref}`);
  }
}

try {
  await access(holdPath, constants.F_OK);
  console.error("Release rejected: .release-hold is present.");
  process.exitCode = 1;
} catch (error) {
  if (error?.code === "ENOENT") {
    try {
      if (process.env.RELEASE_HOLD_REF) {
        assertRefNotHeld(process.env.RELEASE_HOLD_REF);
      }
      console.log("Release-ready check passed: no .release-hold is present.");
    } catch (refError) {
      console.error(
        `Release-ready check failed: ${refError instanceof Error ? refError.message : String(refError)}`,
      );
      process.exitCode = 1;
    }
  } else {
    console.error(`Release-ready check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

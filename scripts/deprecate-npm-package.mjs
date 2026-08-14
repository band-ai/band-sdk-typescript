import { spawnSync } from "node:child_process";

function runNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

try {
  const packageName = process.env.DEPRECATE_PACKAGE;
  const message = process.env.DEPRECATE_MESSAGE;
  const range = process.env.DEPRECATE_RANGE || "*";
  const confirmation = process.env.DEPRECATE_CONFIRM;

  if (!packageName || !message) {
    throw new Error("DEPRECATE_PACKAGE and DEPRECATE_MESSAGE are required");
  }
  // This workflow exists to retire packages left behind by the Thenvoi ->
  // Band rename. Restricting it to that scope means a typo'd input can't
  // reach an unrelated, still-live package.
  if (!/^@thenvoi\//.test(packageName)) {
    throw new Error(`refusing to deprecate "${packageName}": this workflow only touches the retired @thenvoi/* scope`);
  }
  if (confirmation !== packageName) {
    throw new Error(`confirmation input must exactly match the package name ("${packageName}")`);
  }

  const lookup = runNpm(["view", packageName, "version", "--json"]);
  if (lookup.status !== 0) {
    const failure = `${lookup.stdout}\n${lookup.stderr}`;
    throw new Error(`cannot look up ${packageName} on npm: ${failure.trim()}`);
  }

  const deprecate = runNpm(["deprecate", `${packageName}@${range}`, message]);
  if (deprecate.stdout) process.stdout.write(deprecate.stdout);
  if (deprecate.stderr) process.stderr.write(deprecate.stderr);
  if (deprecate.status !== 0) {
    throw new Error(`npm deprecate failed for ${packageName}@${range} with exit ${deprecate.status}`);
  }

  console.log(`Deprecated ${packageName}@${range}: ${message}`);
} catch (error) {
  console.error(`Deprecation rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

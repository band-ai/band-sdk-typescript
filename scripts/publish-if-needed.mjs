import { spawnSync } from "node:child_process";

function runNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

try {
  const name = process.env.PUBLISH_PACKAGE_NAME;
  const version = process.env.PUBLISH_PACKAGE_VERSION;
  const tarball = process.env.PUBLISH_TARBALL;
  if (!name || !version || !tarball) {
    throw new Error(
      "PUBLISH_PACKAGE_NAME, PUBLISH_PACKAGE_VERSION, and PUBLISH_TARBALL are required",
    );
  }

  const spec = `${name}@${version}`;
  const lookup = runNpm(["view", spec, "version", "--json"]);
  if (lookup.status === 0) {
    const publishedVersion = JSON.parse(lookup.stdout);
    if (publishedVersion !== version) {
      throw new Error(`npm returned an unexpected version for ${spec}`);
    }
    console.log(`${spec} already exists on npm; continuing idempotent recovery.`);
  } else {
    const lookupFailure = `${lookup.stdout}\n${lookup.stderr}`;
    if (!/\bE404\b|404 Not Found/i.test(lookupFailure)) {
      throw new Error(`cannot prove ${spec} is absent from npm: ${lookupFailure.trim()}`);
    }

    const publish = runNpm([
      "publish",
      tarball,
      "--ignore-scripts",
      "--provenance",
      "--access",
      "public",
    ]);
    if (publish.stdout) process.stdout.write(publish.stdout);
    if (publish.stderr) process.stderr.write(publish.stderr);
    if (publish.status !== 0) {
      throw new Error(`npm publish failed for ${spec} with exit ${publish.status}`);
    }
  }
} catch (error) {
  console.error(`Package publication rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
// Classifies outdated dependencies into "safe" (same major version as the
// currently declared range, i.e. patch/minor) and "major" (major version
// bump) buckets.
//
// Usage: node classify_outdated.mjs <package-dir>
// Prints a JSON object: { safe: [...], major: [...] }
// Each entry: { name, declaredRange, latest, dependencyType }
//
// Note: this pnpm version's `pnpm outdated --format json` does not include
// an installed "current" version field, so the declared range is read
// straight from package.json instead and compared against "latest".

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: classify_outdated.mjs <package-dir>");
  process.exit(2);
}

function majorOf(version) {
  const cleaned = String(version).replace(/^[\^~>=<]+/, "").trim();
  const match = cleaned.match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const declaredRanges = {
  ...pkgJson.dependencies,
  ...pkgJson.devDependencies,
  ...pkgJson.peerDependencies,
  ...pkgJson.optionalDependencies,
};

let raw = "";
try {
  raw = execSync("pnpm outdated --format json", {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
} catch (err) {
  // pnpm outdated exits 1 when there ARE outdated deps -- that's expected,
  // not a failure. Only bail if there's no stdout to parse.
  if (err.stdout) {
    raw = err.stdout;
  } else {
    console.error(err.stderr?.toString() || String(err));
    process.exit(1);
  }
}

let parsed;
try {
  parsed = JSON.parse(raw || "{}");
} catch {
  console.error("Could not parse pnpm outdated output as JSON:\n" + raw);
  process.exit(1);
}

const safe = [];
const major = [];

for (const [name, info] of Object.entries(parsed)) {
  const declaredRange = declaredRanges[name] ?? null;
  const declaredMajor = majorOf(declaredRange);
  const latestMajor = majorOf(info.latest);
  const entry = {
    name,
    declaredRange,
    latest: info.latest,
    dependencyType: info.dependencyType,
  };
  if (declaredMajor === null || latestMajor === null) {
    // Non-semver range/latest (workspace:, catalog:, git refs, "linked",
    // etc.) -- treat as major so it gets the isolated break-check rather
    // than being blindly applied.
    major.push(entry);
  } else if (declaredMajor === latestMajor) {
    safe.push(entry);
  } else {
    major.push(entry);
  }
}

console.log(JSON.stringify({ safe, major }, null, 2));

#!/usr/bin/env node
/**
 * Dump the public export surface of a built SDK package: for every declared
 * subpath, the runtime ESM export keys and the `.d.ts` named exports, kept as
 * SEPARATE sets (a value present only in declarations but missing at runtime is
 * a real regression). Reusable for the before (C4 tip) and after surfaces.
 *
 * Usage: node scripts/dump-sdk-surface.mjs <sdkRoot> [outFile]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = resolve(process.argv[2] ?? ".");
const outFile = process.argv[3];
const pkg = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf-8"));

function dtsNamedExports(dtsText) {
  const names = new Set();
  const declRe = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = declRe.exec(dtsText))) names.add(m[1]);
  const braceRe = /export\s*(?:type\s*)?\{([^}]*)\}/g;
  while ((m = braceRe.exec(dtsText))) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z0-9_$]+)\s*$/);
      const name = asMatch ? asMatch[1] : seg.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z0-9_$]+$/.test(name) && name !== "default") names.add(name);
    }
  }
  return [...names].sort();
}

const surface = { package: pkg.name, version: pkg.version, subpaths: {} };
for (const [sub, entry] of Object.entries(pkg.exports)) {
  const mod = await import(pathToFileURL(resolve(sdkRoot, entry.import)).href);
  surface.subpaths[sub] = {
    runtime: Object.keys(mod).filter((k) => k !== "default").sort(),
    declarations: dtsNamedExports(readFileSync(resolve(sdkRoot, entry.types), "utf-8")),
  };
}

const json = JSON.stringify(surface, null, 2) + "\n";
if (outFile) {
  writeFileSync(resolve(outFile), json);
  console.error(`Wrote ${resolve(outFile)} (package=${surface.package})`);
} else {
  process.stdout.write(json);
}

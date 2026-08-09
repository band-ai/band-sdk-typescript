#!/usr/bin/env node
/**
 * Generate the single authoritative Thenvoi -> Band migration map consumed by
 * the C5 proof test, the migration-doc generator, and the live migration
 * fixture. The C5-owned symbol rows are DERIVED from the before surface
 * (C4 tip `70a2822`): every public `Thenvoi`-named export becomes its `Band`
 * counterpart, with kind inferred from whether it appears at runtime. The two
 * C3-owned Linear rows and the option-member renames are appended explicitly.
 *
 * Because the C5 rows are derived from the real before surface, the map cannot
 * silently omit a renamed export; consumers additionally assert equality with
 * that surface so deleting a row fails.
 *
 * Usage: node scripts/generate-c5-migration-map.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migDir = resolve(repoRoot, "docs/migrations");
const before = JSON.parse(readFileSync(resolve(migDir, "c5-surface-before-70a2822.json"), "utf-8"));

const symbols = [];
for (const [subpath, e] of Object.entries(before.subpaths)) {
  const runtime = new Set(e.runtime);
  const all = [...new Set([...e.runtime, ...e.declarations])].filter((n) => n.includes("Thenvoi"));
  for (const old of all.sort()) {
    symbols.push({ old, new: old.replaceAll("Thenvoi", "Band"), subpath, kind: runtime.has(old) ? "value" : "type", c3: false });
  }
}
// C3-owned Linear rows: renamed before the C4 before tip, so absent from the
// before surface, but present in the real published 0.x the live fixture packs.
symbols.push({ old: "LinearThenvoiBridgeConfig", new: "LinearBandBridgeConfig", subpath: "./linear", kind: "type", c3: true });
symbols.push({ old: "LinearThenvoiBridgeDeps", new: "LinearBandBridgeDeps", subpath: "./linear", kind: "type", c3: true });

const members = [
  { ownerOld: "A2AGatewayAdapterOptions", ownerNew: "A2AGatewayAdapterOptions", memberOld: "thenvoiRest", memberNew: "bandRest", subpath: "./adapters" },
  { ownerOld: "ThenvoiACPServerAdapterOptions", ownerNew: "BandACPServerAdapterOptions", memberOld: "thenvoiRest", memberNew: "bandRest", subpath: "./adapters" },
  { ownerOld: "LinearThenvoiBridgeConfig", ownerNew: "LinearBandBridgeConfig", memberOld: "thenvoiAppBaseUrl", memberNew: "bandAppBaseUrl", subpath: "./linear" },
];

const map = {
  package: { old: "@thenvoi/sdk", new: "@band-ai/sdk" },
  symbols,
  members,
};
writeFileSync(resolve(migDir, "c5-migration-map.json"), JSON.stringify(map, null, 2) + "\n");
console.log(`Wrote c5-migration-map.json: ${symbols.length} symbols (${symbols.filter((s) => s.c3).length} C3), ${members.length} members`);

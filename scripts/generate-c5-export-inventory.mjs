#!/usr/bin/env node
/**
 * Generate a machine-readable inventory of every declared subpath's public
 * exports (runtime ESM keys + `.d.ts` named exports) for the SDK package, plus
 * the 1.0 public-symbol migration section. Run after `pnpm --filter @band-ai/sdk
 * build`. Consumed by the C5 export-symbol proof and by release notes so the
 * migration table cannot drift from the actual package surface.
 *
 * Usage: node scripts/generate-c5-export-inventory.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = resolve(repoRoot, "packages/sdk");
const pkg = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf-8"));

/** Extract top-level named exports from a `.d.ts` file (declarations + re-exports). */
function dtsNamedExports(dtsText) {
  const names = new Set();
  // export declare class/function/const/interface/type/enum Name
  const declRe = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = declRe.exec(dtsText))) names.add(m[1]);
  // export { A, B as C } [from "..."]
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

const subpaths = Object.keys(pkg.exports);
const inventory = { package: pkg.name, version: pkg.version, subpaths: {} };

for (const sub of subpaths) {
  const entry = pkg.exports[sub];
  const esmPath = resolve(sdkRoot, entry.import);
  const dtsPath = resolve(sdkRoot, entry.types);
  const mod = await import(pathToFileURL(esmPath).href);
  const runtimeKeys = Object.keys(mod).filter((k) => k !== "default").sort();
  const dtsExports = dtsNamedExports(readFileSync(dtsPath, "utf-8"));
  inventory.subpaths[sub] = {
    runtime: runtimeKeys,
    declarations: dtsExports,
    all: [...new Set([...runtimeKeys, ...dtsExports])].sort(),
  };
}

// Any residual public identifier containing "Thenvoi" across the whole surface.
const residualThenvoi = [];
for (const [sub, e] of Object.entries(inventory.subpaths)) {
  for (const name of e.all) {
    if (name.includes("Thenvoi")) residualThenvoi.push(`${sub}:${name}`);
  }
}
inventory.residualThenvoiExports = residualThenvoi;

// 1.0 public-symbol migration table (old -> new). Package identity plus every
// renamed public export. The new names are cross-checked against the live
// inventory so release notes cannot drift from the actual package surface.
const PACKAGE_MIGRATION = { old: "@thenvoi/sdk", new: "@band-ai/sdk" };
const SYMBOL_MIGRATION = [
  ["ThenvoiLink", "BandLink", "."],
  ["ThenvoiSdkError", "BandSdkError", "./core"],
  ["FernThenvoiClientLike", "FernBandClientLike", "./rest"],
  ["ThenvoiACPServerAdapter", "BandACPServerAdapter", "./adapters"],
  ["ThenvoiACPServerAdapterOptions", "BandACPServerAdapterOptions", "./adapters"],
  ["ThenvoiMcpBackend", "BandMcpBackend", "./mcp"],
  ["ThenvoiMcpBackendKind", "BandMcpBackendKind", "./mcp"],
  ["CreateThenvoiMcpBackendOptions", "CreateBandMcpBackendOptions", "./mcp"],
  ["createThenvoiMcpBackend", "createBandMcpBackend", "./mcp"],
  ["getThenvoiSdkMcpServerConfig", "getBandSdkMcpServerConfig", "./mcp"],
  ["ThenvoiMcpServer", "BandMcpServer", "./mcp"],
  ["ThenvoiMcpServerOptions", "BandMcpServerOptions", "./mcp"],
  ["ThenvoiMcpSseServer", "BandMcpSseServer", "./mcp"],
  ["ThenvoiMcpSseServerOptions", "BandMcpSseServerOptions", "./mcp"],
  ["ThenvoiMcpStdioServer", "BandMcpStdioServer", "./mcp"],
  ["ThenvoiMcpStdioServerOptions", "BandMcpStdioServerOptions", "./mcp"],
  ["ThenvoiSdkMcpServer", "BandSdkMcpServer", "./mcp/claude"],
  ["CreateThenvoiSdkMcpServerOptions", "CreateBandSdkMcpServerOptions", "./mcp/claude"],
  ["createThenvoiSdkMcpServer", "createBandSdkMcpServer", "./mcp/claude"],
  ["LinearThenvoiBridgeConfig", "LinearBandBridgeConfig", "./linear (C3)"],
  ["LinearThenvoiBridgeDeps", "LinearBandBridgeDeps", "./linear (C3)"],
];

const missing = [];
for (const [, newName, sub] of SYMBOL_MIGRATION) {
  const key = sub.replace(/ \(C3\)$/, "");
  const present = inventory.subpaths[key]?.all.includes(newName);
  if (!present) missing.push(`${newName} (${sub})`);
}
inventory.migrationNewNamesMissingFromSurface = missing;

const mdLines = [
  "# 1.0 public symbol migration (Thenvoi \u2192 Band)",
  "",
  `Generated from \`scripts/generate-c5-export-inventory.mjs\` against \`${inventory.package}@${inventory.version}\`.`,
  "This section is derived from the live package surface so it cannot drift.",
  "",
  "## Package",
  "",
  `- \`${PACKAGE_MIGRATION.old}\` \u2192 \`${PACKAGE_MIGRATION.new}\` (no publish-time rename; the package ships under its own name).`,
  "",
  "## Exported symbols",
  "",
  "| Old export | 1.0 export | Subpath |",
  "|---|---|---|",
  ...SYMBOL_MIGRATION.map(([o, n, s]) => `| \`${o}\` | \`${n}\` | \`${s}\` |`),
  "",
  `Residual \`Thenvoi\` public exports: **${residualThenvoi.length}**. New names missing from the built surface: **${missing.length}**.`,
  "",
];
const mdPath = resolve(repoRoot, "docs/migrations/1.0-public-symbol-migration.md");
writeFileSync(mdPath, mdLines.join("\n") + "\n");
console.log(`Wrote ${mdPath}`);
if (missing.length > 0) {
  console.error("New names missing from surface:", missing);
  process.exitCode = 1;
}

const outPath = resolve(repoRoot, "docs/migrations/c5-public-export-inventory.json");
writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
console.log(`package=${inventory.package} subpaths=${subpaths.length} residualThenvoi=${residualThenvoi.length}`);
if (residualThenvoi.length > 0) {
  console.error("Residual Thenvoi exports:", residualThenvoi);
  process.exitCode = 1;
}

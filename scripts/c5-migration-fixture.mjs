#!/usr/bin/env node
/**
 * P-C5-4 live migration proof (requires public npm read access, owner-approved).
 *
 * 1. Confirm `@thenvoi/sdk` latest is < 1.0 (no premature 1.0 on the old scope).
 * 2. Pack the last supported `@thenvoi/sdk` 0.x from the registry; record its
 *    real before surface and confirm the legacy Thenvoi exports are present.
 * 3. Pack the current source as the `@band-ai/sdk` 1.0 candidate.
 * 4. In one temp project, install the required optional peers plus BOTH packages
 *    (different names coexist), then compile AND execute ESM and CJS consumers
 *    that import the old scope + old symbols, and the migrated new scope + new
 *    symbols, for the root and every declared subpath.
 *
 * No publish, auth, mutation, or deprecation pointer. Network install only.
 *
 * Usage: node scripts/c5-migration-fixture.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = resolve(repoRoot, "packages/sdk");
const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf-8"));
const OLD_SPEC = "@thenvoi/sdk";
const NEW_NAME = pkg.name; // @band-ai/sdk

const SYMBOLS = [
  ["ThenvoiLink", "BandLink", ".", "value"],
  ["ThenvoiSdkError", "BandSdkError", "/core", "value"],
  ["createThenvoiMcpBackend", "createBandMcpBackend", "/mcp", "value"],
  ["ThenvoiMcpServer", "BandMcpServer", "/mcp", "value"],
  ["createThenvoiSdkMcpServer", "createBandSdkMcpServer", "/mcp/claude", "value"],
  ["ThenvoiACPServerAdapter", "BandACPServerAdapter", "/adapters", "value"],
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function must(label, r) {
  if (r.status !== 0) {
    console.error(`FAIL: ${label}\n${r.out}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const work = mkdtempSync(join(tmpdir(), "c5-mig-"));
try {
  // 1. old scope stays < 1.0
  const oldVersion = run("npm", ["view", OLD_SPEC, "version"]).out.trim();
  const oldMajor = Number(oldVersion.split(".")[0]);
  if (!(oldMajor < 1)) { console.error(`FAIL: ${OLD_SPEC} latest ${oldVersion} is not < 1.0`); process.exit(1); }
  console.log(`ok: ${OLD_SPEC} latest ${oldVersion} < 1.0`);

  // 2. pack real old 0.x + record before surface
  must("pack old 0.x", run("npm", ["pack", `${OLD_SPEC}@${oldVersion}`, "--pack-destination", work]));
  const oldTgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  run("tar", ["-xzf", join(work, oldTgz), "-C", work]);
  const oldPkgDir = join(work, "package");
  const oldDts = readdirSync(join(oldPkgDir, "dist")).filter((f) => f.endsWith(".d.ts"))
    .map((f) => readFileSync(join(oldPkgDir, "dist", f), "utf8")).join("\n");
  for (const [oldName] of SYMBOLS) {
    if (!oldDts.includes(oldName)) { console.error(`FAIL: legacy ${oldName} absent from real 0.x before surface`); process.exit(1); }
  }
  console.log("ok: legacy Thenvoi exports present in the real 0.x package");
  const oldExtracted = join(work, "old-pkg");
  run("cp", ["-r", oldPkgDir, oldExtracted]);
  rmSync(join(work, "package"), { recursive: true, force: true });

  // 3. pack current candidate
  must("pack @band-ai candidate", run("npm", ["pack", "--ignore-scripts", "--pack-destination", work], { cwd: sdkRoot }));
  const candTgz = readdirSync(work).find((f) => f.endsWith(".tgz") && f !== oldTgz);

  // Required optional peers: the SDK's declared peerDependencies (installed at
  // their declared ranges) so every subpath's static peer imports resolve.
  const peers = Object.entries(pkg.peerDependencies || {}).map(([name, range]) => `${name}@${range}`);

  // 4. one project: install peers + old pack + candidate pack
  mkdirSync(join(work, "proj"));
  writeFileSync(join(work, "proj/package.json"), JSON.stringify({ name: "c5-mig-consumer", private: true, version: "1.0.0" }));
  must("install peers + both SDKs", run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error",
    `${OLD_SPEC}@${oldVersion}`, resolve(work, candTgz), ...peers], { cwd: join(work, "proj") }));

  const subs = Object.keys(pkg.exports);
  const oldImports = subs.map((s) => `await import(${JSON.stringify(OLD_SPEC + (s === "." ? "" : s.slice(1)))});`).join("\n");
  const newImports = subs.map((s) => `await import(${JSON.stringify(NEW_NAME + (s === "." ? "" : s.slice(1)))});`).join("\n");
  const oldSyms = SYMBOLS.map(([o, , sub]) => `import { ${o} } from ${JSON.stringify(OLD_SPEC + (sub === "." ? "" : sub))};`).join("\n");
  const newSyms = SYMBOLS.map(([, n, sub]) => `import { ${n} } from ${JSON.stringify(NEW_NAME + (sub === "." ? "" : sub))};`).join("\n");
  const oldUse = SYMBOLS.map(([o]) => `if (typeof ${o} !== "function") throw new Error("old ${o} not a value");`).join("\n");
  const newUse = SYMBOLS.map(([, n]) => `if (typeof ${n} !== "function") throw new Error("new ${n} not a value");`).join("\n");

  writeFileSync(join(work, "proj/old.mjs"), `${oldSyms}\n${oldImports}\n${oldUse}\nconsole.log("old-esm-ok");\n`);
  writeFileSync(join(work, "proj/new.mjs"), `${newSyms}\n${newImports}\n${newUse}\nconsole.log("new-esm-ok");\n`);
  writeFileSync(join(work, "proj/old.cjs"), subs.map((s) => `require(${JSON.stringify(OLD_SPEC + (s === "." ? "" : s.slice(1)))});`).join("\n") + `\nconsole.log("old-cjs-ok");\n`);
  writeFileSync(join(work, "proj/new.cjs"), subs.map((s) => `require(${JSON.stringify(NEW_NAME + (s === "." ? "" : s.slice(1)))});`).join("\n") + `\nconsole.log("new-cjs-ok");\n`);

  must("execute OLD ESM (root + every subpath + old symbols)", run(process.execPath, ["old.mjs"], { cwd: join(work, "proj") }));
  must("execute OLD CJS (root + every subpath)", run(process.execPath, ["old.cjs"], { cwd: join(work, "proj") }));
  must("execute MIGRATED ESM (root + every subpath + new symbols)", run(process.execPath, ["new.mjs"], { cwd: join(work, "proj") }));
  must("execute MIGRATED CJS (root + every subpath)", run(process.execPath, ["new.cjs"], { cwd: join(work, "proj") }));

  console.log(`\nP-C5-4 PASS: real ${OLD_SPEC}@${oldVersion} -> ${NEW_NAME} candidate migration compiles and executes for ESM+CJS across ${subs.length} subpaths.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

#!/usr/bin/env node
/**
 * P-C5-4 live migration proof (owner-approved public npm reads; no publish,
 * auth, mutation, or deprecation pointer).
 *
 *  1. Query BOTH scopes: `@thenvoi/sdk` and `@band-ai/sdk` versions; confirm the
 *     old scope's latest is < 1.0.
 *  2. Pack the real last-supported `@thenvoi/sdk` 0.x from the registry and the
 *     current `@band-ai/sdk` 1.0 candidate.
 *  3. Build ONE old consumer fixture (ESM `.mts` + CJS `.cts`) that imports the
 *     root and every declared subpath plus mapped old values/types and both old
 *     option members from `@thenvoi/sdk`.
 *  4. TRANSFORM that fixture through the authoritative package/symbol/member map,
 *     and assert no `@thenvoi/sdk` import or legacy identifier remains.
 *  5. Install required optional peers + both packages; then tsc-COMPILE (NodeNext,
 *     emit) AND EXECUTE the old fixture against the real 0.x and the migrated
 *     fixture against the candidate, for ESM and CJS.
 *  6. Red-check: a consumer importing a missing export fails to compile.
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
const OLD = "@thenvoi/sdk";
const NEW = pkg.name; // @band-ai/sdk
const tsc = join(sdkRoot, "node_modules/.bin/tsc");

// [old, new, subpath, kind]
const SYMBOLS = [
  ["ThenvoiLink", "BandLink", ".", "value"],
  ["ThenvoiSdkError", "BandSdkError", "/core", "value"],
  ["createThenvoiMcpBackend", "createBandMcpBackend", "/mcp", "value"],
  ["ThenvoiMcpServer", "BandMcpServer", "/mcp", "value"],
  ["createThenvoiSdkMcpServer", "createBandSdkMcpServer", "/mcp/claude", "value"],
  ["ThenvoiACPServerAdapter", "BandACPServerAdapter", "/adapters", "value"],
  ["FernThenvoiClientLike", "FernBandClientLike", "/rest", "type"],
  ["ThenvoiMcpBackend", "BandMcpBackend", "/mcp", "type"],
  ["ThenvoiACPServerAdapterOptions", "BandACPServerAdapterOptions", "/adapters", "type"],
];
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function must(label, r) {
  if (r.status !== 0) { console.error(`FAIL: ${label}\n${r.out}`); process.exit(1); }
  console.log(`ok: ${label}`);
}

/** Apply the authoritative old->new transform (package, symbols, member). */
function migrate(text) {
  let out = text.split(OLD).join(NEW);
  // Longest identifiers first so prefixes (…Adapter vs …AdapterOptions) are safe.
  const pairs = [...SYMBOLS].map(([o, n]) => [o, n]).sort((a, b) => b[0].length - a[0].length);
  for (const [o, n] of pairs) out = out.replace(new RegExp(`\\b${o}\\b`, "g"), n);
  out = out.replace(/\bthenvoiRest\b/g, "bandRest");
  return out;
}

const oldConsumer = (subpaths) => {
  const lines = [];
  // side-effect import of the root and every declared subpath
  for (const s of subpaths) lines.push(`import ${JSON.stringify(OLD + (s === "." ? "" : s.slice(1)))};`);
  // mapped value + type symbols
  const valueBySpec = new Map();
  const typeBySpec = new Map();
  for (const [o, , sub, kind] of SYMBOLS) {
    const spec = OLD + (sub === "." ? "" : sub);
    const map = kind === "value" ? valueBySpec : typeBySpec;
    map.set(spec, [...(map.get(spec) ?? []), o]);
  }
  for (const [spec, names] of valueBySpec) lines.push(`import { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(spec)};`);
  for (const [spec, names] of typeBySpec) lines.push(`import type { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(spec)};`);
  // option members
  lines.push(`import type { A2AGatewayAdapterOptions } from ${JSON.stringify(OLD + "/adapters")};`);
  lines.push(`type _A2ARest = A2AGatewayAdapterOptions["thenvoiRest"];`);
  lines.push(`type _AcpRest = ThenvoiACPServerAdapterOptions["thenvoiRest"];`);
  // type-level use of mapped types (indexed alias names embed no symbol)
  SYMBOLS.filter(([, , , k]) => k === "type").forEach(([o], i) => lines.push(`type _Ty${i} = ${o};`));
  // runtime use of mapped values (survives to emitted JS)
  const values = SYMBOLS.filter(([, , , k]) => k === "value").map(([o]) => o);
  lines.push(`for (const v of [${values.join(", ")}]) { if (typeof v !== "function") throw new Error("value not a function"); }`);
  lines.push(`export const _ok = true as const;`);
  return lines.join("\n") + "\n";
};

const work = mkdtempSync(join(tmpdir(), "c5-mig-"));
try {
  // 1. query BOTH scopes
  const oldVer = run("npm", ["view", OLD, "version"]).out.trim();
  const bandVer = run("npm", ["view", NEW, "version"]).out.trim() || "(unpublished)";
  console.log(`scopes: ${OLD}@${oldVer} | ${NEW}@${bandVer}`);
  if (!(Number(oldVer.split(".")[0]) < 1)) { console.error(`FAIL: ${OLD} latest ${oldVer} is not < 1.0`); process.exit(1); }
  console.log(`ok: ${OLD} latest ${oldVer} < 1.0`);

  // 2. pack real old 0.x + candidate
  must("pack old 0.x", run("npm", ["pack", `${OLD}@${oldVer}`, "--pack-destination", work]));
  const oldTgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  must("pack candidate", run("npm", ["pack", "--ignore-scripts", "--pack-destination", work], { cwd: sdkRoot }));
  const candTgz = readdirSync(work).find((f) => f.endsWith(".tgz") && f !== oldTgz);

  // 3. old consumer fixture (ESM + CJS)
  const subs = Object.keys(pkg.exports);
  const oldSrc = oldConsumer(subs);
  // 4. migrated fixture + assertions
  const migSrc = migrate(oldSrc);
  for (const bad of [OLD, "Thenvoi", "thenvoiRest"]) {
    if (migSrc.includes(bad)) { console.error(`FAIL: migrated fixture still contains "${bad}"`); process.exit(1); }
  }
  console.log("ok: migrated fixture has no @thenvoi/sdk import or legacy identifier");

  // 5. install peers + both packages
  mkdirSync(join(work, "proj"));
  writeFileSync(join(work, "proj/package.json"), JSON.stringify({ name: "c5-consumer", private: true, version: "1.0.0", type: "module" }));
  const peers = Object.entries(pkg.peerDependencies || {}).map(([n, r]) => `${n}@${r}`);
  must("install peers + both SDKs", run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error",
    `${OLD}@${oldVer}`, resolve(work, candTgz), ...peers], { cwd: join(work, "proj") }));

  writeFileSync(join(work, "proj/old.mts"), oldSrc);
  writeFileSync(join(work, "proj/old.cts"), oldSrc);
  writeFileSync(join(work, "proj/mig.mts"), migSrc);
  writeFileSync(join(work, "proj/mig.cts"), migSrc);
  writeFileSync(join(work, "proj/tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "nodenext", moduleResolution: "nodenext", target: "es2022", outDir: "build",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      typeRoots: [join(sdkRoot, "node_modules/@types")],
    },
    include: ["old.mts", "old.cts", "mig.mts", "mig.cts"],
  }));

  // compile (tsc) both fixtures together
  must("tsc compile old + migrated (ESM + CJS)", run(tsc, ["-p", "tsconfig.json"], { cwd: join(work, "proj") }));

  // execute emitted JS
  must("execute OLD ESM", run(process.execPath, ["build/old.mjs"], { cwd: join(work, "proj") }));
  must("execute OLD CJS", run(process.execPath, ["build/old.cjs"], { cwd: join(work, "proj") }));
  must("execute MIGRATED ESM", run(process.execPath, ["build/mig.mjs"], { cwd: join(work, "proj") }));
  must("execute MIGRATED CJS", run(process.execPath, ["build/mig.cjs"], { cwd: join(work, "proj") }));

  // 6. red-check: missing export fails to compile
  writeFileSync(join(work, "proj/bad.mts"), `import { NoSuchExportXyz } from ${JSON.stringify(NEW)};\nexport const _x = NoSuchExportXyz;\n`);
  writeFileSync(join(work, "proj/tsconfig.bad.json"), JSON.stringify({
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", noEmit: true, strict: true, skipLibCheck: true },
    include: ["bad.mts"],
  }));
  const bad = run(tsc, ["-p", "tsconfig.bad.json"], { cwd: join(work, "proj") });
  if (bad.status === 0) { console.error("FAIL: red-check missing-export compiled unexpectedly"); process.exit(1); }
  console.log("ok: red-check missing export fails to compile");

  console.log(`\nP-C5-4 PASS: ${OLD}@${oldVer} -> ${NEW} candidate — one fixture migrated via the authoritative map, tsc-compiled AND executed for ESM+CJS across ${subs.length} subpaths + mapped symbols/members.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Stage a clean, link-installable plugin dir at packages/openclaw/.local-link
//
// `openclaw plugins install --link` runs a safety scan that rejects symlinked
// node_modules pointing outside the install root — which is exactly what pnpm
// puts in packages/openclaw/node_modules. So we can't link the package dir
// directly. Instead we stage a dir with only { dist, openclaw.plugin.json,
// package.json (deps stripped — the SDK is bundled into dist) } and no
// node_modules, which passes the scan.
//
// Usage: build first (so dist/ exists), then run this; then:
//   openclaw plugins install --link packages/openclaw/.local-link

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(pkgRoot, ".local-link");

if (!existsSync(join(pkgRoot, "dist", "index.js"))) {
  console.error("[stage-link] dist/index.js missing — run the build first (pnpm build).");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(pkgRoot, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(pkgRoot, "openclaw.plugin.json"), join(stage, "openclaw.plugin.json"));

// Clean package.json: keep the entry + openclaw metadata, drop dependencies
// (bundled) and scripts (the staged dir is never built or installed-from).
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
const clean = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  type: pkg.type,
  main: pkg.main,
  types: pkg.types,
  exports: pkg.exports,
  files: pkg.files,
  engines: pkg.engines,
  peerDependencies: pkg.peerDependencies,
  openclaw: pkg.openclaw,
};
writeFileSync(join(stage, "package.json"), JSON.stringify(clean, null, 2) + "\n");

console.log(`[stage-link] staged ${stage}`);
console.log("[stage-link] now run: openclaw plugins install --link packages/openclaw/.local-link");

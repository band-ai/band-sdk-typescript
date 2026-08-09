/**
 * P-C5-1/2/3 proofs for the package identity + public-symbol migration.
 *
 * P-C5-2 compares the generated before (C4 tip `70a2822`) and after export
 * surfaces (runtime ESM keys and `.d.ts` named exports kept SEPARATE), proves
 * every mapped Band value is present at runtime and in declarations while its
 * old Thenvoi name is gone, imports each mapped value at runtime, and compiles
 * new/old consumer fixtures (values as value imports). P-C5-1 packs a real
 * tarball, installs it into ESM and CJS consumers, and executes runtime imports
 * of every subpath with an inverse probe. P-C5-3 checks the release workflow
 * carries no package mutation and the hold is present.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, mkdtempSync, symlinkSync, realpathSync, readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SDK_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SDK_ROOT, "../..");
const MIG_DIR = join(REPO_ROOT, "docs/migrations");
const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  exports: Record<string, { types: string; import: string; require: string }>;
};

interface Surface {
  package: string;
  subpaths: Record<string, { runtime: string[]; declarations: string[] }>;
}
// Before surface = the immutable C4-tip baseline artifact. After surface is
// computed LIVE from the current dist so it can never drift from the build (and
// so an accidental Thenvoi export/alias is caught without regenerating a file).
const before = JSON.parse(readFileSync(join(MIG_DIR, "c5-surface-before-70a2822.json"), "utf-8")) as Surface;

function dtsNamedExports(dtsText: string): string[] {
  const names = new Set<string>();
  const declRe = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
  let m: RegExpExecArray | null;
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
  return [...names];
}

const after: Surface = { package: pkg.name, subpaths: {} };
beforeAll(async () => {
  for (const [sub, entry] of Object.entries(pkg.exports)) {
    const mod = (await import(pathToFileURL(resolve(SDK_ROOT, entry.import)).href)) as Record<string, unknown>;
    after.subpaths[sub] = {
      runtime: Object.keys(mod).filter((k) => k !== "default"),
      declarations: dtsNamedExports(readFileSync(resolve(SDK_ROOT, entry.types), "utf-8")),
    };
  }
});

interface Row { old: string; new: string; sub: string; kind: "value" | "type"; c3?: boolean }
const MIGRATION: Row[] = [
  { old: "ThenvoiLink", new: "BandLink", sub: ".", kind: "value" },
  { old: "ThenvoiSdkError", new: "BandSdkError", sub: "./core", kind: "value" },
  { old: "FernThenvoiClientLike", new: "FernBandClientLike", sub: "./rest", kind: "type" },
  { old: "ThenvoiACPServerAdapter", new: "BandACPServerAdapter", sub: "./adapters", kind: "value" },
  { old: "ThenvoiACPServerAdapterOptions", new: "BandACPServerAdapterOptions", sub: "./adapters", kind: "type" },
  { old: "ThenvoiMcpBackend", new: "BandMcpBackend", sub: "./mcp", kind: "type" },
  { old: "ThenvoiMcpBackendKind", new: "BandMcpBackendKind", sub: "./mcp", kind: "type" },
  { old: "CreateThenvoiMcpBackendOptions", new: "CreateBandMcpBackendOptions", sub: "./mcp", kind: "type" },
  { old: "createThenvoiMcpBackend", new: "createBandMcpBackend", sub: "./mcp", kind: "value" },
  { old: "getThenvoiSdkMcpServerConfig", new: "getBandSdkMcpServerConfig", sub: "./mcp", kind: "value" },
  { old: "ThenvoiMcpServer", new: "BandMcpServer", sub: "./mcp", kind: "value" },
  { old: "ThenvoiMcpServerOptions", new: "BandMcpServerOptions", sub: "./mcp", kind: "type" },
  { old: "ThenvoiMcpSseServer", new: "BandMcpSseServer", sub: "./mcp", kind: "value" },
  { old: "ThenvoiMcpSseServerOptions", new: "BandMcpSseServerOptions", sub: "./mcp", kind: "type" },
  { old: "ThenvoiMcpStdioServer", new: "BandMcpStdioServer", sub: "./mcp", kind: "value" },
  { old: "ThenvoiMcpStdioServerOptions", new: "BandMcpStdioServerOptions", sub: "./mcp", kind: "type" },
  { old: "ThenvoiSdkMcpServer", new: "BandSdkMcpServer", sub: "./mcp/claude", kind: "type" },
  { old: "CreateThenvoiSdkMcpServerOptions", new: "CreateBandSdkMcpServerOptions", sub: "./mcp/claude", kind: "type" },
  { old: "createThenvoiSdkMcpServer", new: "createBandSdkMcpServer", sub: "./mcp/claude", kind: "value" },
  { old: "LinearThenvoiBridgeConfig", new: "LinearBandBridgeConfig", sub: "./linear", kind: "type", c3: true },
  { old: "LinearThenvoiBridgeDeps", new: "LinearBandBridgeDeps", sub: "./linear", kind: "type", c3: true },
];

const specFor = (sub: string): string => `@band-ai/sdk${sub === "." ? "" : sub.slice(1)}`;
const inSet = (s: Surface, sub: string, name: string, set: "runtime" | "declarations"): boolean =>
  Boolean(s.subpaths[sub]?.[set].includes(name));

describe("P-C5-2: before/after export surface migration", () => {
  it("package renamed @thenvoi/sdk -> @band-ai/sdk across the surfaces", () => {
    expect(before.package).toBe("@thenvoi/sdk");
    expect(after.package).toBe("@band-ai/sdk");
    expect(pkg.name).toBe("@band-ai/sdk");
  });

  it("the after surface exports no Thenvoi-named symbol (runtime or declaration)", () => {
    const residual: string[] = [];
    for (const [sub, e] of Object.entries(after.subpaths)) {
      for (const n of [...e.runtime, ...e.declarations]) if (n.includes("Thenvoi")) residual.push(`${sub}:${n}`);
    }
    expect(residual).toEqual([]);
  });

  it("each mapped value is present after (runtime AND declarations) and absent before-new; old is gone after", () => {
    for (const row of MIGRATION) {
      if (row.kind === "value") {
        expect(inSet(after, row.sub, row.new, "runtime"), `${row.new} missing at runtime`).toBe(true);
        expect(inSet(after, row.sub, row.new, "declarations"), `${row.new} missing in declarations`).toBe(true);
      } else {
        expect(inSet(after, row.sub, row.new, "declarations"), `${row.new} missing in declarations`).toBe(true);
      }
      expect(inSet(after, row.sub, row.old, "runtime"), `${row.old} still at runtime`).toBe(false);
      expect(inSet(after, row.sub, row.old, "declarations"), `${row.old} still in declarations`).toBe(false);
    }
  });

  it("each old name was present in the C4-tip before surface (except C3-owned rows)", () => {
    for (const row of MIGRATION) {
      if (row.c3) continue; // migrated in C3, already absent at the C4 before tip
      const set = row.kind === "value" ? "runtime" : "declarations";
      expect(inSet(before, row.sub, row.old, set), `${row.old} missing from before ${set}`).toBe(true);
    }
  });

  it("every mapped Band value is importable and callable at runtime", async () => {
    for (const row of MIGRATION) {
      if (row.kind !== "value") continue;
      const entry = pkg.exports[row.sub].import;
      const mod = (await import(pathToFileURL(resolve(SDK_ROOT, entry)).href)) as Record<string, unknown>;
      expect(typeof mod[row.new], `${row.new} not a runtime value in ${row.sub}`).toBe("function");
    }
  });
});

describe("P-C5-2: consumer compile proof (values as value imports)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c5-compile-"));
    const nm = join(tmpDir, "node_modules/@band-ai/sdk");
    mkdirSync(nm, { recursive: true });
    cpSync(join(SDK_ROOT, "dist"), join(nm, "dist"), { recursive: true });
    cpSync(join(SDK_ROOT, "package.json"), join(nm, "package.json"));
  });

  function compile(filename: string, code: string): { status: number; output: string } {
    writeFileSync(join(tmpDir, filename), code);
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022",
        noEmit: true, skipLibCheck: true, typeRoots: [join(SDK_ROOT, "node_modules/@types")],
      },
      include: [filename],
    }));
    const r = spawnSync(join(SDK_ROOT, "node_modules/.bin/tsc"), ["-p", join(tmpDir, "tsconfig.json")], { encoding: "utf8" });
    return { status: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  function fixture(useNew: boolean): string {
    const valueBySpec = new Map<string, string[]>();
    const typeBySpec = new Map<string, string[]>();
    for (const row of MIGRATION) {
      const name = useNew ? row.new : row.old;
      const spec = specFor(row.sub);
      const target = row.kind === "value" ? valueBySpec : typeBySpec;
      const list = target.get(spec) ?? [];
      list.push(name);
      target.set(spec, list);
    }
    const lines: string[] = [];
    const values: string[] = [];
    for (const [spec, names] of valueBySpec) {
      lines.push(`import { ${[...new Set(names)].join(", ")} } from "${spec}";`);
      values.push(...names);
    }
    for (const [spec, names] of typeBySpec) {
      lines.push(`import type { ${[...new Set(names)].join(", ")} } from "${spec}";`);
    }
    // Force value bindings to be used (not elided) so a runtime-missing value fails.
    lines.push(`export const _values: unknown[] = [${[...new Set(values)].join(", ")}];`);
    return lines.join("\n") + "\n";
  }

  it("a consumer importing every mapped Band name (values as values) compiles", () => {
    const result = compile("new.mts", fixture(true));
    expect(result.status).toBe(0);
  });

  it("a consumer importing the old Thenvoi names fails with a diagnostic for each", () => {
    const result = compile("old.mts", fixture(false));
    expect(result.status).not.toBe(0);
    for (const row of MIGRATION) {
      expect(result.output, `missing diagnostic for ${row.old}`).toContain(row.old);
    }
  });

  it("the renamed thenvoiRest -> bandRest option member: new compiles, old fails", () => {
    const ok = compile("member-new.mts", `
      import type { A2AGatewayAdapterOptions } from "@band-ai/sdk/adapters";
      import type { BandACPServerAdapterOptions } from "@band-ai/sdk/adapters";
      const _a: Pick<A2AGatewayAdapterOptions, "bandRest"> = {} as { bandRest: never };
      const _b: Pick<BandACPServerAdapterOptions, "bandRest"> = {} as { bandRest: never };
      void _a; void _b;
    `);
    expect(ok.status).toBe(0);
    const bad = compile("member-old.mts", `
      import type { A2AGatewayAdapterOptions } from "@band-ai/sdk/adapters";
      type _Old = Pick<A2AGatewayAdapterOptions, "thenvoiRest">;
      const _x: _Old = {} as never; void _x;
    `);
    expect(bad.status).not.toBe(0);
    expect(bad.output).toContain("thenvoiRest");
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("P-C5-1: real tarball packs, installs, and runs for ESM and CJS", () => {
  // The consumer lives OUTSIDE the repo (an in-repo consumer would trigger
  // Node package self-referencing and resolve the workspace package instead of
  // the installed tarball). Every external the built dist statically imports and
  // that resolves in the SDK's node_modules (production deps + the optional peers
  // the imported subpaths genuinely require) is symlinked by realpath; node
  // builtins are skipped. Fully offline — no registry install.
  let consumer: string;
  let extracted: string;

  function requiredExternals(distDir: string): string[] {
    const ext = new Set<string>();
    for (const f of readdirSync(distDir)) {
      if (!/\.js$/.test(f)) continue;
      const t = readFileSync(join(distDir, f), "utf8");
      for (const m of t.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"'.][^"']*)["']/g)) {
        const s = m[1];
        if (s.startsWith("node:")) continue;
        const parts = s.split("/");
        ext.add(s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
    return [...ext];
  }

  beforeAll(() => {
    const packDir = mkdtempSync(join(tmpdir(), "c5-pack-"));
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: SDK_ROOT, encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const tgz = (packed.stdout.trim().split("\n").pop() ?? "").trim();
    const tgzPath = join(packDir, tgz);
    expect(existsSync(tgzPath), `tarball ${tgzPath} not produced`).toBe(true);

    const untar = spawnSync("tar", ["-xzf", tgzPath, "-C", packDir], { encoding: "utf8" });
    expect(untar.status, untar.stderr).toBe(0);
    extracted = join(packDir, "package");

    consumer = mkdtempSync(join(tmpdir(), "c5-consume-"));
    const nm = join(consumer, "node_modules");
    cpSync(extracted, join(nm, "@band-ai/sdk"), { recursive: true });
    for (const dep of requiredExternals(join(extracted, "dist"))) {
      let target: string;
      try {
        target = realpathSync(join(SDK_ROOT, "node_modules", dep));
      } catch {
        continue; // node builtin or not installed — skipped
      }
      const linkPath = join(nm, dep);
      mkdirSync(resolve(linkPath, ".."), { recursive: true });
      symlinkSync(target, linkPath);
    }
  });

  it("the packed tarball is named @band-ai/sdk and carries no legacy scope", () => {
    const packedPkg = JSON.parse(readFileSync(join(extracted, "package.json"), "utf-8")) as { name: string };
    expect(packedPkg.name).toBe("@band-ai/sdk");
    // No packed dist file leaks a legacy import.
    const grep = spawnSync("grep", ["-rl", "@thenvoi/sdk", join(extracted, "dist")], { encoding: "utf8" });
    expect(grep.stdout.trim()).toBe("");
  });

  it("every declared subpath imports at runtime under ESM and CJS from the installed tarball", () => {
    const subs = Object.keys(pkg.exports);
    const esm = subs.map((s) => `await import("${specFor(s)}");`).join("\n");
    const cjs = subs.map((s) => `require("${specFor(s)}");`).join("\n");
    writeFileSync(join(consumer, "c.mjs"), `${esm}\nconsole.log("esm-ok");\n`);
    writeFileSync(join(consumer, "c.cjs"), `${cjs}\nconsole.log("cjs-ok");\n`);

    const runEsm = spawnSync(process.execPath, ["c.mjs"], { cwd: consumer, encoding: "utf8" });
    expect(runEsm.status, `ESM run failed: ${runEsm.stderr}`).toBe(0);
    expect(runEsm.stdout).toContain("esm-ok");

    const runCjs = spawnSync(process.execPath, ["c.cjs"], { cwd: consumer, encoding: "utf8" });
    expect(runCjs.status, `CJS run failed: ${runCjs.stderr}`).toBe(0);
    expect(runCjs.stdout).toContain("cjs-ok");
  });

  it("inverse probe: a corrupted packed entry makes the runtime import fail", () => {
    rmSync(join(consumer, "node_modules/@band-ai/sdk/dist/index.js"), { force: true });
    writeFileSync(join(consumer, "probe.mjs"), `await import("@band-ai/sdk");\n`);
    const run = spawnSync(process.execPath, ["probe.mjs"], { cwd: consumer, encoding: "utf8" });
    expect(run.status).not.toBe(0);
  });

  it("cleanup", () => {
    rmSync(consumer, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("P-C5-3: release workflow has no package mutation and the hold is present", () => {
  it("release.yml no longer rewrites the SDK package name and carries no legacy scope", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf-8");
    expect(yml).not.toMatch(/sed[^\n]*packages\/sdk\/package\.json/);
    expect(yml).not.toContain("@thenvoi/sdk");
    expect(yml).toMatch(/npm pack --pack-destination/);
  });

  it(".release-hold marker exists at the repository root", () => {
    expect(existsSync(join(REPO_ROOT, ".release-hold"))).toBe(true);
  });
});

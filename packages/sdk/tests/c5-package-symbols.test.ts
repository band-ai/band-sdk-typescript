/**
 * P-C5-2 proof: the package public surface is fully migrated to Band names.
 *
 * - Runtime + declaration inventory across every declared subpath contains no
 *   `Thenvoi` export (completeness), and every mapped Band name is present while
 *   its old Thenvoi name is absent (mapping).
 * - A NodeNext consumer importing every mapped new name from its subpath
 *   compiles; a consumer importing the old names fails with a missing-export
 *   diagnostic naming each old symbol (clean cutover, no alias).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SDK_ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf-8")) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
};

interface MigrationRow {
  old: string;
  new: string;
  subpath: string;
  kind: "value" | "type";
}

// Authoritative C5 public migration table (Band replacements for every remaining
// public Thenvoi* export). C3 already owns the two Linear rows.
const MIGRATION: MigrationRow[] = [
  { old: "ThenvoiLink", new: "BandLink", subpath: ".", kind: "value" },
  { old: "ThenvoiSdkError", new: "BandSdkError", subpath: "./core", kind: "value" },
  { old: "FernThenvoiClientLike", new: "FernBandClientLike", subpath: "./rest", kind: "type" },
  { old: "ThenvoiACPServerAdapter", new: "BandACPServerAdapter", subpath: "./adapters", kind: "value" },
  { old: "ThenvoiACPServerAdapterOptions", new: "BandACPServerAdapterOptions", subpath: "./adapters", kind: "type" },
  { old: "ThenvoiMcpBackend", new: "BandMcpBackend", subpath: "./mcp", kind: "type" },
  { old: "ThenvoiMcpBackendKind", new: "BandMcpBackendKind", subpath: "./mcp", kind: "type" },
  { old: "CreateThenvoiMcpBackendOptions", new: "CreateBandMcpBackendOptions", subpath: "./mcp", kind: "type" },
  { old: "createThenvoiMcpBackend", new: "createBandMcpBackend", subpath: "./mcp", kind: "value" },
  { old: "getThenvoiSdkMcpServerConfig", new: "getBandSdkMcpServerConfig", subpath: "./mcp", kind: "value" },
  { old: "ThenvoiMcpServer", new: "BandMcpServer", subpath: "./mcp", kind: "value" },
  { old: "ThenvoiMcpServerOptions", new: "BandMcpServerOptions", subpath: "./mcp", kind: "type" },
  { old: "ThenvoiMcpSseServer", new: "BandMcpSseServer", subpath: "./mcp", kind: "value" },
  { old: "ThenvoiMcpSseServerOptions", new: "BandMcpSseServerOptions", subpath: "./mcp", kind: "type" },
  { old: "ThenvoiMcpStdioServer", new: "BandMcpStdioServer", subpath: "./mcp", kind: "value" },
  { old: "ThenvoiMcpStdioServerOptions", new: "BandMcpStdioServerOptions", subpath: "./mcp", kind: "type" },
  { old: "ThenvoiSdkMcpServer", new: "BandSdkMcpServer", subpath: "./mcp/claude", kind: "type" },
  { old: "CreateThenvoiSdkMcpServerOptions", new: "CreateBandSdkMcpServerOptions", subpath: "./mcp/claude", kind: "type" },
  { old: "createThenvoiSdkMcpServer", new: "createBandSdkMcpServer", subpath: "./mcp/claude", kind: "value" },
  { old: "LinearThenvoiBridgeConfig", new: "LinearBandBridgeConfig", subpath: "./linear", kind: "type" },
  { old: "LinearThenvoiBridgeDeps", new: "LinearBandBridgeDeps", subpath: "./linear", kind: "type" },
];

function dtsNamedExports(dtsText: string): Set<string> {
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
  return names;
}

const surface = new Map<string, Set<string>>(); // subpath -> union of runtime+dts export names

beforeAll(async () => {
  for (const [sub, entry] of Object.entries(pkg.exports)) {
    const mod = (await import(pathToFileURL(resolve(SDK_ROOT, entry.import)).href)) as Record<string, unknown>;
    const names = new Set<string>(Object.keys(mod).filter((k) => k !== "default"));
    for (const n of dtsNamedExports(readFileSync(resolve(SDK_ROOT, entry.types), "utf-8"))) names.add(n);
    surface.set(sub, names);
  }
});

describe("P-C5-2: public export inventory is fully Band-migrated", () => {
  it("packed name is @band-ai/sdk", () => {
    expect(pkg.name).toBe("@band-ai/sdk");
  });

  it("no declared subpath exports any Thenvoi-named symbol", () => {
    const residual: string[] = [];
    for (const [sub, names] of surface) {
      for (const n of names) if (n.includes("Thenvoi")) residual.push(`${sub}:${n}`);
    }
    expect(residual).toEqual([]);
  });

  it("each mapped Band name is exported from its subpath; the old Thenvoi name is absent", () => {
    for (const row of MIGRATION) {
      const names = surface.get(row.subpath);
      expect(names, `subpath ${row.subpath} missing from exports`).toBeDefined();
      expect(names!.has(row.new), `${row.new} missing from ${row.subpath}`).toBe(true);
      expect(names!.has(row.old), `${row.old} still exported from ${row.subpath}`).toBe(false);
    }
  });
});

describe("P-C5-2: NodeNext consumer compile proof", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `c5-consume-${Date.now()}`);
    const nmDir = join(tmpDir, "node_modules/@band-ai/sdk");
    mkdirSync(nmDir, { recursive: true });
    cpSync(join(SDK_ROOT, "dist"), join(nmDir, "dist"), { recursive: true });
    cpSync(join(SDK_ROOT, "package.json"), join(nmDir, "package.json"));
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022",
        noEmit: true, skipLibCheck: true, typeRoots: [join(SDK_ROOT, "node_modules/@types")],
      },
      include: ["*.mts"],
    }));
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

  function importLines(useNew: boolean): string {
    const bySub = new Map<string, string[]>();
    for (const row of MIGRATION) {
      const name = useNew ? row.new : row.old;
      const spec = `@band-ai/sdk${row.subpath === "." ? "" : row.subpath.slice(1)}`;
      const list = bySub.get(spec) ?? [];
      list.push(name);
      bySub.set(spec, list);
    }
    return [...bySub.entries()]
      .map(([spec, names]) => `import type { ${[...new Set(names)].join(", ")} } from "${spec}";`)
      .join("\n");
  }

  it("a consumer importing every mapped Band name compiles", () => {
    const code = `${importLines(true)}\nexport const _ok = true;\n`;
    const result = compile("new.mts", code);
    expect(result.status).toBe(0);
  });

  it("a consumer importing the old Thenvoi names fails with a missing-export diagnostic for each", () => {
    const code = `${importLines(false)}\nexport const _ok = true;\n`;
    const result = compile("old.mts", code);
    expect(result.status).not.toBe(0);
    for (const row of MIGRATION) {
      expect(result.output, `expected missing-export diagnostic for ${row.old}`).toContain(row.old);
    }
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("P-C5-3: release workflow contains no package mutation and the hold is present", () => {
  const REPO_ROOT = resolve(SDK_ROOT, "../..");

  it("release.yml no longer rewrites the SDK package name at publish time", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf-8");
    // No sed/rename mutation of the SDK package.json name, and no legacy scope.
    expect(yml).not.toMatch(/sed[^\n]*@(thenvoi|band-ai)\\?\/sdk/);
    expect(yml).not.toMatch(/sed[^\n]*packages\/sdk\/package\.json/);
    expect(yml).not.toContain("@thenvoi/sdk");
  });

  it("the SDK is packed under its own name with no publish-time rename step", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf-8");
    // The pack step runs the ready guard then npm pack directly.
    expect(yml).toMatch(/npm pack --pack-destination/);
  });

  it(".release-hold marker exists at the repository root", () => {
    // The hold blocks every package transition; the release-hardening suite
    // proves the guard fails while it is present.
    expect(existsSync(join(REPO_ROOT, ".release-hold"))).toBe(true);
  });
});

describe("P-C5-1: packed identity, subpath resolution, and no legacy leakage", () => {
  it("npm pack reports name @band-ai/sdk and includes dist + README", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: SDK_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ name: string; files: Array<{ path: string }> }>;
    const meta = parsed[0];
    expect(meta.name).toBe("@band-ai/sdk");
    const paths = meta.files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(60);
    // No packed path carries the legacy scope.
    expect(paths.every((p) => !p.includes("thenvoi"))).toBe(true);
  });

  it("the built dist contains no @thenvoi/sdk import leakage", () => {
    const distDir = join(SDK_ROOT, "dist");
    const offenders: string[] = [];
    for (const file of readdirSync(distDir)) {
      if (!/\.(js|cjs|d\.ts|d\.cts)$/.test(file)) continue;
      if (readFileSync(join(distDir, file), "utf-8").includes("@thenvoi/sdk")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("every declared subpath resolves for both ESM and CJS consumers", () => {
    const tmp = join(tmpdir(), `c5-subpaths-${Date.now()}`);
    const nmDir = join(tmp, "node_modules/@band-ai/sdk");
    mkdirSync(nmDir, { recursive: true });
    cpSync(join(SDK_ROOT, "dist"), join(nmDir, "dist"), { recursive: true });
    cpSync(join(SDK_ROOT, "package.json"), join(nmDir, "package.json"));
    try {
      const specs = Object.keys(pkg.exports).map((s) => `@band-ai/sdk${s === "." ? "" : s.slice(1)}`);
      const body = specs.map((s, i) => `import type * as _m${i} from "${s}";\nvoid (0 as unknown as typeof _m${i});`).join("\n");
      for (const [file] of [["c.mts"], ["c.cts"]] as const) {
        writeFileSync(join(tmp, file), `${body}\nexport const _ok = true;\n`);
        writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
          compilerOptions: {
            strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022",
            noEmit: true, skipLibCheck: true, typeRoots: [join(SDK_ROOT, "node_modules/@types")],
          },
          include: [file],
        }));
        const r = spawnSync(join(SDK_ROOT, "node_modules/.bin/tsc"), ["-p", join(tmp, "tsconfig.json")], { encoding: "utf8" });
        expect(r.status, `${file} subpath resolution failed: ${(r.stdout ?? "") + (r.stderr ?? "")}`).toBe(0);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const SDK_ROOT = resolve(__dirname, "../..");
const DIST = join(SDK_ROOT, "dist");

// `node_modules/.bin/tsc` is a POSIX shell script; the Windows entry points are
// `tsc.CMD`/`tsc.ps1`, so spawning the extensionless shim there fails with
// ENOENT. Resolving the compiler's own JS entry and running it under the
// current Node binary is platform-independent and needs no `shell: true`.
const TSC_ENTRY = createRequire(join(SDK_ROOT, "package.json")).resolve("typescript/lib/tsc.js");

/**
 * Budget for one compiler run, tarball pack, or `dist` copy. Each costs seconds
 * even warm, and far more when the whole suite is running in parallel; the
 * suite-wide timeouts are sized for ordinary tests.
 */
export const COMPILE_PROOF_TIMEOUT_MS = 120_000;

/**
 * Spread onto a `describe` that spawns a compiler or packs a tarball.
 *
 * This covers the *tests* only. Vitest governs hooks with a separate
 * `hookTimeout`, so a `beforeAll` doing the same heavy work must be given
 * `COMPILE_PROOF_TIMEOUT_MS` explicitly as its own second argument.
 */
export const COMPILE_PROOF_OPTS = { timeout: COMPILE_PROOF_TIMEOUT_MS } as const;

export interface CompileResult {
  /** The compiler's exit code. Never synthesized — a compiler that did not run throws instead. */
  status: number;
  /** Combined stdout+stderr, which is where `tsc` writes its diagnostics. */
  output: string;
}

/**
 * Copies the built SDK into `<dir>/node_modules/@band-ai/sdk` so a consumer
 * placed in `dir` resolves the package through its real `exports` map under
 * NodeNext — no `paths` alias pointing straight at a declaration file.
 */
export function linkBuiltSdk(dir: string): void {
  if (!existsSync(DIST)) {
    throw new Error(
      `compile proofs need a built SDK: ${DIST} is missing (run \`pnpm --filter @band-ai/sdk build\`)`,
    );
  }
  const nmDir = join(dir, "node_modules/@band-ai/sdk");
  mkdirSync(nmDir, { recursive: true });
  cpSync(DIST, join(nmDir, "dist"), { recursive: true });
  cpSync(join(SDK_ROOT, "package.json"), join(nmDir, "package.json"));
}

/**
 * Writes `filename` plus a NodeNext `tsconfig.json` into `dir` and type-checks
 * it with the repository's own TypeScript.
 *
 * Throws if the compiler could not be started or was killed. Callers assert
 * `status !== 0` to prove a legacy symbol is rejected, and a spawn failure
 * reported as a non-zero exit would satisfy that assertion without the compiler
 * ever having looked at the code.
 */
export function compileConsumer(dir: string, filename: string, code: string): CompileResult {
  writeFileSync(join(dir, filename), code);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [join(SDK_ROOT, "node_modules/@types")],
    },
    include: [filename],
  }));

  const result = spawnSync(process.execPath, [TSC_ENTRY, "-p", join(dir, "tsconfig.json")], {
    encoding: "utf8",
    // Without a timeout, a hung `tsc` blocks this synchronous spawn — and with
    // it, the Node event loop — so Vitest's own testTimeout/hookTimeout can
    // never fire to end the test. This is the real backstop those timeouts are
    // meant to be; without it a hang runs until the CI job's own timeout kills
    // the whole runner instead.
    timeout: COMPILE_PROOF_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(`tsc was terminated by signal ${String(result.signal)} and produced no verdict`);
  }
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

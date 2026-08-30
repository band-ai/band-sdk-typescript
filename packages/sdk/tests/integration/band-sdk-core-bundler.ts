/**
 * Proves @band-ai/band-sdk-core (eager wasm load, no init()) resolves and
 * runs through packages/sdk's tsup-built dist/ output, not just under
 * vitest/ts-node resolution.
 *
 * Run:  npx tsx tests/integration/band-sdk-core-bundler.ts
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

function pass(name: string) {
  console.log(`  ✅ ${name}`);
}

function fail(name: string, error: string): never {
  console.log(`  ❌ ${name}: ${error}`);
  throw new Error(`${name}: ${error}`);
}

async function main() {
  console.log("bundler === @band-ai/band-sdk-core bundler interop ===");

  const corePkgJson = resolve(PACKAGE_ROOT, "node_modules/@band-ai/band-sdk-core/package.json");
  if (!existsSync(corePkgJson)) {
    fail(
      "dependency installed",
      `@band-ai/band-sdk-core not found under ${PACKAGE_ROOT}/node_modules — run 'pnpm install' at the workspace root`,
    );
  }
  pass("@band-ai/band-sdk-core resolves in packages/sdk/node_modules");

  console.log("bundler Building packages/sdk (tsup)...");
  execSync("pnpm build", { cwd: PACKAGE_ROOT, stdio: "inherit" });

  const builtRuntimePath = resolve(PACKAGE_ROOT, "dist/runtime.cjs");
  if (!existsSync(builtRuntimePath)) {
    fail("build output exists", `${builtRuntimePath} was not produced by the build`);
  }
  pass("build produced dist/runtime.cjs");

  // Throws here if tsup inlined the wasm package instead of leaving it external.
  const runtime = require(builtRuntimePath) as Record<string, unknown>;
  if (typeof runtime.ExecutionContext !== "function" || typeof runtime.AgentTools !== "function") {
    fail("built runtime exposes expected exports", "ExecutionContext/AgentTools missing from dist/runtime.cjs");
  }
  pass("dist/runtime.cjs loaded and eager-loaded the wasm dependency without throwing");

  // Exercise the same package instance the built output would resolve.
  const core = require("@band-ai/band-sdk-core") as typeof import("@band-ai/band-sdk-core");

  const retryTracker = new core.RetryTracker(1);
  const [attempts, exceeded] = retryTracker.recordAttempt("msg-1");
  if (attempts !== 1 || exceeded !== false) {
    fail("RetryTracker.recordAttempt", `expected [1, false], got [${attempts}, ${exceeded}]`);
  }
  pass("RetryTracker.recordAttempt runs against the real wasm binding");

  const roster = new core.ParticipantRoster();
  const isNew = roster.add({ id: "p1", name: "Jane", type: "User", handle: "@jane" });
  if (!isNew || roster.list().length !== 1) {
    fail("ParticipantRoster.add", `expected a new participant to be added, got list length ${roster.list().length}`);
  }
  pass("ParticipantRoster.add runs against the real wasm binding");

  console.log("bundler PASSED");
}

main().catch((err) => {
  console.error("bundler FAILED:", err);
  process.exit(1);
});

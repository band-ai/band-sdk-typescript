/**
 * Bundler-interop harness: proves @band-ai/band-sdk-core — a Node
 * CommonJS package with an eager (synchronous, no `init()`) wasm load —
 * actually resolves and runs through packages/sdk's own tsup-built dist/
 * output, not just under vitest/ts-node's own module resolution.
 *
 * Generically named so INT-1237 (event-validation integration, which needs
 * the identical pack -> build -> run-bundled-output flow for its own
 * band-sdk-core usage) can reuse this unchanged.
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

  // packages/sdk's own runtime entry does a top-level, unconditional
  // `require("@band-ai/band-sdk-core")` (via ExecutionContext/AgentTools).
  // If tsup's `external` treatment had inlined the wasm-backed package
  // incorrectly, or the built CJS output couldn't resolve it at all, this
  // require() itself would throw before any test code runs.
  const runtime = require(builtRuntimePath) as Record<string, unknown>;
  if (typeof runtime.ExecutionContext !== "function" || typeof runtime.AgentTools !== "function") {
    fail("built runtime exposes expected exports", "ExecutionContext/AgentTools missing from dist/runtime.cjs");
  }
  pass("dist/runtime.cjs loaded and eager-loaded the wasm dependency without throwing");

  // Exercise the same package instance node resolution would hand to the
  // built output, calling one method on each delivery-state class.
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

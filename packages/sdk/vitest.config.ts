import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's 5s default is far below the honest cost of this suite's slowest
    // work. The import-boundary proofs reset the module registry and import a
    // whole entrypoint, forcing a fresh transform of the entire module graph:
    // ~4.5s warm and standalone, but well over 20s when the full suite is
    // running files in parallel and contending for CPU. Sizing the timeout off
    // the warm number is what makes those tests flaky rather than slow.
    //
    // 60s is therefore chosen against observed worst-case contention, not the
    // happy path. It costs nothing when tests pass and delays a genuinely hung
    // test by well under a minute — a cheap trade for a suite whose whole value
    // is that a red result means something.
    //
    // Proofs that spawn a compiler or pack a tarball are heavier still and set
    // their own timeout at the `describe`, and on their `beforeAll` — Vitest
    // governs hooks with `hookTimeout` separately from tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reportsDirectory: "./coverage",
      tempDirectory: "./.vitest-coverage-tmp",
      reporter: ["text"],
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's 5s default is below the honest cost of this suite's slowest
    // honest work — the import-boundary proofs reset the module registry and
    // load a whole entrypoint (~4.5s on a warm dev machine), which makes them a
    // coin flip on a loaded CI runner. Heavier proofs that spawn a compiler or
    // pack a tarball set their own, longer timeout at the `describe`.
    testTimeout: 20_000,
    hookTimeout: 20_000,
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

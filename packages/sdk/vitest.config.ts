import { defineConfig } from "vitest/config";

// Native V8 instrumentation makes the compile-proof tests slower than the normal timeout.
const coverageTestTimeout = process.env.NODE_V8_COVERAGE ? 30_000 : undefined;

export default defineConfig({
  test: {
    testTimeout: coverageTestTimeout,
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

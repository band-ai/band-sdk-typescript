/**
 * `node:sqlite` landed in Node 22.5 behind `--experimental-sqlite` and only
 * became available unflagged in 22.13.
 *
 * CONTRIBUTING pins the development floor at 22.14 and CI runs `node-version:
 * 22` (latest 22.x), so in every supported environment these tests run for
 * real. But `packages/sdk/package.json` still declares `engines.node >=22.12`,
 * and on such a runtime the store degrades honestly — it throws
 * `UnsupportedFeatureError` — leaving these tests nothing to prove.
 *
 * Skipping there beats a dozen permanently red tests that say nothing about the
 * code. A suite that is always red is a suite nobody reads, which is how a real
 * failing assertion sat on `main` unnoticed.
 */
/**
 * Asks whether the module can actually be loaded, rather than consulting
 * `module.builtinModules` — that list still omits `sqlite` on a 22.12 runtime
 * started with `--experimental-sqlite`, where `import("node:sqlite")` succeeds,
 * and would skip these tests on a runtime perfectly able to run them.
 */
export const HAS_NODE_SQLITE = process.getBuiltinModule("node:sqlite") !== undefined;

export const SKIP_WITHOUT_NODE_SQLITE = !HAS_NODE_SQLITE;

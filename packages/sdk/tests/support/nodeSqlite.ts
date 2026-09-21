/**
 * Whether the SQLite-backed store's tests can run on this runtime.
 *
 * `node:sqlite` landed in Node 22.5 behind `--experimental-sqlite` and became
 * available unflagged in 22.13. CI and the pinned toolchain are both well past
 * that, so these tests run for real everywhere they matter; the SDK's declared
 * `engines.node` floor is lower, and on such a runtime the store degrades
 * honestly by throwing `UnsupportedFeatureError`, leaving the tests nothing to
 * prove. Skipping there beats permanently red tests that say nothing about the
 * code — an always-red suite is one nobody reads.
 *
 * Asks whether the module actually loads rather than consulting
 * `module.builtinModules`, which still omits `sqlite` on a runtime started with
 * `--experimental-sqlite` where `import("node:sqlite")` succeeds.
 */
export const SKIP_WITHOUT_NODE_SQLITE = process.getBuiltinModule("node:sqlite") === undefined;

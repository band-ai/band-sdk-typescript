import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { LIVE_REPORT_ENV, laneProblems, liveCounts, liveRunSchema } from "./support/liveRunReport";
import { matrixProblems, matrixSchema } from "./support/liveRunReport";
import { projectLiveRun } from "./baseline/toolkit/scorecardReporter";
import { SCORECARD_JSON_ENV } from "./baseline/toolkit/scorecard";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const reporter = fileURLToPath(new URL("./support/liveRunReporter.ts", import.meta.url));
const sdkModules = fileURLToPath(new URL("../node_modules", import.meta.url));

async function fixture(files: Record<string, string>, options: { reporters?: Array<string | [string, { lane: string }]>; retry?: number; repeats?: number } = {}, args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "band-live-reporter-"));
  try {
    await symlink(sdkModules, join(directory, "node_modules"), "dir");
    await Promise.all(Object.entries(files).map(([file, source]) => writeFile(join(directory, file), source)));
    const config = join(directory, "vitest.config.mjs");
    const configuredReporters = options.reporters?.map((entry) => typeof entry === "string" && entry.startsWith("./") ? join(directory, entry) : entry);
    await writeFile(config, `export default ${JSON.stringify({ test: { root: directory, include: ["*.test.ts"], ...options, reporters: configuredReporters ?? [[reporter, { lane: "plugin" }]] } })};`);
    const report = join(directory, "report.json");
    const matrixPath = join(directory, "matrix.json");
    const child = spawn(process.execPath, [cli, "run", "--config", config, "--no-color", ...args], { env: { ...process.env, [LIVE_REPORT_ENV]: report, [SCORECARD_JSON_ENV]: matrixPath }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    let contents;
    try { contents = JSON.parse(await readFile(report, "utf8")); }
    catch { throw new Error(`fixture did not write evidence: ${output}`); }
    let matrix;
    try { matrix = matrixSchema.parse(JSON.parse(await readFile(matrixPath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { code, run: liveRunSchema.parse(contents), matrix };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("live reporter at the pinned Vitest process boundary", () => {
  it("preserves an interrupted run's end reason", async () => {
    const { run } = await fixture({
      "interrupted.test.ts": `import {it} from 'vitest';it('interrupted',async()=>{await new Promise(r=>setTimeout(r,20))});`,
      "cancel.mjs": `export default class {onInit(ctx){this.ctx=ctx} onTestCaseReady(){void this.ctx.cancelCurrentRun('keyboard-input')}}`,
    }, { reporters: [[reporter, { lane: "plugin" }], "./cancel.mjs"] });
    expect(run.reason).toBe("interrupted");
    expect(laneProblems(run)).toContain("run ended interrupted");
  });

  it("reuses the real SDK selected-test projection, including shared casts and filters", async () => {
    const scorecardReporter = fileURLToPath(new URL("./baseline/toolkit/scorecardReporter.ts", import.meta.url));
    const { run, matrix } = await fixture({ "projection.test.ts": `import {describe,it} from 'vitest'; describe('behavior.shared',()=>{it('anthropic + google-adk',()=>{});it('gemini',()=>{});}); describe('behavior.pending',()=>{it('codex',ctx=>ctx.skip('prerequisite missing'))});` }, {
      reporters: [[reporter, { lane: "sdk" }], scorecardReporter],
    }, ["-t", "anthropic|codex"]);
    expect(matrix).toHaveLength(3);
    if (!matrix) throw new Error("SDK fixture did not write the matrix");
    expect(matrixProblems(matrix, projectLiveRun(run))).toEqual([]);
    expect(liveCounts(run)).toEqual({ passed: 1, failed: 0, excluded: 1, filtered: 1, pending: 0 });
  });

  it("distinguishes passing, excluded and filtered tests", async () => {
    const { code, run } = await fixture({ "states.test.ts": `import {it} from 'vitest'; it('selected',()=>{}); it('filtered',()=>{}); it.skip('selected exclusion',()=>{});` }, {}, ["-t", "selected"]);
    expect(code).toBe(0);
    expect(liveCounts(run)).toEqual({ passed: 1, failed: 0, excluded: 1, filtered: 1, pending: 0 });
    expect(laneProblems(run)).toEqual([]);
  });

  it("records assertion, import, suite-hook and unhandled errors without losing passing tests", async () => {
    const { code, run } = await fixture({
      "assert.test.ts": `import {it} from 'vitest'; it('assertion',()=>{throw new Error('assertion boundary')});`,
      "import.test.ts": `throw new Error('import boundary');`,
      "hook.test.ts": `import {describe,it,afterAll} from 'vitest'; describe('suite hook',()=>{it('passed',()=>{}); afterAll(()=>{throw new Error('suite boundary')});});`,
      "unhandled.test.ts": `import {it} from 'vitest'; it('passed despite rejection',async()=>{Promise.reject(new Error('unhandled boundary')); await new Promise(r=>setTimeout(r,20));});`,
    });
    expect(code).toBe(1);
    expect(run.modules.find((module) => module.file.endsWith("import.test.ts"))?.errors.map((error) => error.message)).toContain("import boundary");
    expect(run.modules.flatMap((module) => module.suites).flatMap((suite) => suite.errors.map((error) => error.message))).toContain("suite boundary");
    expect(run.unhandledErrors.map((error) => error.message)).toContain("unhandled boundary");
    expect(liveCounts(run).passed).toBe(2);
    expect(laneProblems(run).join("\n")).toContain("assertion boundary");
    expect(run.reason).toBe("failed");
  });

  it("keeps prior errors and rejects a passing retry", async () => {
    const { code, run } = await fixture({ "retry.test.ts": `import {it} from 'vitest'; let n=0; it('rescued',()=>{if(!n++) throw new Error('first attempt failed')});` }, { retry: 1 });
    expect(code).toBe(0);
    const test = run.modules[0]?.tests[0];
    expect(test?.state).toBe("passed");
    expect(test?.retryCount).toBe(1);
    expect(test?.flaky).toBe(true);
    expect(test?.errors.map((error) => error.message)).toContain("first attempt failed");
    expect(laneProblems(run).join("\n")).toContain("first-attempt evidence rejected");
  });

  it("rejects repeated runs and runs with no executed tests", async () => {
    const repeated = await fixture({ "repeat.test.ts": `import {it} from 'vitest'; it('repeated',()=>{});` }, { repeats: 1 });
    expect(repeated.code).toBe(0);
    expect(repeated.run.modules[0]?.tests[0]?.repeatCount).toBe(1);
    expect(laneProblems(repeated.run).join("\n")).toContain("first-attempt evidence rejected");
    const excluded = await fixture({ "empty.test.ts": `import {it} from 'vitest'; it.skip('excluded',()=>{});` });
    expect(laneProblems(excluded.run)).toContain("no executed tests");
  });
});

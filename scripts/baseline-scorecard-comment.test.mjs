import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MARKER, ensureReport, postScorecard, renderComment } from "../.github/scripts/post-baseline-scorecard.mjs";
import { assembleReport, validateMetadata } from "../.github/scripts/assemble-live-report.mjs";
import { projectLiveRun } from "../packages/sdk/tests/baseline/toolkit/scorecardReporter.ts";
import { registry } from "../packages/sdk/tests/baseline/toolkit/adapters.ts";
import { AdapterRegistry } from "../packages/sdk/tests/baseline/toolkit/registry.ts";
import { namedWorkflowSteps } from "./workflow-test-utils.mjs";

const REPO = "band-ai/band-sdk-typescript";
const BRANCH = "feat/some-branch";
const SHA = "abc123";
const PR = "255";
const COMMENT_ID = "4242";

/** `gh api` against one repo: an open PR (or none) and its comment list, recording every call. */
function fakeGh({ pr, existingComment }) {
  const calls = [];
  const api = (args) => {
    calls.push(args);
    const [path] = args;
    if (path.includes("/pulls?")) return pr ? `${pr}\n` : "\n";
    if (path.endsWith(`/issues/${pr}/comments`) && args.includes("--paginate")) return existingComment ? `${existingComment}\n` : "";
    return "{}";
  };
  return { api, calls };
}

const writes = (calls) => calls.filter((args) => args.includes("--method")).map((args) => [args[0], args[args.indexOf("--method") + 1]]);

const render = (overrides) =>
  renderComment({ recipients: "@a @b", report: "🟢 **Baseline: PASS** · run [#7](https://run)\nSDK scope: `full suite`\n| grid |\n", ...overrides });

test("the comment carries the marker, verdict, scope, scorecard, and mentions", () => {
  const body = render();
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /🟢 \*\*Baseline: PASS\*\* · run \[#7\]\(https:\/\/run\)/);
  assert.ok(body.includes("| grid |"));
  assert.ok(body.endsWith("cc @a @b"));
});

test("a failed run with no scorecard still reports, and still mentions", () => {
  const body = render({ report: "🔴 **Baseline: FAIL**\nSDK baseline: missing or malformed evidence" });
  assert.match(body, /🔴 \*\*Baseline: FAIL\*\*/);
  assert.match(body, /missing or malformed evidence/);
  assert.ok(body.endsWith("cc @a @b"));
});

const identity = { runId: "37728515952", runNumber: "95", attempt: 1, sha: "5d7f491", runUrl: "https://run" };
const testCase = (name, overrides = {}) => ({
  id: name, name, fullName: `behavior.${name} > ${name}`, parent: { type: "suite", name: `behavior.${name}` },
  state: "passed", mode: "run", filtered: false, durationMs: 1, retryCount: 0, repeatCount: 0, flaky: false, errors: [], ...overrides,
});
const lane = (name, tests) => ({ version: 1, lane: name, reason: "passed", modules: [{ file: "tests/baseline/scenarios/behavior/fixture.test.ts", errors: [], suites: [], tests }], unhandledErrors: [] });
const metadata = (overrides = {}) => ({
  run: { id: Number(identity.runId), run_attempt: identity.attempt, head_sha: identity.sha, status: "completed" },
  jobs: [{ name: "baseline (live)", run_id: Number(identity.runId), head_sha: identity.sha, status: "completed", conclusion: "success", steps: [
    { name: "Run the live baseline", conclusion: "success" },
    { name: "Run the Claude Code plugin live lane", conclusion: "success" },
  ], ...overrides }].map((job) => ({ ...job, steps: job.steps.map((step, index) => ({ number: index + 1, status: "completed", ...step })) })),
});
const evidence = () => {
  const sdk = lane("sdk", [testCase("anthropic", { fullName: "behavior.fixture > anthropic", parent: { type: "suite", name: "behavior.fixture" } })]);
  return { sdk, plugin: lane("plugin", [testCase("plugin passes")]), matrix: projectLiveRun(sdk) };
};

test("red reports sanitize the same evidence before rendering JSON and Markdown", () => {
  const base = evidence();
  base.matrix[0].scenario = "behavior.band_a_fixturesecret";
  const { report, markdown } = assembleReport({ identity, evidence: base, metadata: metadata() });
  assert.equal(report.verdict, "FAIL");
  assert.ok(!JSON.stringify(report).includes("band_a_fixturesecret"));
  assert.ok(!markdown.includes("band_a_fixturesecret"));
});

test("October 8 renders failed plugin tests before green SDK cells, and separates test counts", () => {
  const historicalRoster = new AdapterRegistry(registry.ids().map((id) => ({ ...registry.get(id), ...(id === "openai" ? { pending: "needs an OPENAI_API_KEY provisioned in CI" } : {}) })));
  const sdkTests = Array.from({ length: 147 }, (_, index) => testCase(index === 0 ? "anthropic + google-adk" : "anthropic", {
    id: `pass${index}`, fullName: `behavior.fixture${index} > anthropic`, parent: { type: "suite", name: `behavior.fixture${index}` },
  }));
  for (const [adapter, count] of [["openai", 21], ["codex", 5], ["kiro-acp", 5], ["langgraph", 4], ["vercel-ai-sdk", 4], ["parlant", 4]]) {
    const spec = historicalRoster.get(adapter);
    sdkTests.push(...Array.from({ length: count }, (_, index) => testCase(adapter, {
      id: `${adapter}-excluded${index}`, fullName: `behavior.excluded${index} > ${adapter}`, parent: { type: "suite", name: `behavior.excluded${index}` }, state: "skipped", mode: "skip", note: spec.pending ?? spec.bespokeOnly,
    })));
  }
  const sdk = lane("sdk", sdkTests);
  const plugin = lane("plugin", [testCase("pass1"), testCase("pass2"), testCase("pass3"),
    testCase("connects each session as the agent it selects, and tells a refused one that every agent is taken", { state: "failed", errors: [{ message: "ERR_MODULE_NOT_FOUND: Claude optional peer" }] }),
    testCase("fails a session that selects an agent never saved, and says so in /band:agents", { state: "failed", errors: [{ message: "ERR_MODULE_NOT_FOUND: Claude optional peer" }] }),
  ]);
  plugin.reason = "failed";
  const { report, markdown } = assembleReport({ identity, roster: historicalRoster, evidence: { sdk, plugin, matrix: projectLiveRun(sdk, historicalRoster) }, metadata: metadata({ conclusion: "failure", steps: [
    { name: "Run the live baseline", conclusion: "success" }, { name: "Run the Claude Code plugin live lane", conclusion: "failure" },
  ] }) });
  assert.equal(report.verdict, "FAIL");
  assert.match(markdown, /SDK baseline \| 147 \| 0 \| 43/);
  assert.match(markdown, /Claude Code plugin \| 3 \| 2 \| 0/);
  assert.match(markdown, /148 passing · 0 failing · 43 N\/A/);
  assert.match(markdown, /every agent is taken/);
  assert.match(markdown, /never saved/);
  assert.ok(markdown.indexOf("every agent is taken") < markdown.indexOf("SDK-only scenario"));
  assert.equal(report.groupedExclusions.reduce((count, group) => count + group.count, 0), 43);
  assert.equal(report.groupedExclusions.find((group) => group.adapter === "openai").count, 21);
  assert.equal(report.groupedExclusions.find((group) => group.adapter === "parlant").classification, "scenario incompatibility");
  assert.match(markdown, /Nightly acceptance: INCOMPLETE/);
});

test("first-attempt green requires lane evidence, complete matrix and completed matching metadata", () => {
  const base = evidence();
  assert.equal(assembleReport({ identity, evidence: base, metadata: metadata() }).report.verdict, "PASS");
  for (const bad of [
    { ...base, sdk: undefined }, { ...base, plugin: {} }, { ...base, matrix: [] },
    { ...base, matrix: [{ ...base.matrix[0], outcome: { status: "na" } }] },
    { ...base, matrix: [...base.matrix, base.matrix[0]] },
  ]) assert.equal(assembleReport({ identity, evidence: bad, metadata: metadata() }).report.verdict, "FAIL");
  assert.ok(validateMetadata({ ...metadata(), run: { ...metadata().run, run_attempt: 2 } }, identity).problems.length);
  assert.ok(validateMetadata({ ...metadata(), jobs: [...metadata().jobs, ...metadata().jobs] }, identity).problems.length);
  assert.equal(assembleReport({ identity, evidence: base, metadata: { ...metadata(), run: { ...metadata().run, status: "in_progress" } } }).report.verdict, "PASS");
});

test("assembly CLI saves both red reports before exiting on absent evidence and failed metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "band-report-cli-"));
  try {
    await writeFile(join(directory, "gh"), "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
    const cwd = fileURLToPath(new URL("../packages/sdk", import.meta.url));
    const args = ["--import", "tsx", "../../.github/scripts/assemble-live-report.mjs"];
    const env = { ...process.env, REPORT_DIR: directory, PATH: `${directory}:${process.env.PATH}`, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: identity.sha, GITHUB_RUN_NUMBER: identity.runNumber, GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: "https://github.com" };
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    assert.equal(report.verdict, "FAIL");
    assert.match(markdown, /metadata request failed/);
    assert.match(markdown, /SDK baseline \| unknown/);
    const integrity = spawnSync(process.execPath, [...args, "--validate"], { cwd, env, encoding: "utf8" });
    assert.equal(integrity.status, 1);
    assert.match(integrity.stderr, /missing or malformed evidence/);
    assert.ok(!integrity.stderr.includes("TypeError"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow uploads incomplete evidence and publishes the saved completed-job report after failure", async () => {
  const workflow = await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const [baseline, reporting] = workflow.split(/^  report:$/m);
  const liveSteps = namedWorkflowSteps(baseline);
  const reportSteps = namedWorkflowSteps(reporting);
  const step = (steps, name) => {
    const match = steps.find((candidate) => candidate.name === name);
    assert.ok(match, name);
    return match;
  };
  const validate = step(liveSteps, "Validate live evidence integrity");
  const upload = step(liveSteps, "Upload the scorecard");
  assert.ok(liveSteps.indexOf(validate) < liveSteps.indexOf(upload));
  assert.match(upload.body, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.ok(!upload.body.includes("hashFiles"));
  assert.ok(!baseline.includes("GH_TOKEN:"));
  assert.match(reporting, /actions: read/);
  assert.doesNotMatch(reporting, /^ {6}GH_TOKEN:/m);
  const assemble = step(reportSteps, "Assemble the completed baseline report");
  assert.match(assemble.body, /node --import tsx/);
  const ensure = step(reportSteps, "Ensure a report is available");
  assert.ok(reportSteps.indexOf(ensure) > reportSteps.indexOf(assemble));
  assert.match(ensure.body, /node .* --ensure/);
  assert.match(ensure.body, /toJSON\(steps\)/);
  for (const name of ["Report to the job summary", "Upload the completed report", "Post the baseline report"]) {
    const publication = step(reportSteps, name);
    assert.ok(reportSteps.indexOf(publication) > reportSteps.indexOf(assemble));
    assert.ok(reportSteps.indexOf(publication) > reportSteps.indexOf(ensure));
    assert.match(publication.body, /!cancelled\(\)/);
    assert.ok(!publication.body.includes("success()"));
  }
  assert.match(step(reportSteps, "Read integrations mentions list").body, /GH_TOKEN:/);
  assert.match(step(reportSteps, "Post the baseline report").body, /steps\.mentions\.outcome == 'success'/);
  assert.match(step(reportSteps, "Report to the job summary").body, /cat "\$REPORT_MD"/);
});

test("builtin-only fallback survives missing report dependencies and saves the exact publication body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "band-report-fallback-"));
  try {
    const path = join(directory, "report.md");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../.github/scripts/post-baseline-scorecard.mjs", import.meta.url)), "--ensure"], {
      cwd: directory, encoding: "utf8", env: { REPORT_MD: path, GITHUB_RUN_NUMBER: identity.runNumber, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: identity.sha, GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: "https://github.com", REPORT_STEP_OUTCOMES: JSON.stringify({ install_dependencies: { outcome: "failure" }, assemble_report: { outcome: "failure" } }) },
    });
    assert.equal(result.status, 1, result.stderr);
    const body = await readFile(path, "utf8");
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.counts.sdk, null);
    assert.match(body, /install dependencies: failure/);
    assert.match(body, /SDK baseline \| unknown/);
    assert.ok(renderComment({ report: body, recipients: "@tester" }).includes(body.trimEnd()));
    await ensureReport({ path, identity, outcomes: { assemble_report: { outcome: "failure" } } });
    assert.equal(await readFile(path, "utf8"), body);
    await writeFile(path, "saved authoritative body\n");
    await ensureReport({ path, identity });
    assert.equal(await readFile(path, "utf8"), "saved authoritative body\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("assembly CLI keeps required coverage red after passing executed lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "band-report-coverage-"));
  try {
    const input = evidence();
    input.sdk.modules[0].tests.push(testCase("codex", { fullName: "behavior.coverage > codex", parent: { type: "suite", name: "behavior.coverage" }, state: "skipped", mode: "skip", note: registry.get("codex").pending }));
    input.matrix = projectLiveRun(input.sdk);
    await Promise.all(Object.entries({ "sdk-live.json": input.sdk, "plugin-live.json": input.plugin, "scorecard.json": input.matrix }).map(([file, data]) => writeFile(join(directory, file), JSON.stringify(data))));
    const canonical = metadata();
    canonical.run.status = "in_progress";
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nconst m=${JSON.stringify(canonical)};process.stdout.write(JSON.stringify(process.argv[3].includes('/jobs?')?[{jobs:m.jobs}]:m.run));\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "../../.github/scripts/assemble-live-report.mjs"], {
      cwd: fileURLToPath(new URL("../packages/sdk", import.meta.url)), encoding: "utf8",
      env: { ...process.env, REPORT_DIR: directory, PATH: `${directory}:${process.env.PATH}`, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: identity.sha, GITHUB_RUN_NUMBER: identity.runNumber, GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: "https://github.com" },
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    assert.equal(report.executionVerdict, "PASS");
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.acceptance, "INCOMPLETE");
    assert.ok(report.coverageProblems.some((problem) => problem.includes("Codex CLI authentication")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("one valid cell cannot certify 147 selected tests, including shared casts", () => {
  const sdk = lane("sdk", Array.from({ length: 147 }, (_, index) => testCase("anthropic", {
    id: `test${index}`, fullName: `behavior.fixture${index} > anthropic`, parent: { type: "suite", name: `behavior.fixture${index}` },
  })));
  const partial = { ...evidence(), sdk, matrix: projectLiveRun(sdk).slice(0, 1) };
  const result = assembleReport({ identity, evidence: partial, metadata: metadata() });
  assert.equal(result.report.verdict, "FAIL");
  assert.ok(result.report.problems.some((problem) => problem.includes("missing matrix cell")));
  const shared = lane("sdk", [testCase("anthropic + google-adk", { parent: { type: "suite", name: "behavior.shared" } })]);
  assert.equal(assembleReport({ identity, evidence: { ...evidence(), sdk: shared, matrix: projectLiveRun(shared).slice(0, 1) }, metadata: metadata() }).report.verdict, "FAIL");
  const unmapped = evidence();
  unmapped.sdk.modules[0].tests.push(testCase("disappeared", { fullName: "disappeared", parent: { type: "module" } }));
  assert.ok(assembleReport({ identity, evidence: unmapped, metadata: metadata() }).report.problems.some((problem) => problem.includes("selected test has no projected cell")));
});

test("setup failure names the step, preserves unknown counts, and cannot be hidden by green test JSON", () => {
  const setup = assembleReport({ identity, evidence: {}, metadata: metadata({ conclusion: "failure", steps: [{ name: "Build dependencies", conclusion: "failure" }] }) });
  assert.match(setup.markdown, /Build dependencies: failure/);
  assert.match(setup.markdown, /SDK baseline \| unknown/);
  const contradictory = assembleReport({ identity, evidence: evidence(), metadata: metadata({ conclusion: "failure", steps: [
    { name: "Run the live baseline", conclusion: "failure" }, { name: "Run the Claude Code plugin live lane", conclusion: "success" },
  ] }) });
  assert.equal(contradictory.report.verdict, "FAIL");
  assert.match(contradictory.markdown, /test step failure/);
});

test("scope, retry rescue and multiline credential errors remain explicit", () => {
  const scoped = assembleReport({ identity, evidence: evidence(), metadata: metadata(), filter: "-t anthropic" });
  assert.equal(scoped.report.verdict, "FAIL");
  assert.equal(scoped.report.executionVerdict, "PASS");
  assert.equal(scoped.report.acceptance, "INCOMPLETE");
  assert.match(scoped.markdown, /SDK scope: `-t anthropic` · plugin scope: full live lane/);
  const filteredPlugin = evidence();
  filteredPlugin.plugin.modules[0].tests.push(testCase("plugin filtered", { state: "skipped", mode: "skip", filtered: true }));
  const partialPlugin = assembleReport({ identity, evidence: filteredPlugin, metadata: metadata() });
  assert.equal(partialPlugin.report.executionVerdict, "PASS");
  assert.equal(partialPlugin.report.verdict, "FAIL");
  assert.match(partialPlugin.markdown, /plugin scope: filtered live lane/);
  assert.ok(partialPlugin.report.coverageProblems.some((problem) => problem.includes("plugin: 1 filtered")));
  const recovered = evidence();
  const test = recovered.sdk.modules[0].tests[0];
  Object.assign(test, { retryCount: 1, flaky: true, errors: [{ message: "Command failed: --api-key band_a_abcdefghijklmnopqrstuvwxyz\nprovider token sk-test-abcdefghijklmnopqrstuvwxyz" }] });
  const result = assembleReport({ identity, evidence: recovered, metadata: metadata() });
  assert.equal(result.report.verdict, "FAIL");
  assert.match(result.markdown, /first-attempt evidence rejected/);
  assert.ok(!result.markdown.includes("band_a_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!JSON.stringify(result.report).includes("band_a_abcdefghijklmnopqrstuvwxyz"));
  assert.match(result.markdown, /Command failed/);
});

test("with no open PR it comments on the tested commit", () => {
  const { api, calls } = fakeGh({ pr: undefined });
  postScorecard({ repo: REPO, branch: BRANCH, sha: SHA, body: "b", api });

  assert.deepEqual(writes(calls), [[`repos/${REPO}/commits/${SHA}/comments`, "POST"]]);
});

test("posts a new comment when the PR has none of ours", () => {
  const { api, calls } = fakeGh({ pr: PR });
  postScorecard({ repo: REPO, branch: BRANCH, sha: SHA, body: "b", api });

  assert.deepEqual(writes(calls), [[`repos/${REPO}/issues/${PR}/comments`, "POST"]]);
});

test("updates the marked comment in place on a later run", () => {
  const { api, calls } = fakeGh({ pr: PR, existingComment: COMMENT_ID });
  postScorecard({ repo: REPO, branch: BRANCH, sha: SHA, body: "b", api });

  assert.deepEqual(writes(calls), [[`repos/${REPO}/issues/comments/${COMMENT_ID}`, "PATCH"]]);
});

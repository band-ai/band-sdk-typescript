import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registry } from "../../packages/sdk/tests/baseline/toolkit/adapters.ts";
import { toMarkdown } from "../../packages/sdk/tests/baseline/toolkit/scorecard.ts";
import { projectLiveRun } from "../../packages/sdk/tests/baseline/toolkit/scorecardReporter.ts";
import { LIVE_LANES, liveCounts, validateLiveEvidence, workflowMetadataSchema } from "../../packages/sdk/tests/support/liveRunReport.ts";
import { redactDiagnosticText, redactDiagnostics } from "../../packages/sdk/tests/support/redactDiagnostics.ts";

export const BASELINE_JOB = "baseline (live)";
const display = (value) => redactDiagnosticText(String(value)).replace(/[\\`*|<>]/g, "\\$&").replace(/\r?\n/g, "\n  ");

/** Canonical completed-job metadata also exposes failures before tests and after teardown. */
export function validateMetadata(metadata, identity) {
  const parsed = workflowMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { problems: ["canonical workflow metadata is missing or malformed"], outcomes: {} };
  const { run, jobs } = parsed.data;
  const problems = [];
  // This workflow is still running its report job; the baseline job must be completed.
  if (String(run?.id) !== String(identity.runId) || run?.run_attempt !== Number(identity.attempt) || run?.head_sha !== identity.sha || !["in_progress", "completed"].includes(run?.status)) {
    problems.push("workflow metadata does not match the active run/attempt/SHA");
  }
  const matching = (jobs ?? []).filter((job) => job.name === BASELINE_JOB);
  if (matching.length !== 1) return { problems: [...problems, "expected exactly one baseline job in this attempt"], outcomes: {} };
  const job = matching[0];
  if (String(job.run_id) !== String(identity.runId) || job.head_sha !== identity.sha || job.status !== "completed") problems.push("baseline job identity or completion is invalid");
  if (job.conclusion !== "success") problems.push(`baseline job concluded ${job.conclusion ?? "unknown"}`);
  for (const step of job.steps ?? []) if (["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(step.conclusion)) problems.push(`workflow step ${step.name}: ${step.conclusion}`);
  const outcomes = {};
  for (const [lane, { step }] of Object.entries(LIVE_LANES)) {
    const matches = (job.steps ?? []).filter((candidate) => candidate.name === step);
    if (matches.length !== 1) problems.push(`workflow metadata missing or duplicates ${step}`);
    else if (matches[0].status !== "completed") problems.push(`workflow step ${step} is incomplete`);
    else outcomes[lane] = matches[0].conclusion;
  }
  return { problems, outcomes };
}

export function assembleReport({ evidence, metadata, identity, filter = "", roster = registry }) {
  const canonical = validateMetadata(metadata, identity);
  const validated = validateLiveEvidence(evidence, canonical.outcomes, (run) => projectLiveRun(run, roster));
  const problems = [...canonical.problems, ...validated.problems];
  const exclusions = new Map();
  for (const row of validated.matrix ?? []) {
    if (!["na", "skip"].includes(row.outcome.status)) continue;
    const spec = roster.ids().includes(row.adapter) ? roster.get(row.adapter) : undefined;
    const classification = row.outcome.status === "na" && spec?.bespokeOnly ? "scenario incompatibility" : "required coverage missing";
    const key = JSON.stringify([row.adapter, row.outcome.status, row.outcome.reason, classification]);
    const group = exclusions.get(key) ?? { adapter: row.adapter, status: row.outcome.status, reason: row.outcome.reason, classification, count: 0 };
    group.count++;
    exclusions.set(key, group);
  }
  const groupedExclusions = [...exclusions.values()];
  const counts = Object.fromEntries(Object.entries(LIVE_LANES).map(([lane]) => [lane, validated.lanes[lane] ? liveCounts(validated.lanes[lane]) : null]));
  const matrixCounts = validated.matrix ? Object.fromEntries(["pass", "fail", "na", "skip"].map((status) => [status, validated.matrix.filter((row) => row.outcome.status === status).length])) : null;
  const coverageProblems = [];
  if (filter) coverageProblems.push("SDK run was filtered; plugin lane ran its full scope");
  else if (counts.sdk?.filtered) coverageProblems.push(`SDK run contains ${counts.sdk.filtered} filtered tests`);
  for (const group of groupedExclusions) if (group.classification === "required coverage missing") coverageProblems.push(`${group.adapter}: ${group.count} ${group.status} cells — ${group.reason}`);
  for (const [lane, count] of Object.entries(counts)) if (count?.pending) coverageProblems.push(`${LIVE_LANES[lane].name}: ${count.pending} pending tests`);
  // The plugin has no registry of sanctioned scenario incompatibilities.
  if (counts.plugin?.excluded) coverageProblems.push(`Claude Code plugin: ${counts.plugin.excluded} excluded tests`);
  if (counts.plugin?.filtered) coverageProblems.push(`Claude Code plugin: ${counts.plugin.filtered} filtered tests`);
  const executedPassed = problems.length === 0;
  const complete = executedPassed && coverageProblems.length === 0;
  const report = { version: 1, identity, filter, verdict: complete ? "PASS" : "FAIL", executionVerdict: executedPassed ? "PASS" : "FAIL", acceptance: complete ? "COMPLETE" : "INCOMPLETE", problems, coverageProblems, counts, matrixCounts, groupedExclusions, lanes: validated.lanes, matrix: validated.matrix };
  return { report: redactDiagnostics(report), markdown: renderReport(report) };
}

export function renderReport(report) {
  const { identity, filter, verdict, problems, counts, matrixCounts, groupedExclusions, coverageProblems } = report;
  const lines = [
    `${verdict === "PASS" ? "🟢" : "🔴"} **Baseline: ${verdict}** · run [#${display(identity.runNumber)}](${identity.runUrl}) · attempt ${display(identity.attempt)}`,
    `Commit \`${display(identity.sha)}\` · SDK scope: \`${display(filter || "full suite")}\` · plugin scope: ${counts.plugin?.filtered ? "filtered live lane" : "full live lane"}`,
    `**Executed lanes: ${report.executionVerdict}** · **Nightly acceptance: ${report.acceptance}**`,
    "",
  ];
  if (problems.length) lines.push("**Failures and incomplete evidence**", "", ...[...new Set(problems)].map((problem) => `- ${display(problem)}`), "");
  if (coverageProblems.length) lines.push("**Required acceptance still incomplete**", "", ...coverageProblems.map((problem) => `- ${display(problem)}`), "");
  lines.push("**Executed test results**", "", "| lane | passed | failed | excluded | filtered | pending |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [lane, spec] of Object.entries(LIVE_LANES)) {
    const count = counts[lane];
    lines.push(count ? `| ${spec.name} | ${count.passed} | ${count.failed} | ${count.excluded} | ${count.filtered} | ${count.pending} |` : `| ${spec.name} | unknown | unknown | unknown | unknown | unknown |`);
  }
  lines.push("", "**SDK matrix cells (not test counts)**", "", matrixCounts ? `${matrixCounts.pass} passing · ${matrixCounts.fail} failing · ${matrixCounts.na} N/A · ${matrixCounts.skip} skipped` : "Unknown — required matrix evidence is unavailable.");
  if (groupedExclusions.length) {
    lines.push("", "**Grouped exclusions**", "", "| adapter | status | cells | classification | reason |", "| --- | --- | ---: | --- | --- |");
    for (const group of groupedExclusions) lines.push(`| ${display(group.adapter)} | ${group.status} | ${group.count} | ${group.classification} | ${display(group.reason).replace(/\n/g, "<br>")} |`);
  }
  if (report.matrix) lines.push("", "<details>", "<summary>SDK-only scenario × adapter matrix</summary>", "", toMarkdown(report.matrix, { reasons: false }), "</details>");
  lines.push("", `[Complete evidence and logs](${identity.runUrl}) — \`baseline-scorecard\` contains both lane reports and the SDK matrix; \`baseline-report\` contains this assembled report.`);
  return `${lines.join("\n")}\n`;
}

async function readEvidence(directory) {
  const read = async (file) => {
    try { return JSON.parse(await readFile(resolve(directory, file), "utf8")); }
    catch { return undefined; }
  };
  return { sdk: await read(LIVE_LANES.sdk.file), plugin: await read(LIVE_LANES.plugin.file), matrix: await read("scorecard.json") };
}

function ghJson(endpoint, paginated = false) {
  const result = spawnSync("gh", ["api", endpoint, ...(paginated ? ["--paginate", "--slurp"] : [])], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`GitHub metadata request failed for ${endpoint} (exit ${result.status})`);
  return JSON.parse(result.stdout);
}

async function main() {
  const directory = process.env.REPORT_DIR || "scorecard";
  const evidence = await readEvidence(directory);
  if (process.argv.includes("--validate")) {
    const { problems } = validateLiveEvidence(evidence, { sdk: process.env.SDK_STEP_OUTCOME, plugin: process.env.PLUGIN_STEP_OUTCOME }, projectLiveRun);
    if (problems.length) {
      console.error(problems.map((problem) => redactDiagnosticText(problem)).join("\n"));
      process.exitCode = 1;
    }
    return;
  }
  const identity = {
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    sha: process.env.GITHUB_SHA,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  let metadata = {};
  let metadataError;
  try {
    const endpoint = `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${identity.runId}/attempts/${identity.attempt}`;
    const run = ghJson(endpoint);
    const pages = ghJson(`${endpoint}/jobs?per_page=100`, true);
    metadata = { run, jobs: pages.flatMap((page) => page.jobs) };
  } catch (error) { metadataError = redactDiagnosticText(error.message); }
  const { report, markdown } = assembleReport({ evidence, metadata, identity, filter: process.env.FILTER });
  if (metadataError) report.problems.unshift(metadataError);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(directory, "report.md"), metadataError ? renderReport(report) : markdown);
  if (report.verdict !== "PASS") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

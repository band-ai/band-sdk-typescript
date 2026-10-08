// Reports a baseline run to the people it @mentions; GitHub emails each of
// them. A run whose branch has an open PR keeps one sticky comment there,
// updated in place; any other run (the nightly on main, or a manual run with no
// PR) comments on the tested commit.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Marks the one PR comment each run updates. */
export const MARKER = "<!-- baseline-scorecard-report -->";

export function renderComment({ recipients, report }) {
  return [MARKER, report.trimEnd(), "", `cc ${recipients}`].join("\n");
}

/** Builtin-only recovery when reporting dependencies or assembly failed before saving a body. */
export async function ensureReport({ path, identity, outcomes = {} }) {
  try {
    if ((await readFile(path, "utf8")).trim()) return false;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const failures = Object.entries(outcomes && typeof outcomes === "object" ? outcomes : {})
    .filter(([, step]) => step?.outcome !== "success")
    .map(([name, step]) => `Report step ${name.replaceAll("_", " ")}: ${step?.outcome ?? "unknown"}`);
  const problems = ["Report assembly/setup failed before producing complete evidence.", ...failures];
  const report = { version: 1, identity, verdict: "FAIL", executionVerdict: "UNKNOWN", acceptance: "INCOMPLETE", problems, counts: { sdk: null, plugin: null }, matrix: null };
  const markdown = [
    `🔴 **Baseline: FAIL** · run [#${identity.runNumber}](${identity.runUrl}) · attempt ${identity.attempt}`,
    `Commit \`${identity.sha}\``,
    "**Executed lanes: UNKNOWN** · **Nightly acceptance: INCOMPLETE**",
    "",
    "**Report assembly unavailable**",
    "",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "| lane | passed | failed | excluded | filtered | pending |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    "| SDK baseline | unknown | unknown | unknown | unknown | unknown |",
    "| Claude Code plugin | unknown | unknown | unknown | unknown | unknown |",
    "",
    `[Evidence and setup logs](${identity.runUrl}) — execution counts cannot be verified by this report.`,
    "",
  ].join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(join(dirname(path), "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path, markdown);
  return true;
}

/**
 * Posts the report. `api(args)` runs `gh api` with `args` and returns its
 * stdout.
 */
export function postScorecard({ repo, branch, sha, body, api }) {
  const [owner] = repo.split("/");
  const pr = api([`repos/${repo}/pulls?head=${owner}:${branch}&state=open`, "--jq", ".[0].number // empty"]).trim();
  if (!pr) {
    api([`repos/${repo}/commits/${sha}/comments`, "--method", "POST", "-f", `body=${body}`]);
    return;
  }
  // `--jq` runs once per page, so each page prints its own matches: take the first.
  const [existing] = api([
    `repos/${repo}/issues/${pr}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.body | contains("${MARKER}")) | .id`,
  ])
    .split("\n")
    .filter(Boolean);
  const [endpoint, method] = existing
    ? [`repos/${repo}/issues/comments/${existing}`, "PATCH"]
    : [`repos/${repo}/issues/${pr}/comments`, "POST"];
  api([endpoint, "--method", method, "-f", `body=${body}`]);
}

function ghApi(args) {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`gh api ${args[0]} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

async function main() {
  const { GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA, RECIPIENTS, REPORT_MD } =
    process.env;
  if (process.argv.includes("--ensure")) {
    let outcomes;
    try { outcomes = JSON.parse(process.env.REPORT_STEP_OUTCOMES || "{}"); }
    catch { outcomes = { setup_outcomes_unavailable: { outcome: "unknown" } }; }
    const created = await ensureReport({
      path: REPORT_MD,
      identity: { runNumber: process.env.GITHUB_RUN_NUMBER, runUrl: `${process.env.GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: GITHUB_SHA },
      outcomes,
    });
    if (created) process.exitCode = 1;
    return;
  }
  const body = renderComment({
    recipients: RECIPIENTS,
    report: await readFile(REPORT_MD, "utf8"),
  });
  postScorecard({ repo: GITHUB_REPOSITORY, branch: GITHUB_REF_NAME, sha: GITHUB_SHA, body, api: ghApi });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

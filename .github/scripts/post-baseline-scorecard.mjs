// Reports a baseline run to the people it @mentions; GitHub emails each of
// them. A run whose branch has an open PR keeps one sticky comment there,
// updated in place; any other run (the nightly on main, or a manual run with no
// PR) comments on the tested commit.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Marks the one PR comment each run updates. */
export const MARKER = "<!-- baseline-scorecard-report -->";

const FULL_SUITE = "full suite";

export function renderComment({ recipients, passed, runNumber, runUrl, filter, scorecard }) {
  const verdict = passed ? "🟢 **Baseline: PASS**" : "🔴 **Baseline: FAIL**";
  const details = scorecard
    ? [scorecard, "Failure details are in the run's `baseline-scorecard` artifact."]
    : ["_No scorecard was produced: the run failed before reporting. Open the run for its logs._"];
  return [
    MARKER,
    `${verdict} · run [#${runNumber}](${runUrl}) · \`${filter || FULL_SUITE}\``,
    "",
    ...details,
    "",
    `cc ${recipients}`,
  ].join("\n");
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

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function main() {
  const { GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA, GITHUB_RUN_NUMBER, GITHUB_RUN_ID, GITHUB_SERVER_URL, FILTER, PASSED, RECIPIENTS, SCORECARD_MD } =
    process.env;
  const body = renderComment({
    recipients: RECIPIENTS,
    passed: PASSED === "true",
    runNumber: GITHUB_RUN_NUMBER,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    filter: FILTER,
    scorecard: await readOptional(SCORECARD_MD),
  });
  postScorecard({ repo: GITHUB_REPOSITORY, branch: GITHUB_REF_NAME, sha: GITHUB_SHA, body, api: ghApi });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

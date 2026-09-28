// Posts a manual baseline run's scorecard to the dispatching branch's open PR
// as one sticky comment, updated in place on each run; with no open PR it
// leaves the scorecard in the job summary and says so.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Marks the one comment each run updates. */
export const MARKER = "<!-- baseline-scorecard-report -->";

const FULL_SUITE = "full suite";

export function renderComment({ actor, runNumber, runUrl, filter, scorecard }) {
  return [
    MARKER,
    `@${actor} your baseline run ([#${runNumber}](${runUrl}), \`${filter || FULL_SUITE}\`) finished.`,
    "",
    scorecard,
    "Failure details are in the run's `baseline-scorecard` artifact.",
  ].join("\n");
}

/**
 * Upserts the scorecard comment. `api(args)` runs `gh api` with `args` and
 * returns its stdout; `notice(text)` reports to the job log.
 */
export function postScorecard({ repo, branch, body, api, notice }) {
  const [owner] = repo.split("/");
  const pr = api([`repos/${repo}/pulls?head=${owner}:${branch}&state=open`, "--jq", ".[0].number // empty"]).trim();
  if (!pr) {
    notice(`No open PR for ${branch}: the scorecard is in this run's job summary only.`);
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
  const { GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_ACTOR, GITHUB_RUN_NUMBER, GITHUB_RUN_ID, GITHUB_SERVER_URL, FILTER, SCORECARD_MD } =
    process.env;
  const body = renderComment({
    actor: GITHUB_ACTOR,
    runNumber: GITHUB_RUN_NUMBER,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    filter: FILTER,
    scorecard: await readFile(SCORECARD_MD, "utf8"),
  });
  postScorecard({
    repo: GITHUB_REPOSITORY,
    branch: GITHUB_REF_NAME,
    body,
    api: ghApi,
    notice: (text) => console.log(`::notice::${text}`),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

import assert from "node:assert/strict";
import test from "node:test";

import { MARKER, postScorecard, renderComment } from "../.github/scripts/post-baseline-scorecard.mjs";

const REPO = "band-ai/band-sdk-typescript";
const BRANCH = "feat/some-branch";
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

test("the comment carries the marker, mentions the dispatcher, and names the scope", () => {
  const body = renderComment({ actor: "someone", runNumber: 7, runUrl: "https://run", filter: "", scorecard: "| grid |" });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /@someone your baseline run \(\[#7\]\(https:\/\/run\), `full suite`\) finished\./);
  assert.ok(body.includes("| grid |"));
});

test("with no open PR it only notices, and writes no comment", () => {
  const { api, calls } = fakeGh({ pr: undefined });
  const notices = [];
  postScorecard({ repo: REPO, branch: BRANCH, body: "b", api, notice: (text) => notices.push(text) });

  assert.deepEqual(writes(calls), []);
  assert.deepEqual(notices, [`No open PR for ${BRANCH}: the scorecard is in this run's job summary only.`]);
});

test("posts a new comment when the PR has none of ours", () => {
  const { api, calls } = fakeGh({ pr: PR });
  postScorecard({ repo: REPO, branch: BRANCH, body: "b", api, notice: assert.fail });

  assert.deepEqual(writes(calls), [[`repos/${REPO}/issues/${PR}/comments`, "POST"]]);
});

test("updates the marked comment in place on a later run", () => {
  const { api, calls } = fakeGh({ pr: PR, existingComment: COMMENT_ID });
  postScorecard({ repo: REPO, branch: BRANCH, body: "b", api, notice: assert.fail });

  assert.deepEqual(writes(calls), [[`repos/${REPO}/issues/comments/${COMMENT_ID}`, "PATCH"]]);
});

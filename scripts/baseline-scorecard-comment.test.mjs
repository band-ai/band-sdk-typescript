import assert from "node:assert/strict";
import test from "node:test";

import { MARKER, postScorecard, renderComment } from "../.github/scripts/post-baseline-scorecard.mjs";

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
  renderComment({ recipients: "@a @b", passed: true, runNumber: 7, runUrl: "https://run", filter: "", scorecard: "| grid |", ...overrides });

test("the comment carries the marker, verdict, scope, scorecard, and mentions", () => {
  const body = render();
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /🟢 \*\*Baseline: PASS\*\* · run \[#7\]\(https:\/\/run\) · `full suite`/);
  assert.ok(body.includes("| grid |"));
  assert.ok(body.endsWith("cc @a @b"));
});

test("a failed run with no scorecard still reports, and still mentions", () => {
  const body = render({ passed: false, scorecard: undefined });
  assert.match(body, /🔴 \*\*Baseline: FAIL\*\*/);
  assert.match(body, /No scorecard was produced/);
  assert.ok(body.endsWith("cc @a @b"));
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

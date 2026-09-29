import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ADAPTER } from "./adapters";
import { CATEGORY, scenarioId } from "./registry";
import {
  GENERAL_SCENARIO,
  NO_ADAPTER,
  SCORECARD_JSON_ENV,
  SCORECARD_STATUS,
  markdownPath,
  merge,
  toMarkdown,
  writeScorecard,
  type ScorecardOutcome,
  type ScorecardRow,
} from "./scorecard";

const REPLIES = scenarioId(CATEGORY.platform, "repliesToMention");
const APPROVALS = scenarioId(CATEGORY.behavior, "approvals");

const row = (
  outcome: ScorecardOutcome,
  adapter: ScorecardRow["adapter"] = ADAPTER.anthropic,
  scenario: ScorecardRow["scenario"] = REPLIES,
): ScorecardRow => ({ scenario, adapter, outcome });

/** A failure's detail, which the markdown must never show. */
const FAILURE_DETAIL = "boom";

const pass: ScorecardOutcome = { status: SCORECARD_STATUS.pass, durationMs: 5 };
const fail: ScorecardOutcome = { status: SCORECARD_STATUS.fail, error: FAILURE_DETAIL, durationMs: 5 };
const skip: ScorecardOutcome = { status: SCORECARD_STATUS.skip, reason: "opt-in gate off" };
const na: ScorecardOutcome = { status: SCORECARD_STATUS.na, reason: "needs a server" };

describe("merge", () => {
  it.each([
    { name: "a real outcome beats a skip", cards: [[skip], [pass]], winner: pass },
    { name: "N/A beats a skip", cards: [[na], [skip]], winner: na },
    { name: "pass beats N/A", cards: [[na], [pass]], winner: pass },
    { name: "fail beats pass", cards: [[pass], [fail]], winner: fail },
  ])("$name", ({ cards, winner }) => {
    expect(merge(...cards.map((outcomes) => outcomes.map((outcome) => row(outcome))))).toEqual([row(winner)]);
  });

  it("keeps the first of two equal outcomes", () => {
    const first: ScorecardOutcome = { ...fail, error: "first" };
    expect(merge([row(first)], [row({ ...fail, error: "second" })])).toEqual([row(first)]);
  });

  it("keeps every distinct cell, in stable order", () => {
    expect(merge([row(pass, ADAPTER.gemini)], [row(fail, ADAPTER.anthropic)]).map((cell) => cell.adapter)).toEqual([
      ADAPTER.anthropic,
      ADAPTER.gemini,
    ]);
  });
});

describe("toMarkdown", () => {
  it("pivots scenario × adapter and lists reasons, never failure details", () => {
    const markdown = toMarkdown([
      row(pass, ADAPTER.anthropic),
      row(fail, ADAPTER.gemini),
      row(na, ADAPTER.letta),
      { scenario: APPROVALS, adapter: ADAPTER.opencode, outcome: skip },
    ]);

    expect(markdown).toBe(
      [
        "| scenario | anthropic | gemini | letta | opencode |",
        "| --- | --- | --- | --- | --- |",
        "| behavior.approvals | · | · | · | ⏭️ |",
        "| platform.repliesToMention | ✅ | ❌ | N/A | · |",
        "",
        "**N/A and skip reasons**",
        "",
        "- `behavior.approvals` / `opencode` — ⏭️ opt-in gate off",
        "- `platform.repliesToMention` / `letta` — N/A needs a server",
        "",
      ].join("\n"),
    );
    expect(markdown).not.toContain(FAILURE_DETAIL);
  });

  it("puts (no adapter) in the first column and (general) in the first row", () => {
    expect(toMarkdown([row(pass, ADAPTER.anthropic), row(fail, NO_ADAPTER), row(fail, NO_ADAPTER, GENERAL_SCENARIO)])).toBe(
      [
        "| scenario | (no adapter) | anthropic |",
        "| --- | --- | --- |",
        "| (general) | ❌ | · |",
        "| platform.repliesToMention | ❌ | ✅ |",
        "",
      ].join("\n"),
    );
  });
});

describe("writeScorecard", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing when the variable is unset", () => {
    expect(writeScorecard([row(pass)], {})).toBeNull();
  });

  it("writes the JSON and its markdown grid when the variable is set", () => {
    dir = mkdtempSync(join(tmpdir(), "scorecard-"));
    const path = join(dir, "out", "scorecard.json");

    expect(writeScorecard([row(pass)], { [SCORECARD_JSON_ENV]: path })).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([row(pass)]);
    expect(readFileSync(markdownPath(path), "utf8")).toBe(toMarkdown([row(pass)]));
  });
});

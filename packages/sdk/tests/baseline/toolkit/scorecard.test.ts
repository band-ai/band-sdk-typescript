import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SCORECARD_JSON_ENV, merge, toMarkdown, writeScorecard, type ScorecardOutcome, type ScorecardRow } from "./scorecard";

const row = (outcome: ScorecardOutcome, adapter: ScorecardRow["adapter"] = "anthropic"): ScorecardRow => ({
  scenario: "platform.repliesToMention",
  adapter,
  outcome,
});

const pass: ScorecardOutcome = { status: "pass", durationMs: 5 };
const fail: ScorecardOutcome = { status: "fail", error: "boom", durationMs: 5 };
const skip: ScorecardOutcome = { status: "skip", reason: "opt-in gate off" };
const na: ScorecardOutcome = { status: "na", reason: "needs a server" };

describe("merge", () => {
  it.each([
    { name: "a real outcome beats a skip", cards: [[skip], [pass]], winner: pass },
    { name: "N/A beats a skip", cards: [[na], [skip]], winner: na },
    { name: "pass beats N/A", cards: [[na], [pass]], winner: pass },
    { name: "fail beats pass", cards: [[pass], [fail]], winner: fail },
  ])("$name", ({ cards, winner }) => {
    expect(merge(...cards.map((outcomes) => outcomes.map((outcome) => row(outcome))))).toEqual([row(winner)]);
  });

  it("keeps every distinct cell, in stable order", () => {
    expect(merge([row(pass, "gemini")], [row(fail, "anthropic")]).map((cell) => cell.adapter)).toEqual(["anthropic", "gemini"]);
  });
});

describe("toMarkdown", () => {
  it("pivots scenario × adapter and lists reasons, never failure details", () => {
    const markdown = toMarkdown([
      row(pass, "anthropic"),
      row(fail, "gemini"),
      row(na, "letta"),
      { scenario: "behavior.approvals", adapter: "opencode", outcome: skip },
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
    expect(markdown).not.toContain("boom");
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
    expect(readFileSync(join(dir, "out", "scorecard.md"), "utf8")).toBe(toMarkdown([row(pass)]));
  });
});

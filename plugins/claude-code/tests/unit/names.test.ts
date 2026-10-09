import { describe, expect, it } from "vitest";

import { CANDIDATE_LIST_LIMIT, listCandidates, resolveName, type Candidate } from "../../src/names";

const QA_WEB: Candidate = { id: "agent-3", name: "Web tester", type: "Agent", handle: "owner/web-bot", description: "QA for the web app" };
const QA_MOBILE: Candidate = { id: "agent-4", name: "Mobile tester", type: "Agent", handle: "owner/mobile-bot", description: "QA for the mobile app" };
const DANA: Candidate = { id: "user-1", name: "Dana", type: "User", handle: "dana", description: "Runs QA for payments" };
const POOL = [QA_WEB, QA_MOBILE, DANA];

describe("resolveName", () => {
  it.each([
    ["an exact id", "agent-4", { kind: "match", candidate: QA_MOBILE }],
    ["a handle with @@, in another case", "@@OWNER/Web-Bot", { kind: "match", candidate: QA_WEB }],
    ["one word of an agent's description", "web", { kind: "match", candidate: QA_WEB }],
    ["two words narrowing to one", "mobile qa", { kind: "match", candidate: QA_MOBILE }],
    ["a word only in a human's description", "payments", { kind: "unknown" }],
    ["a word several match", "qa", { kind: "ambiguous", candidates: [QA_WEB, QA_MOBILE] }],
    ["a word nobody matches", "docs", { kind: "unknown" }],
  ])("resolves %s", (_case, entry, expected) => {
    expect(resolveName(entry, POOL)).toEqual(expected);
  });

  it(`lists at most ${CANDIDATE_LIST_LIMIT} candidates, then how many more`, () => {
    const many = Array.from({ length: CANDIDATE_LIST_LIMIT + 3 }, (_, n): Candidate => ({ id: `agent-${n}`, name: `qa ${n}`, type: "Agent", handle: `qa-${n}` }));

    const lines = listCandidates(many).split("\n");

    expect(lines).toHaveLength(CANDIDATE_LIST_LIMIT + 1);
    expect(lines.at(-1)).toBe("and 3 more");
  });
});

import { describe, expect, it } from "vitest";

import { OPENCODE_DECISION_MESSAGES } from "../src/adapters/opencode/messages";
import {
  ASK_KIND,
  REPLY_ACTION,
  routeReply,
  type DecisionKind,
  type ReplyAction,
  RoomDecisions,
} from "../src/adapters/opencode/replies";

interface RoomSetup {
  permissions?: string[];
  questions?: Array<{ id: string; count?: number }>;
  resolved?: Record<string, DecisionKind>;
  // Asks whose reply is already in flight.
  claimed?: string[];
}

/** A room's pending asks, registered the way the adapter registers them. */
function room({ permissions = [], questions = [], resolved = {}, claimed = [] }: RoomSetup): RoomDecisions {
  const decisions = new RoomDecisions();
  const permission = (requestId: string) => decisions.registerPermission({ requestId, sessionId: "ses_1", permission: "bash", patterns: [] });
  const question = (id: string, count = 1) =>
    decisions.registerQuestion({ requestId: id, questions: Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?` })) });
  // A resolved ask was registered once and is gone.
  for (const [id, kind] of Object.entries(resolved)) {
    if (kind === ASK_KIND.permission) {
      decisions.permissions.withdraw(permission(id)!.entry);
    } else {
      decisions.questions.withdraw(question(id)!.entry);
    }
  }
  permissions.forEach((requestId) => permission(requestId));
  questions.forEach(({ id, count }) => question(id, count));
  for (const id of claimed) {
    if (!decisions.permissions.tryClaim(id)) {
      decisions.questions.tryClaim(id);
    }
  }
  return decisions;
}

const notice = (text: string): ReplyAction => ({ kind: REPLY_ACTION.notice, text });
const PASS: ReplyAction = { kind: REPLY_ACTION.pass };

interface Row {
  scenario: string;
  reply: string;
  setup: RoomSetup;
  action: ReplyAction;
  /** A deliberate departure from the Python adapter. */
  departsFromPython?: true;
}

describe("routeReply", () => {
  it.each<Row>([
    {
      scenario: "names a mixed-case id exactly as OpenCode issued it",
      reply: "Always PerM-Mixed",
      setup: { permissions: ["PerM-Mixed"] },
      action: { kind: REPLY_ACTION.permission, id: "PerM-Mixed", reply: "always" },
    },
    {
      scenario: "says please instead of an id",
      reply: "approve please",
      setup: { permissions: ["perm-a"] },
      action: { kind: REPLY_ACTION.permission, id: "perm-a", reply: "once" },
    },
    {
      scenario: "is only a mention while a question waits",
      reply: "@agent",
      setup: { questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.waitingForAnswers()),
    },
    {
      scenario: "answers a question with text that starts with a reply word",
      reply: "@agent approve with spaces",
      setup: { questions: [{ id: "q-1" }] },
      action: { kind: REPLY_ACTION.answerQuestion, id: "q-1", answers: [["approve with spaces"]] },
    },
    {
      scenario: "answers the oldest question, keeping an @handle the answer begins with",
      reply: "@agent @alice should review",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }] },
      action: { kind: REPLY_ACTION.answerQuestion, id: "q-1", answers: [["@alice should review"]] },
    },
    {
      scenario: "answers a multi-question ask line by line",
      reply: "@agent first\nsecond",
      setup: { questions: [{ id: "q-1", count: 2 }] },
      action: { kind: REPLY_ACTION.answerQuestion, id: "q-1", answers: [["first"], ["second"]] },
    },
    {
      scenario: "rejects an id shared by a permission and a question",
      reply: "reject shared-id",
      setup: { permissions: ["shared-id"], questions: [{ id: "shared-id" }] },
      action: { kind: REPLY_ACTION.rejectQuestion, id: "shared-id" },
    },
    {
      scenario: "rejects a question by id while a different permission waits",
      reply: "reject q-1",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }] },
      action: { kind: REPLY_ACTION.rejectQuestion, id: "q-1" },
    },
    {
      scenario: "names a never-asked id while a permission waits",
      reply: "approve stale",
      setup: { permissions: ["perm-a"] },
      action: notice(OPENCODE_DECISION_MESSAGES.noLongerPending(ASK_KIND.permission, "stale")),
    },
    {
      scenario: "names a never-asked id with nothing pending",
      reply: "reject never-asked",
      setup: {},
      action: PASS,
    },
    {
      scenario: "names no permission while the other of two is claimed",
      reply: "always",
      setup: { permissions: ["perm-a", "perm-b"], claimed: ["perm-a"] },
      action: { kind: REPLY_ACTION.permission, id: "perm-b", reply: "always" },
    },
    {
      scenario: "names a claimed permission, which only its claimant may resolve",
      reply: "approve perm-a",
      setup: { permissions: ["perm-a"], claimed: ["perm-a"] },
      action: { kind: REPLY_ACTION.permission, id: "perm-a", reply: "once" },
    },
    {
      scenario: "rejects with no id while the only permission is claimed and a question waits",
      reply: "reject",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }], claimed: ["perm-a"] },
      action: { kind: REPLY_ACTION.rejectQuestion, id: "q-1" },
    },
    {
      scenario: "answers while the oldest question is claimed",
      reply: "@agent the second approach",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }], claimed: ["q-1"] },
      action: { kind: REPLY_ACTION.answerQuestion, id: "q-2", answers: [["the second approach"]] },
    },
    {
      scenario: "approves with no id, hinting only at unclaimed questions",
      reply: "approve",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }], claimed: ["q-1"] },
      action: notice(OPENCODE_DECISION_MESSAGES.questionHint(["q-2"])),
    },
    {
      scenario: "sends free text while the only question is claimed",
      reply: "@agent something else",
      setup: { questions: [{ id: "q-1" }], claimed: ["q-1"] },
      action: PASS,
    },
    {
      scenario: "approves a question id while a permission waits, hinting at the question grammar",
      reply: "approve q-1",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.questionHint(["q-1"])),
      departsFromPython: true,
    },
    {
      scenario: "politely rejects with only questions waiting, rejecting the oldest",
      reply: "reject please",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }] },
      action: { kind: REPLY_ACTION.rejectQuestion, id: "q-1" },
      departsFromPython: true,
    },
    {
      scenario: "is free text with only permissions waiting, left for the model",
      reply: "@agent go ahead",
      setup: { permissions: ["perm-a"] },
      action: PASS,
      departsFromPython: true,
    },
  ])("when a reply $scenario", ({ reply, setup, action }) => {
    expect(routeReply(reply, room(setup))).toEqual(action);
  });
});

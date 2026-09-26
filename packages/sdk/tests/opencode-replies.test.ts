import { describe, expect, it } from "vitest";

import { DecisionRegistry } from "../src/adapters/shared/decisions";
import { OPENCODE_DECISION_MESSAGES } from "../src/adapters/opencode/messages";
import {
  routeReply,
  type DecisionKind,
  type PendingPermission,
  type PendingQuestion,
  type ReplyAction,
  type RoomDecisions,
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
  const decisions: RoomDecisions = {
    permissions: new DecisionRegistry<PendingPermission>(),
    questions: new DecisionRegistry<PendingQuestion>(),
    knownIds: new Map(Object.entries(resolved)),
  };
  for (const requestId of permissions) {
    decisions.permissions.registerKeyed({ requestId, permission: "bash", patterns: [] }, { key: requestId });
    decisions.knownIds.set(requestId, "permission");
  }
  for (const { id, count = 1 } of questions) {
    const asked = Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?` }));
    decisions.questions.registerKeyed({ requestId: id, questions: asked }, { key: id });
    decisions.knownIds.set(id, "question");
  }
  for (const id of claimed) {
    if (!decisions.permissions.tryClaim(id)) {
      decisions.questions.tryClaim(id);
    }
  }
  return decisions;
}

const notice = (text: string): ReplyAction => ({ kind: "notice", text });
const PASS: ReplyAction = { kind: "pass" };

describe("routeReply", () => {
  it.each<{ scenario: string; reply: string; setup: RoomSetup; action: ReplyAction }>([
    {
      scenario: "names one of two pending permissions",
      reply: "approve perm-b",
      setup: { permissions: ["perm-a", "perm-b"] },
      action: { kind: "permission", id: "perm-b", reply: "once" },
    },
    {
      scenario: "names no permission while two are pending",
      reply: "approve",
      setup: { permissions: ["perm-a", "perm-b"] },
      action: notice(OPENCODE_DECISION_MESSAGES.whichPermissionHint(["perm-a", "perm-b"])),
    },
    {
      scenario: "names a mixed-case id exactly as OpenCode issued it",
      reply: "Always PerM-Mixed",
      setup: { permissions: ["PerM-Mixed"] },
      action: { kind: "permission", id: "PerM-Mixed", reply: "always" },
    },
    {
      scenario: "follows the platform's leading mention block",
      reply: "@[[agent-uuid]] @owner/agent /reject perm-a",
      setup: { permissions: ["perm-a"] },
      action: { kind: "permission", id: "perm-a", reply: "reject" },
    },
    {
      scenario: "says please instead of an id",
      reply: "approve please",
      setup: { permissions: ["perm-a"] },
      action: { kind: "permission", id: "perm-a", reply: "once" },
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
      action: { kind: "answer-question", id: "q-1", answers: [["approve with spaces"]] },
    },
    {
      scenario: "answers the oldest question, keeping an @handle the answer begins with",
      reply: "@agent @alice should review",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }] },
      action: { kind: "answer-question", id: "q-1", answers: [["@alice should review"]] },
    },
    {
      scenario: "answers a multi-question ask line by line",
      reply: "@agent first\nsecond",
      setup: { questions: [{ id: "q-1", count: 2 }] },
      action: { kind: "answer-question", id: "q-1", answers: [["first"], ["second"]] },
    },
    {
      scenario: "rejects an id shared by a permission and a question",
      reply: "reject shared-id",
      setup: { permissions: ["shared-id"], questions: [{ id: "shared-id" }] },
      action: { kind: "reject-question", id: "shared-id" },
    },
    {
      scenario: "rejects a question by id while a different permission waits",
      reply: "reject q-1",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }] },
      action: { kind: "reject-question", id: "q-1" },
    },
    {
      scenario: "approves a question id",
      reply: "approve q-1",
      setup: { questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.questionHint(["q-1"])),
    },
    {
      scenario: "approves with no id while only a question waits",
      reply: "approve",
      setup: { questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.questionHint(["q-1"])),
    },
    {
      scenario: "names an already-resolved permission",
      reply: "approve perm-old",
      setup: { resolved: { "perm-old": "permission" } },
      action: notice(OPENCODE_DECISION_MESSAGES.noLongerPending("permission", "perm-old")),
    },
    {
      scenario: "names an already-resolved question",
      reply: "reject q-old",
      setup: { resolved: { "q-old": "question" } },
      action: notice(OPENCODE_DECISION_MESSAGES.noLongerPending("question", "q-old")),
    },
    {
      scenario: "names a never-asked id while a permission waits",
      reply: "approve stale",
      setup: { permissions: ["perm-a"] },
      action: notice(OPENCODE_DECISION_MESSAGES.noLongerPending("permission", "stale")),
    },
    {
      scenario: "names a never-asked id with nothing pending",
      reply: "reject never-asked",
      setup: {},
      action: PASS,
    },
    {
      scenario: "rejects with no id while both a permission and a question wait",
      reply: "reject",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.dualRejectHint(["perm-a"], ["q-1"])),
    },
    {
      scenario: "names no permission while the other of two is claimed",
      reply: "always",
      setup: { permissions: ["perm-a", "perm-b"], claimed: ["perm-a"] },
      action: { kind: "permission", id: "perm-b", reply: "always" },
    },
    {
      scenario: "names a claimed permission, which only its claimant may resolve",
      reply: "approve perm-a",
      setup: { permissions: ["perm-a"], claimed: ["perm-a"] },
      action: { kind: "permission", id: "perm-a", reply: "once" },
    },
    {
      scenario: "rejects with no id while the only permission is claimed and a question waits",
      reply: "reject",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }], claimed: ["perm-a"] },
      action: { kind: "reject-question", id: "q-1" },
    },
    {
      scenario: "answers while the oldest question is claimed",
      reply: "@agent the second approach",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }], claimed: ["q-1"] },
      action: { kind: "answer-question", id: "q-2", answers: [["the second approach"]] },
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
      scenario: "sends a reply word with nothing pending",
      reply: "approve",
      setup: {},
      action: PASS,
    },
  ])("when a reply $scenario", ({ reply, setup, action }) => {
    expect(routeReply(reply, room(setup))).toEqual(action);
  });

  // Deliberate departures from the Python adapter.
  it.each<{ scenario: string; reply: string; setup: RoomSetup; action: ReplyAction }>([
    {
      scenario: "approving a question id while a permission waits hints at the question grammar",
      reply: "approve q-1",
      setup: { permissions: ["perm-a"], questions: [{ id: "q-1" }] },
      action: notice(OPENCODE_DECISION_MESSAGES.questionHint(["q-1"])),
    },
    {
      scenario: "a polite reject with only questions waiting rejects the oldest",
      reply: "reject please",
      setup: { questions: [{ id: "q-1" }, { id: "q-2" }] },
      action: { kind: "reject-question", id: "q-1" },
    },
    {
      scenario: "free text with only permissions waiting is left for the model",
      reply: "@agent go ahead",
      setup: { permissions: ["perm-a"] },
      action: PASS,
    },
  ])("$scenario", ({ reply, setup, action }) => {
    expect(routeReply(reply, room(setup))).toEqual(action);
  });
});

import { stripLeadingMentions } from "../../runtime/formatters";
import type { DecisionRegistry } from "../shared/decisions";
import { OPENCODE_DECISION_MESSAGES } from "./messages";

export type OpencodeApprovalReply = "once" | "always" | "reject";

/** The room words that answer an ask, and the OpenCode reply each one sends. */
export const REPLY_WORDS = {
  approve: "once",
  always: "always",
  reject: "reject",
} as const satisfies Record<string, OpencodeApprovalReply>;

export type ReplyWord = keyof typeof REPLY_WORDS;

export type DecisionKind = "permission" | "question";

export interface PendingPermission {
  requestId: string;
  permission: string;
  patterns: string[];
}

export interface PendingQuestion {
  requestId: string;
  questions: Array<Record<string, unknown>>;
}

export interface RoomDecisions {
  permissions: DecisionRegistry<PendingPermission>;
  questions: DecisionRegistry<PendingQuestion>;
  // Every id ever asked, so a reply naming a resolved one gets feedback; survives turn cleanup.
  knownIds: Map<string, DecisionKind>;
}

export type ReplyAction =
  | { kind: "permission"; id: string; reply: OpencodeApprovalReply }
  | { kind: "reject-question"; id: string }
  | { kind: "answer-question"; id: string; answers: string[][] }
  | { kind: "notice"; text: string }
  | { kind: "pass" };

const PASS: ReplyAction = { kind: "pass" };

function notice(text: string): ReplyAction {
  return { kind: "notice", text };
}

function isReplyWord(word: string): word is ReplyWord {
  return Object.hasOwn(REPLY_WORDS, word);
}

/** A reply word as the first token, and the id after it (case kept); null id when none or only "please". */
function parseCommand(text: string): { reply: OpencodeApprovalReply; id: string | null } | null {
  const [first = "", ...trailing] = text.trim().split(/\s+/);
  const word = first.replace(/^\//, "").toLowerCase();
  if (!isReplyWord(word)) {
    return null;
  }
  const named = trailing.length > 0 && !trailing.every((token) => token.toLowerCase() === "please");
  return { reply: REPLY_WORDS[word], id: named ? trailing[0] : null };
}

/** One non-empty answer line per question; null when too few arrived. */
function parseQuestionAnswers(text: string, questions: PendingQuestion["questions"]): string[][] | null {
  if (questions.length === 1) {
    const answer = text.trim();
    return answer ? [[answer]] : null;
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < questions.length) {
    return null;
  }
  return lines.slice(0, questions.length).map((line) => [line]);
}

/** What a room reply means for the room's pending asks; the first matching rule wins. */
export function routeReply(raw: string, decisions: RoomDecisions): ReplyAction {
  const command = parseCommand(stripLeadingMentions(raw));
  if (!command) {
    // Free text only ever answers a question; it never approves anything.
    return decisions.questions.size > 0 ? answerOldestQuestion(raw, decisions.questions) : PASS;
  }
  return command.id === null
    ? routeBareCommand(command.reply, decisions)
    : routeNamedCommand(raw, command.reply, command.id, decisions);
}

function routeNamedCommand(
  raw: string,
  reply: OpencodeApprovalReply,
  id: string,
  { permissions, questions, knownIds }: RoomDecisions,
): ReplyAction {
  const rejects = reply === REPLY_WORDS.reject;
  if (rejects && questions.has(id)) {
    return { kind: "reject-question", id };
  }
  if (permissions.has(id)) {
    return { kind: "permission", id, reply };
  }
  if (questions.has(id)) {
    return notice(OPENCODE_DECISION_MESSAGES.questionHint(questions.keys()));
  }
  const knownKind = knownIds.get(id);
  if (knownKind) {
    return notice(OPENCODE_DECISION_MESSAGES.noLongerPending(knownKind, id));
  }
  if (!rejects && questions.size > 0) {
    // An unknown id after "approve"/"always" is just the start of an answer.
    return answerOldestQuestion(raw, questions);
  }
  if (permissions.size > 0 || questions.size > 0) {
    return notice(OPENCODE_DECISION_MESSAGES.noLongerPending(permissions.size > 0 ? "permission" : "question", id));
  }
  return PASS;
}

function routeBareCommand(reply: OpencodeApprovalReply, { permissions, questions }: RoomDecisions): ReplyAction {
  const rejects = reply === REPLY_WORDS.reject;
  if (rejects && permissions.size > 0 && questions.size > 0) {
    return notice(OPENCODE_DECISION_MESSAGES.dualRejectHint(permissions.keys(), questions.keys()));
  }
  if (permissions.size === 1) {
    return { kind: "permission", id: permissions.keys()[0], reply };
  }
  if (permissions.size > 1) {
    return notice(OPENCODE_DECISION_MESSAGES.whichPermissionHint(permissions.keys()));
  }
  if (rejects && questions.size > 0) {
    return { kind: "reject-question", id: questions.keys()[0] };
  }
  if (questions.size > 0) {
    return notice(OPENCODE_DECISION_MESSAGES.questionHint(questions.keys()));
  }
  return PASS;
}

function answerOldestQuestion(raw: string, questions: DecisionRegistry<PendingQuestion>): ReplyAction {
  const id = questions.keys()[0];
  const pending = questions.get(id);
  // Only the delivery mention goes: an answer may itself begin with an @handle.
  const answers = pending && parseQuestionAnswers(stripLeadingMentions(raw, { onlyFirst: true }), pending.questions);
  return answers ? { kind: "answer-question", id, answers } : notice(OPENCODE_DECISION_MESSAGES.waitingForAnswers());
}

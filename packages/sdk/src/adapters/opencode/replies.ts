import { stripLeadingMentions } from "../../runtime/formatters";
import { asOptionalRecord, asString } from "../shared/coercion";
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

export const ASK_KIND = { permission: "permission", question: "question" } as const;

export type DecisionKind = (typeof ASK_KIND)[keyof typeof ASK_KIND];

export interface PendingPermission {
  requestId: string;
  /** The session that asked; its reply goes there whatever the room holds by then. */
  sessionId: string;
  permission: string;
  patterns: string[];
}

export interface PendingQuestion {
  requestId: string;
  questions: Array<Record<string, unknown>>;
}

/** A `permission.asked` event's ask; null without a request id. */
export function toPendingPermission(properties: Record<string, unknown>): PendingPermission | null {
  const requestId = asString(properties.id);
  const sessionId = asString(properties.sessionID);
  if (!requestId || !sessionId) {
    return null;
  }
  return {
    requestId,
    sessionId,
    permission: asString(properties.permission) ?? "unknown",
    patterns: Array.isArray(properties.patterns)
      ? properties.patterns.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/** A `question.asked` event's ask, keeping only well-formed questions; null without a request id. */
export function toPendingQuestion(properties: Record<string, unknown>): PendingQuestion | null {
  const requestId = asString(properties.id);
  if (!requestId) {
    return null;
  }
  const questions = Array.isArray(properties.questions)
    ? properties.questions.filter((value): value is Record<string, unknown> => asOptionalRecord(value) !== undefined)
    : [];
  return { requestId, questions };
}

export interface RoomDecisions {
  permissions: DecisionRegistry<PendingPermission>;
  questions: DecisionRegistry<PendingQuestion>;
  // Every id ever asked, so a reply naming a resolved one gets feedback; survives turn cleanup.
  knownIds: Map<string, DecisionKind>;
}

export const REPLY_ACTION = {
  permission: "permission",
  rejectQuestion: "reject-question",
  answerQuestion: "answer-question",
  notice: "notice",
  pass: "pass",
} as const;

export type ReplyAction =
  | { kind: typeof REPLY_ACTION.permission; id: string; reply: OpencodeApprovalReply }
  | { kind: typeof REPLY_ACTION.rejectQuestion; id: string }
  | { kind: typeof REPLY_ACTION.answerQuestion; id: string; answers: string[][] }
  | { kind: typeof REPLY_ACTION.notice; text: string }
  | { kind: typeof REPLY_ACTION.pass };

/** A reply that resolves an ask, as opposed to one that only earns a notice or passes. */
export type DecisionAction = Exclude<ReplyAction, { kind: typeof REPLY_ACTION.pass } | { kind: typeof REPLY_ACTION.notice }>;

/** Which kinds of ask are still awaiting an answer. */
const OPEN_ASKS = { none: "none", permission: ASK_KIND.permission, question: ASK_KIND.question, both: "both" } as const;

type OpenAsks = (typeof OPEN_ASKS)[keyof typeof OPEN_ASKS];

const PASS: ReplyAction = { kind: REPLY_ACTION.pass };

function notice(text: string): ReplyAction {
  return { kind: REPLY_ACTION.notice, text };
}

function approve(id: string, reply: OpencodeApprovalReply): ReplyAction {
  return { kind: REPLY_ACTION.permission, id, reply };
}

function rejectQuestion(id: string): ReplyAction {
  return { kind: REPLY_ACTION.rejectQuestion, id };
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
    return answerOldestQuestion(raw, decisions.questions) ?? PASS;
  }
  return command.id === null
    ? routeBareCommand(command.reply, decisions)
    : routeNamedCommand(raw, command.reply, command.id, decisions);
}

// A named id is resolved by membership, so a reply to a claimed ask reaches `tryClaim` and loses there quietly.
function routeNamedCommand(raw: string, reply: OpencodeApprovalReply, id: string, decisions: RoomDecisions): ReplyAction {
  const rejects = reply === REPLY_WORDS.reject;
  switch (heldKind(id, rejects, decisions)) {
    case ASK_KIND.permission:
      return approve(id, reply);
    case ASK_KIND.question:
      return rejects ? rejectQuestion(id) : questionHint(decisions.questions);
    case null:
      return routeUnheldId(raw, rejects, id, decisions);
  }
}

// A reject is the one command a question takes by id, so it looks there first.
function heldKind(id: string, rejects: boolean, { permissions, questions }: RoomDecisions): DecisionKind | null {
  if (rejects && questions.has(id)) {
    return ASK_KIND.question;
  }
  return permissions.has(id) ? ASK_KIND.permission : questions.has(id) ? ASK_KIND.question : null;
}

// An id no registry holds: resolved earlier, the start of an answer, or a stale id.
function routeUnheldId(raw: string, rejects: boolean, id: string, decisions: RoomDecisions): ReplyAction {
  const knownKind = decisions.knownIds.get(id);
  if (knownKind) {
    return notice(OPENCODE_DECISION_MESSAGES.noLongerPending(knownKind, id));
  }
  const open = openAsks(decisions);
  if (!rejects && (open === OPEN_ASKS.question || open === OPEN_ASKS.both)) {
    return answerOldestQuestion(raw, decisions.questions) ?? PASS;
  }
  switch (open) {
    case OPEN_ASKS.none:
      return PASS;
    case OPEN_ASKS.question:
      return notice(OPENCODE_DECISION_MESSAGES.noLongerPending(ASK_KIND.question, id));
    default:
      return notice(OPENCODE_DECISION_MESSAGES.noLongerPending(ASK_KIND.permission, id));
  }
}

// Without an id, only asks still awaiting an answer count: one a reply already claimed is not "the" pending ask.
function routeBareCommand(reply: OpencodeApprovalReply, decisions: RoomDecisions): ReplyAction {
  const rejects = reply === REPLY_WORDS.reject;
  switch (openAsks(decisions)) {
    case OPEN_ASKS.none:
      return PASS;
    case OPEN_ASKS.question:
      return rejects ? rejectQuestion(decisions.questions.oldestUnclaimed()!.token) : questionHint(decisions.questions);
    case OPEN_ASKS.both:
      if (rejects) {
        return notice(OPENCODE_DECISION_MESSAGES.dualRejectHint(unclaimedIds(decisions.permissions), unclaimedIds(decisions.questions)));
      }
      return routeBarePermission(reply, decisions.permissions);
    case OPEN_ASKS.permission:
      return routeBarePermission(reply, decisions.permissions);
  }
}

function routeBarePermission(reply: OpencodeApprovalReply, permissions: DecisionRegistry<PendingPermission>): ReplyAction {
  const [only, ...others] = permissions.unclaimed();
  return others.length === 0 ? approve(only.token, reply) : notice(OPENCODE_DECISION_MESSAGES.whichPermissionHint(unclaimedIds(permissions)));
}

function openAsks({ permissions, questions }: RoomDecisions): OpenAsks {
  const permission = permissions.hasUnclaimed();
  const question = questions.hasUnclaimed();
  return permission && question ? OPEN_ASKS.both : permission ? OPEN_ASKS.permission : question ? OPEN_ASKS.question : OPEN_ASKS.none;
}

function questionHint(questions: DecisionRegistry<PendingQuestion>): ReplyAction {
  return notice(OPENCODE_DECISION_MESSAGES.questionHint(unclaimedIds(questions)));
}

/** The answer to the oldest unclaimed question; null when no question awaits one. */
function answerOldestQuestion(raw: string, questions: DecisionRegistry<PendingQuestion>): ReplyAction | null {
  const oldest = questions.oldestUnclaimed();
  if (!oldest) {
    return null;
  }
  // Only the delivery mention goes: an answer may itself begin with an @handle.
  const answers = parseQuestionAnswers(stripLeadingMentions(raw, { onlyFirst: true }), oldest.payload.questions);
  return answers ? { kind: REPLY_ACTION.answerQuestion, id: oldest.token, answers } : notice(OPENCODE_DECISION_MESSAGES.waitingForAnswers());
}

function unclaimedIds<T>(registry: DecisionRegistry<T>): string[] {
  return registry.unclaimed().map((entry) => entry.token);
}

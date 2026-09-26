export const DECISION_KIND = { permission: "permission", question: "question", plan: "plan" } as const;

export type DecisionKind = (typeof DECISION_KIND)[keyof typeof DECISION_KIND];

export const CURSOR_COMMAND = "/cursor";

/** The second word of a `/cursor` room command. */
export const CURSOR_VERB = {
  list: "decisions",
  select: "select",
  deny: "deny",
  answer: "answer",
  accept: "accept",
  reject: "reject",
} as const;

const command = (verb: string, token: string, ...args: string[]) => `\`${[CURSOR_COMMAND, verb, token, ...args].join(" ")}\``;

export const CURSOR_DECISION_MESSAGES = {
  permissionPrompt: (token: string) => `Cursor needs permission. Reply ${command(CURSOR_VERB.select, token, "option-id")} or ${command(CURSOR_VERB.deny, token)}.`,
  questionPrompt: (token: string) => `Cursor needs input. Reply ${command(CURSOR_VERB.answer, token, "question-id=option-id[,option-id]", "...")}.`,
  planPrompt: (title: string, token: string) => `${title} needs approval. Reply ${command(CURSOR_VERB.accept, token)} or ${command(CURSOR_VERB.reject, token)}.`,
  pendingList: (entries: readonly string[]) => `Pending Cursor decisions: ${entries.join(", ") || "none"}`,
  notPending: (token: string) => `Cursor decision \`${token}\` is not pending.`,
  notAuthorized: () => "You are not authorized to resolve Cursor decisions.",
  invalidCommand: (kind: DecisionKind, token: string) => `That command is not valid for Cursor ${kind} decision \`${token}\`.`,
  resolved: (kind: DecisionKind, token: string) => `Cursor ${kind} decision \`${token}\` resolved.`,
  timedOut: (kind: DecisionKind, token: string) => `Cursor ${kind} decision \`${token}\` timed out and was cancelled.`,
  turnInProgress: () => "Cursor is still processing the previous request in this room.",
} as const;

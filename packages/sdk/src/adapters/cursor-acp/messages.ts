export type DecisionKind = "permission" | "question" | "plan";

export const CURSOR_COMMAND = "/cursor";

export const CURSOR_DECISION_MESSAGES = {
  permissionPrompt: (token: string) => `Cursor needs permission. Reply \`${CURSOR_COMMAND} select ${token} option-id\` or \`${CURSOR_COMMAND} deny ${token}\`.`,
  questionPrompt: (token: string) => `Cursor needs input. Reply \`${CURSOR_COMMAND} answer ${token} question-id=option-id[,option-id] ...\`.`,
  planPrompt: (title: string, token: string) => `${title} needs approval. Reply \`${CURSOR_COMMAND} accept ${token}\` or \`${CURSOR_COMMAND} reject ${token}\`.`,
  pendingList: (entries: readonly string[]) => `Pending Cursor decisions: ${entries.join(", ") || "none"}`,
  notPending: (token: string) => `Cursor decision \`${token}\` is not pending.`,
  notAuthorized: () => "You are not authorized to resolve Cursor decisions.",
  invalidCommand: (kind: DecisionKind, token: string) => `That command is not valid for Cursor ${kind} decision \`${token}\`.`,
  resolved: (kind: DecisionKind, token: string) => `Cursor ${kind} decision \`${token}\` resolved.`,
  timedOut: (kind: DecisionKind, token: string) => `Cursor ${kind} decision \`${token}\` timed out and was cancelled.`,
} as const;

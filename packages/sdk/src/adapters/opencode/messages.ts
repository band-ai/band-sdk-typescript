import type { DecisionKind, OpencodeApprovalReply, PendingPermission, ReplyWord } from "./replies";

// Typed against the reply grammar, so a renamed reply word fails to compile here.
function command(word: ReplyWord, argument?: string): string {
  return argument ? `\`${word} ${argument}\`` : `\`${word}\``;
}

function idList(ids: readonly string[]): string {
  return ids.map((id) => `\`${id}\``).join(", ");
}

const DECISION_NOUNS: Record<DecisionKind, string> = { permission: "approval", question: "question" };

export const OPENCODE_DECISION_MESSAGES = {
  approvalRequested: ({ permission, patterns, requestId }: Omit<PendingPermission, "sessionId">) =>
    `OpenCode approval requested for \`${permission}\` (${patterns.join(", ") || "n/a"}). Reply with ${command("approve", requestId)}, ${command("always", requestId)}, or ${command("reject", requestId)}.`,
  approvalHandled: (requestId: string, reply: OpencodeApprovalReply) =>
    `OpenCode approval \`${requestId}\` handled with \`${reply}\`.`,
  approvalTimedOut: (requestId: string, reply: OpencodeApprovalReply) =>
    `OpenCode approval \`${requestId}\` timed out and was handled with \`${reply}\`.`,
  questionRejected: (requestId: string) => `OpenCode question \`${requestId}\` rejected.`,
  questionAnswered: (requestId: string) => `OpenCode question \`${requestId}\` answered.`,
  questionTimedOut: (requestId: string) => `OpenCode question \`${requestId}\` timed out and was rejected.`,
  waitingForAnswers: () =>
    `OpenCode is waiting for answers. Reply with one line per question, or ${command("reject")} to reject the question.`,
  whichPermissionHint: (permissionIds: readonly string[]) =>
    `Several OpenCode approvals are pending (${idList(permissionIds)}). Reply with the request id, e.g. ${command("approve", "<id>")}.`,
  questionHint: (questionIds: readonly string[]) =>
    `OpenCode is waiting for question answers (${idList(questionIds)}). Reply with your answer or ${command("reject", "<id>")} — not ${command("approve")}/${command("always")}.`,
  dualRejectHint: (permissionIds: readonly string[], questionIds: readonly string[]) =>
    `Both an approval and a question are pending (${idList(permissionIds)}; ${idList(questionIds)}). Reply with ${command("reject", "<id>")} naming which ask to reject.`,
  noLongerPending: (kind: DecisionKind, requestId: string) =>
    `OpenCode ${DECISION_NOUNS[kind]} \`${requestId}\` is no longer pending.`,
  notAuthorized: () => "You are not authorized to resolve OpenCode decisions.",
  turnInProgress: () => "OpenCode is still processing the previous request in this room.",
} as const;

export function formatQuestionPrompt(questions: Array<Record<string, unknown>>, requestId: string): string {
  const lines = [`OpenCode asked question \`${requestId}\`:`];
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${String(question.question ?? "Question")}`);
  });
  lines.push(`Reply with one line per question, or ${command("reject")}.`);
  return lines.join("\n");
}

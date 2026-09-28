/**
 * How each approvals-capable adapter asks in the room, is answered, and
 * confirms: its approval dialect. Every adapter registered with the
 * `approvals` capability has one here.
 */
import type { FrameworkAdapter } from "../../../../src/contracts/protocols";
import type { OpencodeApprovalMode } from "../../../../src/adapters/opencode/OpencodeAdapter";
import { OPENCODE_DECISION_MESSAGES } from "../../../../src/adapters/opencode/messages";
import { ASK_KIND, REPLY_WORDS, type ReplyWord } from "../../../../src/adapters/opencode/replies";
import { ADAPTER, buildOpencode, type AdapterId } from "../../toolkit/adapters";
import type { BuildOptions } from "../../toolkit/registry";

export const OUTCOME = { approve: "approve", reject: "reject", timeout: "timeout" } as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/** An outcome a room reply decides; a timeout is the absence of one. */
export type Decision = Exclude<Outcome, typeof OUTCOME.timeout>;

export interface ApprovalDialect {
  /** The adapter in manual approval mode, giving up after `waitMs` with a reject. */
  build(options: BuildOptions, waitMs: number): FrameworkAdapter;
  /** The request id an approval prompt carries, or null for any other message. */
  requestId(content: string): string | null;
  reply(decision: Decision, requestId: string): string;
  /** The adapter's confirmation of an outcome; a timeout's may be an event only a history read sees. */
  notice(outcome: Outcome, requestId: string): string;
  /** What a reply to an ask that is already gone is told. */
  lateNotice(requestId: string): string;
}

/** OpenCode's room words, as its reply grammar defines them. */
const OPENCODE_WORD = Object.fromEntries(Object.keys(REPLY_WORDS).map((word) => [word, word])) as {
  readonly [Word in ReplyWord]: Word;
};

const OPENCODE_DECISION_WORD: Record<Decision, ReplyWord> = {
  [OUTCOME.approve]: OPENCODE_WORD.approve,
  [OUTCOME.reject]: OPENCODE_WORD.reject,
};

const OPENCODE_MANUAL: OpencodeApprovalMode = "manual";
const OPENCODE_TIMEOUT_REPLY = REPLY_WORDS.reject;
/** The prompt names the request in its `approve <id>` command. */
const OPENCODE_REQUEST = new RegExp(`\`${OPENCODE_WORD.approve} (\\S+)\``);

const opencode: ApprovalDialect = {
  build: (options, waitMs) =>
    buildOpencode(options, {
      approvalMode: OPENCODE_MANUAL,
      approvalWaitTimeoutMs: waitMs,
      approvalTimeoutReply: OPENCODE_TIMEOUT_REPLY,
    }),
  requestId: (content) => OPENCODE_REQUEST.exec(content)?.[1] ?? null,
  reply: (decision, requestId) => `${OPENCODE_DECISION_WORD[decision]} ${requestId}`,
  notice: (outcome, requestId) =>
    outcome === OUTCOME.timeout
      ? OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, OPENCODE_TIMEOUT_REPLY)
      : OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, REPLY_WORDS[OPENCODE_DECISION_WORD[outcome]]),
  lateNotice: (requestId) => OPENCODE_DECISION_MESSAGES.noLongerPending(ASK_KIND.permission, requestId),
};

const DIALECTS: Partial<Record<AdapterId, ApprovalDialect>> = { [ADAPTER.opencode]: opencode };

export function dialectFor(id: AdapterId): ApprovalDialect {
  const dialect = DIALECTS[id];
  if (!dialect) {
    throw new Error(`${id} supports approvals but has no approval dialect in samples/approvals.ts`);
  }
  return dialect;
}

/**
 * How each approvals-capable adapter asks in the room, is answered, and
 * confirms: its approval dialect. Every adapter registered with the
 * `approvals` capability has one here.
 */
import type { FrameworkAdapter } from "../../../../src/contracts/protocols";
import { OPENCODE_DECISION_MESSAGES } from "../../../../src/adapters/opencode/messages";
import { buildOpencode } from "../../toolkit/adapters";
import type { AdapterId, BuildOptions } from "../../toolkit/registry";

export type Outcome = "approve" | "reject" | "timeout";

export interface ApprovalDialect {
  /** The adapter in manual approval mode, giving up after `waitMs` with a reject. */
  build(options: BuildOptions, waitMs: number): FrameworkAdapter;
  /** The request id an approval prompt carries, or null for any other message. */
  requestId(content: string): string | null;
  reply(outcome: Exclude<Outcome, "timeout">, requestId: string): string;
  /** The adapter's confirmation of an outcome; a timeout's may be an event only a history read sees. */
  notice(outcome: Outcome, requestId: string): string;
  /** What a reply to an ask that is already gone is told. */
  lateNotice(requestId: string): string;
}

const OPENCODE_REQUEST = /`approve (\S+)`/;

const opencode: ApprovalDialect = {
  build: (options, waitMs) =>
    buildOpencode(options, { approvalMode: "manual", approvalWaitTimeoutMs: waitMs, approvalTimeoutReply: "reject" }),
  requestId: (content) => OPENCODE_REQUEST.exec(content)?.[1] ?? null,
  reply: (outcome, requestId) => `${outcome} ${requestId}`,
  notice: (outcome, requestId) =>
    outcome === "timeout"
      ? OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, "reject")
      : OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, outcome === "approve" ? "once" : "reject"),
  lateNotice: (requestId) => OPENCODE_DECISION_MESSAGES.noLongerPending("permission", requestId),
};

const DIALECTS: Partial<Record<AdapterId, ApprovalDialect>> = { opencode };

export function dialectFor(id: AdapterId): ApprovalDialect {
  const dialect = DIALECTS[id];
  if (!dialect) {
    throw new Error(`${id} supports approvals but has no approval dialect in samples/approvals.ts`);
  }
  return dialect;
}

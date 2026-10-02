/**
 * How each approvals-capable adapter asks in the room, is answered, and
 * confirms: its approval dialect. Every adapter registered with the
 * `approvals` capability has one here.
 */
import { existsSync } from "node:fs";

import { expect } from "vitest";

import type { FrameworkAdapter } from "../../../../src/contracts/protocols";
import type { OpencodeApprovalMode } from "../../../../src/adapters/opencode/OpencodeAdapter";
import { OPENCODE_DECISION_MESSAGES } from "../../../../src/adapters/opencode/messages";
import { ASK_KIND, REPLY_WORDS, type ReplyWord } from "../../../../src/adapters/opencode/replies";
import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { ADAPTER, buildOpencode, type AdapterId } from "../../toolkit/adapters";
import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import type { ScenarioCell } from "../../toolkit/perAdapter";
import type { BuildOptions } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { readText } from "./files";

export const OUTCOME = { approve: "approve", reject: "reject", timeout: "timeout" } as const;

/** An approval wait that outlasts the request and the closing-reply barriers. */
export const PATIENT_WAIT_MS = LIVE_EVENT_TIMEOUT_MS * 2;

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

/** An agent in one of its rooms. */
export type InRoom = Pick<ScenarioCell, "agent" | "room">;

/** An approval prompt the agent posted, and the request id it carries. */
export interface ApprovalRequest {
  request: CapturedMessage;
  requestId: string;
}

/** Asks the agent for a shell command whose only effect is writing `marker` to `target`. */
export async function requestGatedWrite({ agent, room }: InRoom, marker: string, target: string): Promise<void> {
  await Rooms.sendMention(
    room,
    agent,
    `Use your shell tool to run exactly \`printf %s ${marker} > ${target}\`. You must execute it with the tool, not answer from memory.`,
  );
}

/** Fails unless the gated write ran exactly when it was approved: its marker in `target`, or no `target` at all. */
export async function expectGatedWrite(outcome: Outcome, marker: string, target: string): Promise<void> {
  if (outcome === OUTCOME.approve) {
    expect((await readText(target)).trim(), "the approved command ran").toBe(marker);
  } else {
    expect(existsSync(target), `${outcome} still ran the gated command`).toBe(false);
  }
}

export async function untilRequested({ agent, room }: InRoom, dialect: ApprovalDialect): Promise<ApprovalRequest> {
  const request = await observeRoom(room).untilReplyMatching(agent, (message) => dialect.requestId(message.content) !== null);
  assertReplied(request);
  return { request: request.message, requestId: dialect.requestId(request.message.content)! };
}

/** The agent's reply closing the turn: after its prompt, and neither the prompt nor a notice. */
export async function untilClosed({ agent, room }: InRoom, { request, requestId }: ApprovalRequest, notice: string): Promise<void> {
  const closing = await observeRoom(room).untilReplyMatching(
    agent,
    (message) => !message.content.includes(requestId) && !message.content.includes(notice),
    { after: request },
  );
  assertReplied(closing);
}

export async function untilShown({ agent, room }: InRoom, text: string): Promise<void> {
  assertReplied(await observeRoom(room).untilReplyMatching(agent, (message) => message.content.includes(text)));
}

/**
 * Answers `asked` in the room, then waits for the adapter's notice and the
 * agent's closing reply: the barrier after which the command has settled.
 */
export async function decide(inRoom: InRoom, dialect: ApprovalDialect, decision: Decision, asked: ApprovalRequest): Promise<void> {
  const notice = dialect.notice(decision, asked.requestId);
  await Rooms.sendMention(inRoom.room, inRoom.agent, dialect.reply(decision, asked.requestId));
  await untilShown(inRoom, notice);
  await untilClosed(inRoom, asked, notice);
}

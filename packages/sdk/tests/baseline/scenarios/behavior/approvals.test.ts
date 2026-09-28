/**
 * Chat-mediated approval: a shell command whose only effect is writing a
 * marker pauses on a room prompt, and the user's reply decides whether it runs.
 * Approve runs it; reject and an expired wait don't; a reply after the wait
 * expired is told the ask is gone.
 *
 * The agent's closing reply after the decision is the barrier before the file
 * check: the trigger's processed status does not mean the command has settled.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { perAdapter, type ScenarioCell } from "../../toolkit/perAdapter";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { dialectFor, type ApprovalDialect, type Outcome } from "../samples/approvals";

const SHELL_PROMPT = "Keep responses short. Use your shell tool when asked.";
// Short enough to expire promptly, long enough that the request is captured first.
const EXPIRING_WAIT_MS = 10_000;
// Outlasts the request and the closing-reply barriers.
const PATIENT_WAIT_MS = LIVE_EVENT_TIMEOUT_MS * 2;

/** The agent's approval prompt, and the request id it carries. */
async function untilRequested({ agent, room }: ScenarioCell, dialect: ApprovalDialect) {
  const request = await observeRoom(room).untilReplyMatching(agent, (message) => dialect.requestId(message.content) !== null);
  assertReplied(request);
  return { request: request.message, requestId: dialect.requestId(request.message.content)! };
}

/** The agent's reply closing the turn: after its prompt, and neither the prompt nor a notice. */
async function untilClosed({ agent, room }: ScenarioCell, request: CapturedMessage, notice: string, requestId: string) {
  const closing = await observeRoom(room).untilReplyMatching(
    agent,
    (message) => !message.content.includes(requestId) && !message.content.includes(notice),
    { after: request },
  );
  assertReplied(closing);
}

async function untilShown({ agent, room }: ScenarioCell, text: string) {
  assertReplied(await observeRoom(room).untilReplyMatching(agent, (message) => message.content.includes(text)));
}

async function approvalFlow(outcome: Outcome, scenario: ScenarioCell): Promise<void> {
  const { agent, room, cell } = scenario;
  const dialect = dialectFor(cell.spec.id);
  const marker = uniqueMarker("approval");
  const target = join(cell.workDir, "approval.txt");
  await Rooms.sendMention(
    room,
    agent,
    `Use your shell tool to run exactly \`printf %s ${marker} > ${target}\`. You must execute it with the tool, not answer from memory.`,
  );
  const { request, requestId } = await untilRequested(scenario, dialect);
  const notice = dialect.notice(outcome, requestId);

  if (outcome === "timeout") {
    await untilClosed(scenario, request, notice, requestId);
    const contents = (await observeRoom(room).history()).map((message) => message.content);
    expect(contents, "the expired wait was announced").toContain(notice);
    await Rooms.sendMention(room, agent, dialect.reply("approve", requestId));
    await untilShown(scenario, dialect.lateNotice(requestId));
  } else {
    await Rooms.sendMention(room, agent, dialect.reply(outcome, requestId));
    await untilShown(scenario, notice);
    await untilClosed(scenario, request, notice, requestId);
  }

  if (outcome === "approve") {
    expect((await readFile(target, "utf8")).trim()).toBe(marker);
  } else {
    expect(existsSync(target), `${outcome} still ran the gated command`).toBe(false);
  }
}

const OUTCOMES: readonly Outcome[] = ["approve", "reject", "timeout"];

for (const outcome of OUTCOMES) {
  perAdapter(`behavior.approvals.${outcome}`, (scenario) => approvalFlow(outcome, scenario), {
    supports: ["approvals"],
    prompt: SHELL_PROMPT,
    build: (spec, options) => dialectFor(spec.id).build(options, outcome === "timeout" ? EXPIRING_WAIT_MS : PATIENT_WAIT_MS),
  });
}

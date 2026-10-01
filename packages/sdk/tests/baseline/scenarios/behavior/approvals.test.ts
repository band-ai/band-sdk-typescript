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

import { observeRoom } from "../../toolkit/observeMessages";
import { perAdapter, type ScenarioCell } from "../../toolkit/perAdapter";
import { CAPABILITY, CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import {
  OUTCOME,
  PATIENT_WAIT_MS,
  decide,
  dialectFor,
  requestGatedWrite,
  untilClosed,
  untilRequested,
  untilShown,
  type Outcome,
} from "../samples/approvals";

const SHELL_PROMPT = "Keep responses short. Use your shell tool when asked.";
/** The file the gated command writes its marker to, in the agent's working directory. */
const TARGET_FILE = "approval.txt";
const TEXT = "utf8";
// Short enough to expire promptly, long enough that the request is captured first.
const EXPIRING_WAIT_MS = 10_000;

async function approvalFlow(outcome: Outcome, scenario: ScenarioCell): Promise<void> {
  const { agent, room, cell } = scenario;
  const dialect = dialectFor(cell.spec.id);
  const marker = uniqueMarker("approval");
  const target = join(cell.workDir, TARGET_FILE);
  await requestGatedWrite(scenario, marker, target);
  const asked = await untilRequested(scenario, dialect);

  if (outcome === OUTCOME.timeout) {
    const notice = dialect.notice(outcome, asked.requestId);
    await untilClosed(scenario, asked, notice);
    const contents = (await observeRoom(room).history()).map((message) => message.content);
    expect(contents, "the expired wait was announced").toContain(notice);
    await Rooms.sendMention(room, agent, dialect.reply(OUTCOME.approve, asked.requestId));
    await untilShown(scenario, dialect.lateNotice(asked.requestId));
  } else {
    await decide(scenario, dialect, outcome, asked);
  }

  if (outcome === OUTCOME.approve) {
    expect((await readFile(target, TEXT)).trim()).toBe(marker);
  } else {
    expect(existsSync(target), `${outcome} still ran the gated command`).toBe(false);
  }
}

for (const outcome of Object.values(OUTCOME)) {
  perAdapter(scenarioId(CATEGORY.behavior, `approvals.${outcome}`), (scenario) => approvalFlow(outcome, scenario), {
    supports: [CAPABILITY.approvals],
    prompt: SHELL_PROMPT,
    build: (spec, options) => dialectFor(spec.id).build(options, outcome === OUTCOME.timeout ? EXPIRING_WAIT_MS : PATIENT_WAIT_MS),
  });
}

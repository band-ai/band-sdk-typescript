/**
 * The recovery resource budget, measured in a real child process by
 * `turn-journal-runtime.test.ts`: N standing rooms, each with a journal that
 * stands unresolved, one runtime that starts over all of them. The child
 * reports the process's open-descriptor count before, at the peak of the
 * start's recovery, and after the stop that follows it. A recovery that opens
 * every room's journal at once grows the count with N; the budgeted recovery
 * holds a bounded handful of them open at once, whatever N is.
 *
 * Run through tsx:
 *   node --import tsx tests/journalFdBudgetChild.ts <journalDir> <rooms>
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { agentJournalDir } from "../src/runtime/journal/TurnJournal";
import { identityDirectoryComponent, roomFileComponent } from "../src/runtime/journal/records";
import { PlatformRuntime } from "../src/runtime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";

const [journalDir, roomsText] = process.argv.slice(2);
if (journalDir === undefined || roomsText === undefined) {
  console.error("usage: journalFdBudgetChild <journalDir> <rooms>");
  process.exit(2);
}
const ROOMS = Number(roomsText);
const IDENTITY = canonicalPlatformIdentity("https://band.example");

const fds = (): number => readdirSync("/dev/fd").length;

/** Each room's journal stands with one reply that never settled: start's recovery opens and announces it. */
const roomDir = path.join(agentJournalDir(journalDir, AGENT_ID), identityDirectoryComponent(IDENTITY));
mkdirSync(roomDir, { recursive: true });
for (let i = 0; i < ROOMS; i++) {
  const roomId = `room-${i}`;
  const header = JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT_ID, roomId, at: 1 });
  const intent = JSON.stringify({ t: "reply.intent", messageId: `m-${i}`, publicationId: `p-${i}`, at: 1 });
  writeFileSync(path.join(roomDir, `${roomFileComponent(roomId)}.jsonl`), `${header}\n${intent}\n`);
}

const baseline = fds();
let peak = baseline;
const gauge = setInterval(() => {
  const count = fds();
  if (count > peak) peak = count;
}, 1);

const platform = BandPlatform.host([person("owner")]);
for (let i = 0; i < ROOMS; i++) {
  await platform.room(`room-${i}`);
}
const runtime = new PlatformRuntime({
  agentId: AGENT_ID,
  apiKey: AGENT_API_KEY,
  linkOptions: platform.link,
  agentConfig: { autoSubscribeExistingRooms: true },
  sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
});
await runtime.start(new GenericAdapter(async () => undefined));

// The start's recovery opens and releases each standing room's journal in turn:
// the descriptor count is flat once its last release lands. Wait for that — the
// peak is only meaningful measured over the recovery's whole run — then stop.
const startAt = Date.now();
let lastChange = startAt;
let lastCount = fds();
const settle = setInterval(() => {
  const count = fds();
  if (count !== lastCount) {
    lastCount = count;
    lastChange = Date.now();
  }
  if (Date.now() - lastChange > 500 || Date.now() - startAt > 15_000) {
    clearInterval(settle);
    void runtime.stop().then(finish, finish);
  }
}, 10);

function finish(): void {
  clearInterval(gauge);
  clearInterval(settle);
  const after = fds();
  process.stdout.write(`${JSON.stringify({ rooms: ROOMS, baseline, peak, after })}\n`);
}
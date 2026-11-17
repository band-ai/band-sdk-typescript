/**
 * The recovery resource budget, measured in a real child process by
 * `turn-journal-runtime.test.ts`: N standing rooms, each with a journal that
 * stands unresolved, one runtime that starts over them. The child reports,
 * for the file descriptors it holds: a positive control (three scratch files
 * it opens and counts, proving the gauge can see open files at all), the
 * baseline, the peak across the start's recovery, and the count after the
 * stop that follows it. A recovery that opens every room's journal at once
 * grows the count with N; the budgeted recovery holds a bounded handful open
 * at once, whatever N is.
 *
 * The gauge is the platform's file-descriptor enumeration: /proc/self/fd on
 * Linux, lsof on macOS. On a platform with neither (Windows) the child
 * reports `supported: false` and the test records the gap instead of a blind
 * measurement passing.
 *
 * Run through tsx:
 *   node --import tsx tests/journalFdBudgetChild.ts <journalDir> <rooms>
 */
import { mkdirSync, openSync, closeSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

/**
 * The paths this process's open file descriptors name, from the platform's
 * enumeration; `null` where none stands. Names, not counts: a process whose
 * descriptor table churns under a loader can open and close its own handles
 * between readings, and a bare count difference cannot say which files a
 * measurement saw. The names stand in the enumeration either way.
 */
function fdNames(): string[] | null {
  try {
    if (process.platform === "linux") {
      return readdirSync("/proc/self/fd").map((fd) => {
        try {
          return readlinkSync(path.join("/proc/self/fd", fd));
        } catch {
          return `fd:${fd}`;
        }
      });
    }
    if (process.platform === "darwin") {
      // lsof's `-F n` emits one line per file descriptor it names; the
      // enumeration's own entries (the current directory, the text mapping)
      // stand constant in every reading.
      const out = spawnSync("lsof", ["-F", "n", "-p", String(process.pid)], { encoding: "utf8" }).stdout ?? "";
      return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    }
  } catch {
    // The enumeration failed: a blind gauge must not pass the proof.
  }
  return null;
}

const settleMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The positive control, by name: the enumeration must show the three files
// the child opens, and show them no more once they are closed. A count
// difference cannot stand this check under a churning descriptor table; the
// files' names can.
const baseline = fdNames();
if (baseline === null) {
  process.stdout.write(`${JSON.stringify({ rooms: ROOMS, supported: false })}\n`);
  process.exit(0);
}
const scratchPaths: string[] = [];
const scratchFds: number[] = [];
for (let i = 0; i < 3; i++) {
  const file = path.join(tmpdir(), `budget-control-${process.pid}-${i}`);
  scratchPaths.push(file);
  scratchFds.push(openSync(file, "a"));
}
// The enumeration may spell the same path through the platform's symlink
// (macOS's /var over /private/var): the marker is the name, not the spelling.
const markers = scratchPaths.map((file) => path.basename(file));
const namesOf = (names: string[] | null): string[] => (names ?? []).filter((name) => markers.some((marker) => name.endsWith(`/${marker}`)));
await settleMs(150);
const controlled = fdNames();
const seen = namesOf(controlled);
for (const fd of scratchFds) closeSync(fd);
await settleMs(150);
const back = fdNames();
const leaked = namesOf(back);
const control = { seen: seen.length, leaked: leaked.length, before: baseline.length, withScratch: (controlled ?? []).length, afterClose: (back ?? []).length };
if (controlled === null || back === null || seen.length < 3 || leaked.length > 0) {
  // The gauge could not show the three files it was just given, or showed
  // them still open after the close: a blind or lying gauge's numbers prove
  // nothing, so the proof fails rather than passes blind.
  process.stdout.write(`${JSON.stringify({ rooms: ROOMS, supported: false, control })}\n`);
  process.exit(3);
}

/** Each room's journal stands with one reply that never settled: start's recovery opens and announces it. */
const roomDir = path.join(agentJournalDir(journalDir, AGENT_ID), identityDirectoryComponent(IDENTITY));
mkdirSync(roomDir, { recursive: true });
for (let i = 0; i < ROOMS; i++) {
  const roomId = `room-${i}`;
  const header = JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT_ID, roomId, at: 1 });
  const intent = JSON.stringify({ t: "reply.intent", messageId: `m-${i}`, publicationId: `p-${i}`, at: 1 });
  writeFileSync(path.join(roomDir, `${roomFileComponent(roomId)}.jsonl`), `${header}\n${intent}\n`);
}

const reference = back.length;
let peak = reference;
const gauge = setInterval(() => {
  const names = fdNames();
  if (names !== null && names.length > peak) peak = names.length;
}, 20);

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

// The start's recovery opens and releases each standing room's journal in
// turn: the descriptor count is flat once its last release lands. Wait for
// that — the peak is only meaningful measured over the recovery's whole run
// — then stop.
const startAt = Date.now();
let lastChange = startAt;
let lastCount = fdNames()?.length ?? null;
const settle = setInterval(() => {
  const count = fdNames()?.length ?? null;
  if (count !== null && count !== lastCount) {
    lastCount = count;
    lastChange = Date.now();
  }
  if (Date.now() - lastChange > 500 || Date.now() - startAt > 15_000) {
    clearInterval(settle);
    void runtime.stop().then(finish, finish);
  }
}, 20);

function finish(): void {
  clearInterval(gauge);
  clearInterval(settle);
  const after = fdNames();
  process.stdout.write(`${JSON.stringify({ rooms: ROOMS, supported: true, control, baseline: reference, peak, after: after === null ? 0 : after.length })}\n`);
}
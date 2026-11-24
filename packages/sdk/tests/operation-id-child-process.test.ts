import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { relayReply } from "../src/core/turn";
import { PlatformRuntime } from "../src/runtime";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";

const ROOM = "room-1";
const OWNER = "owner";
const MENTION = `@[[${AGENT_ID}]]`;
const OP_ID = "op-child-1";
const KILL = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The child is the process that dies: it runs a real runtime and is SIGKILLed at its boundary. */
const CHILD = path.join(__dirname, "operationIdChildRuntime.ts");

type ChildMode = "reserve-only" | "post-unknown" | "settled-ack";

const CHILD_BOUNDARY: Record<ChildMode, string> = {
  "reserve-only": "reserved",
  "post-unknown": "post-unknown",
  "settled-ack": "settled-ack",
};

/** The journal record types of `ROOM`'s file under the identity both processes serve. */
async function journalRecordsOf(journalDir: string): Promise<string[]> {
  return recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM));
}

interface ChildState {
  mode: ChildMode;
  boundary: string;
  inboundId: string;
  room: string;
  owner: string;
  mention: string;
  operationId: string;
  platform: import("./flows/support/bandPlatform").PlatformSnapshot;
  /** Settled-ack only: the operation's inbound stood answered at the child's boundary. */
  answered?: boolean;
}

interface ChildMessage {
  type: "boundary" | "failure";
  name?: string;
  message?: string;
}

interface ChildRun {
  child: ChildProcess;
  boundary: (name: string) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the child process with an IPC pipe and watches it for its boundary messages. */
function startChild(journalDir: string, mode: ChildMode, stateFile: string): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, journalDir, mode, stateFile], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: process.env,
  });
  const seen: string[] = [];
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  const failers: Array<(error: Error) => void> = [];
  let failed: Error | undefined;
  child.on("message", (message: ChildMessage) => {
    if (message.type === "failure") {
      failed = new Error(`the child failed: ${message.message ?? "no message"}`);
      for (const failer of failers.splice(0)) failer(failed);
      return;
    }
    if (message.type !== "boundary" || message.name === undefined) return;
    seen.push(message.name);
    for (const [index, waiter] of waiters.entries()) {
      if (waiter.name === message.name) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  });
  child.on("error", (error) => {
    failed = error;
    for (const failer of failers.splice(0)) failer(error);
  });
  let settled: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      settled = { code, signal };
      if (failed === undefined) failed = new Error(`the child exited (${signal ?? code}) before its boundary`);
      for (const failer of failers.splice(0)) failer(failed);
      resolve(settled);
    });
  });
  const boundary = (name: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (seen.includes(name)) return resolve();
      if (failed !== undefined) return reject(failed);
      if (settled !== undefined) return reject(new Error("the child exited without reporting " + name));
      waiters.push({ name, resolve: () => resolve() });
      // A child that exits or fails before reporting rejects the wait; the test's own timeout bounds a hung one.
      failers.push(reject);
    });
  return { child, boundary, exited };
}

async function driveChild(journalDir: string, mode: ChildMode, stateFile: string): Promise<ChildState> {
  const run = startChild(journalDir, mode, stateFile);
  onTestFinished(() => {
    if (run.child.exitCode === null && !run.child.killed) run.child.kill("SIGKILL");
  });
  await run.boundary(CHILD_BOUNDARY[mode]);
  // The child's liveness at the kill is the point: it was alive when the parent
  // killed it, and only the OS is what released its locks afterwards.
  run.child.kill("SIGKILL");
  const exit = await run.exited;
  expect(exit.signal, `the child was alive at its boundary, so its death is the SIGKILL's: got code=${exit.code} signal=${exit.signal}`).toBe("SIGKILL");
  expect(exit.code).toBe(null);
  return JSON.parse(await readFile(stateFile, "utf8")) as ChildState;
}

interface SuccessorRun {
  runtime: PlatformRuntime;
  handled: string[];
  events: RecordLog<AgentEvent>;
}

/**
 * The parent's successor: a real runtime over the same journal and the platform
 * the child left standing. Its turn retries the same keyed call — what any
 * well-behaved caller's retry stands for.
 */
async function startSuccessor(platform: BandPlatform, journalDir: string): Promise<SuccessorRun> {
  const handled: string[] = [];
  const events = new RecordLog<AgentEvent>();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
  });
  runtime.observe((event) => {
    events.record(event);
  });
  // The killed process is dead: its OS-released locks are no lock at all, so the
  // successor starts on the first attempt and never retries.
  await runtime.start(
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      if (String(args.message.content).includes("next")) {
        // A successor turn is unaffected by the old operation: it answers plainly.
        await relayReply(args.tools, "next answered", [OWNER]);
        return;
      }
      await args.tools
        .executeToolCall("band_send_message", {
          room_id: ROOM,
          content: "keyed child send",
          mentions: [OWNER],
          operation_id: OP_ID,
        })
        .catch(() => undefined);
    }),
  );
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  return { runtime, handled, events };
}

/** The successor's platform: the child's platform, rebuilt from the snapshot the child wrote at its boundary. */
function rebuildPlatform(state: ChildState): BandPlatform {
  const platform = BandPlatform.host([person(state.owner)]);
  platform.rest.restore(state.platform);
  return platform;
}

const delivered = (platform: BandPlatform) => platform.rest.deliveries.map((delivery) => delivery.content);

const announced = (events: RecordLog<AgentEvent>) =>
  events.entries.filter((event) => event.type === "delivery.unrecorded");

describe("a keyed operation across a real process boundary", () => {
  it("re-admits a killed process's reservation the file proves was never posted: the successor posts once, and the turn settles", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's recipients write stands held, then dropped with the process:
    // the file proves the post never ran.
    const state = await driveChild(journalDir, "reserve-only", stateFile);
    expect(state.platform.posted).toEqual([]);
    expect(await journalRecordsOf(journalDir)).toEqual(["op.reserved"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir);
    // The re-admission resumes the standing reservation and re-runs it: the
    // content stands posted exactly once, in the successor, and the turn settles.
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    expect(successor.handled).toEqual([state.inboundId]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    const records = await journalRecordsOf(journalDir);
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    expect(records).toContain("op.recipients");
    expect(records).toContain("op.settled");
  }, 180_000);

  it("stands a killed process's accepted-but-unanswered post unknown: the successor announces it, reposts nothing, and its next turn proceeds", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's post stands accepted by the platform; the response of the
    // attempt died with the process, so the outcome stands unknown.
    const state = await driveChild(journalDir, "post-unknown", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["keyed child send"]);
    const recordsAtKill = await journalRecordsOf(journalDir);
    expect(recordsAtKill).toContain("op.recipients");
    expect(recordsAtKill).not.toContain("op.settled");
    expect(recordsAtKill).not.toContain("op.unknown");

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir);
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    // The retry joins the stored unknown: no post of its own, and the turn the
    // unknown stands in settles failed.
    expect(successor.handled).toEqual([state.inboundId]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("failed");
    const records = await journalRecordsOf(journalDir);
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    // The unknown stands in the file as recipients-without-settlement; the
    // successor's announcement above is its report to the operator.
    expect(records).not.toContain("op.settled");
    // A successor turn is unaffected by the old operation: it replies and settles.
    const next = await (await platform.room(state.room)).say(OWNER, `${MENTION} next`);
    await platform.rest.settled.next((settled) => settled.messageId === next && settled.outcome === "processed");
    expect(delivered(platform)).toEqual(["keyed child send", "next answered"]);
    // Counted once the successor handled everything: the restart announced the operation with its id, exactly once.
    expect(announced(successor.events).filter((event) => event.operationId === OP_ID)).toHaveLength(1);
  }, 180_000);

  it("preserves a killed process's durably settled operation and its answered inbound: the successor reposts nothing and runs no turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's settle record is appended, datasynced, and applied in memory;
    // the hold stands before the settle call returns to the engine, so the tool
    // response stands outstanding, the turn does not end, and the message's
    // processed mark never lands in the child's platform.
    const state = await driveChild(journalDir, "settled-ack", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["keyed child send"]);
    expect(state.answered).toBe(true);
    expect(state.platform.settled).toEqual([]);
    expect(await journalRecordsOf(journalDir)).toEqual(["op.reserved", "op.recipients", "op.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir);
    // The durable receipt stands: the successor neither reposts the settled
    // operation nor runs a turn for its message — the journal settles it as
    // answered, and the room sees exactly what the child posted.
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    expect(successor.handled).toEqual([]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    // The repair is a mark, not a record: the journal stands as the child left it.
    expect(await journalRecordsOf(journalDir)).toEqual(["op.reserved", "op.recipients", "op.settled"]);
  }, 180_000);
});

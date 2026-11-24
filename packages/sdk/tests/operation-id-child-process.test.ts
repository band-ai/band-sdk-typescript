import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { relayReply } from "../src/core/turn";
import { PlatformRuntime } from "../src/runtime";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person, type PlatformSnapshot } from "./flows/support/bandPlatform";
import { driveChild } from "./support/childProcess";
import { RecordLog, tmpRoot } from "./testUtils";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";

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

/** The journal record types of the child's room file under the identity both processes serve. */
async function journalRecordsOf(journalDir: string, state: ChildState): Promise<string[]> {
  return recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, state.room));
}

interface ChildState {
  mode: ChildMode;
  boundary: string;
  inboundId: string;
  room: string;
  owner: string;
  mention: string;
  operationId: string;
  platform: PlatformSnapshot;
  /** Settled-ack only: the operation's inbound stood answered at the child's boundary. */
  answered?: boolean;
}

function driveChildTo(journalDir: string, mode: ChildMode, stateFile: string): Promise<ChildState> {
  return driveChild<ChildState>(CHILD, [journalDir, mode, stateFile], stateFile, (run) => run.boundary(CHILD_BOUNDARY[mode]));
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
async function startSuccessor(platform: BandPlatform, journalDir: string, state: ChildState): Promise<SuccessorRun> {
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
        await relayReply(args.tools, "next answered", [state.owner]);
        return;
      }
      await args.tools
        .executeToolCall("band_send_message", {
          room_id: state.room,
          content: "keyed child send",
          mentions: [state.owner],
          operation_id: state.operationId,
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
    const state = await driveChildTo(journalDir, "reserve-only", stateFile);
    expect(state.platform.posted).toEqual([]);
    expect(await journalRecordsOf(journalDir, state)).toEqual(["op.reserved"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state);
    // The re-admission resumes the standing reservation and re-runs it: the
    // content stands posted exactly once, in the successor, and the turn settles.
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    expect(successor.handled).toEqual([state.inboundId]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    const records = await journalRecordsOf(journalDir, state);
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
    const state = await driveChildTo(journalDir, "post-unknown", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["keyed child send"]);
    const recordsAtKill = await journalRecordsOf(journalDir, state);
    expect(recordsAtKill).toContain("op.recipients");
    expect(recordsAtKill).not.toContain("op.settled");
    expect(recordsAtKill).not.toContain("op.unknown");

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state);
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    // The retry joins the stored unknown: no post of its own, and the turn the
    // unknown stands in settles failed.
    expect(successor.handled).toEqual([state.inboundId]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("failed");
    const records = await journalRecordsOf(journalDir, state);
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    // The unknown stands in the file as recipients-without-settlement; the
    // successor's announcement above is its report to the operator.
    expect(records).not.toContain("op.settled");
    // A successor turn is unaffected by the old operation: it replies and settles.
    const next = await (await platform.room(state.room)).say(state.owner, `${state.mention} next`);
    await platform.rest.settled.next((settled) => settled.messageId === next && settled.outcome === "processed");
    expect(delivered(platform)).toEqual(["keyed child send", "next answered"]);
    // Counted once the successor handled everything: the restart announced the operation with its id, exactly once.
    expect(announced(successor.events).filter((event) => event.operationId === state.operationId)).toHaveLength(1);
  }, 180_000);

  it("preserves a killed process's durably settled operation and its answered inbound: the successor reposts nothing and runs no turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's settle record is appended, datasynced, and applied in memory;
    // the hold stands before the settle call returns to the engine, so the tool
    // response stands outstanding, the turn does not end, and the message's
    // processed mark never lands in the child's platform.
    const state = await driveChildTo(journalDir, "settled-ack", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["keyed child send"]);
    expect(state.answered).toBe(true);
    expect(state.platform.settled).toEqual([]);
    expect(await journalRecordsOf(journalDir, state)).toEqual(["op.reserved", "op.recipients", "op.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state);
    // The durable receipt stands: the successor neither reposts the settled
    // operation nor runs a turn for its message — the journal settles it as
    // answered, and the room sees exactly what the child posted.
    await platform.rest.settled.next((settled) => settled.messageId === state.inboundId);
    expect(successor.handled).toEqual([]);
    expect(delivered(platform)).toEqual(["keyed child send"]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    // The repair is a mark, not a record: the journal stands as the child left it.
    expect(await journalRecordsOf(journalDir, state)).toEqual(["op.reserved", "op.recipients", "op.settled"]);
  }, 180_000);
});

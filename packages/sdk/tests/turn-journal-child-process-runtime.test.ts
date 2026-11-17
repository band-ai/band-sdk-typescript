import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { onTestFinished, expect, it, describe } from "vitest";

import { PlatformRuntime } from "../src/runtime";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import type { PlatformSnapshot } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";
import { IDENTITY as JOURNAL_IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";

const IDENTITY = JOURNAL_IDENTITY;
const ROOM = "room-1";
const KILL = 0;

/** The journal record types of `ROOM`'s file under the identity both processes serve. */
async function journalRecordsOf(journalDir: string): Promise<string[]> {
  return recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM));
}

/**
 * The directed runtime/publication crash boundaries, across a real process
 * boundary: a child process runs a real `PlatformRuntime` against the in-test
 * fake platform (`tests/journalChildRuntime.ts`, through tsx, on this test's
 * own node), makes its directed publications, and reports the durable
 * boundary it reached over the IPC pipe it was spawned with. The pipe is the
 * child's liveness anchor — an unresolved Promise is not — so when the parent
 * SIGKILLs it on the boundary's message it is judging a process that was
 * still alive, whose OS-released locks are all it left behind. The parent
 * then rebuilds the platform from the child's snapshot, starts its own
 * runtime over the same journal, and is judged on what the journal alone
 * decides: which marks are repaired, which posts are never repeated.
 */
const CHILD = path.join(__dirname, "journalChildRuntime.ts");

type ChildMode = "settled-before-mark" | "decline" | "multiple-replies" | "intent-only" | "remote-accept" | "before-tool-return" | "reset" | "ab-mixed";

const CHILD_BOUNDARY: Record<ChildMode, string> = {
  "settled-before-mark": "settled",
  decline: "declined",
  "multiple-replies": "settled-one",
  "intent-only": "post-held",
  "remote-accept": "accepted",
  "before-tool-return": "tool-called",
  reset: "stop-started",
  "ab-mixed": "mixed",
};

interface ChildState {
  mode: ChildMode;
  boundary: string;
  inboundId: string;
  room: string;
  owner: string;
  mention: string;
  platform: PlatformSnapshot;
}

interface ChildMessage {
  type: "boundary" | "failure";
  name?: string;
  message?: string;
}

interface ChildRun {
  child: ChildProcess;
  boundary: (name: string) => Promise<void>;
  send: (message: { type: string }) => void;
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
      failers.push(reject);
      setTimeout(() => {
        const due = waiters.findIndex((waiter) => waiter.name === name);
        if (due !== -1) waiters.splice(due, 1);
        const at = failers.indexOf(reject);
        if (at !== -1) failers.splice(at, 1);
        reject(new Error(`timed out waiting for the child to report ${name}`));
      }, 90_000).unref();
    });
  return {
    child,
    boundary,
    send: (message) => child.send(message),
    exited,
  };
}

async function driveChild(journalDir: string, mode: ChildMode, stateFile: string): Promise<ChildState> {
  const run = startChild(journalDir, mode, stateFile);
  onTestFinished(() => {
    if (run.child.exitCode === null && !run.child.killed) run.child.kill("SIGKILL");
  });

  if (mode === "reset") {
    // The child durably settles its reply, then the parent's stop command
    // lands on it; the child starts the stop and is killed mid-stop.
    await run.boundary("reply-settled");
    run.send({ type: "stop" });
    await run.boundary(CHILD_BOUNDARY[mode]);
  } else {
    await run.boundary(CHILD_BOUNDARY[mode]);
  }

  // The child's liveness at the kill is the point: it was alive when the
  // parent killed it, and only the OS is what released its locks afterwards.
  run.child.kill("SIGKILL");
  const exit = await run.exited;
  expect(exit.signal, `the child was alive at its boundary, so its death is the SIGKILL's: got code=${exit.code} signal=${exit.signal}`).toBe("SIGKILL");
  expect(exit.code).toBe(null);

  return JSON.parse(await readFile(stateFile, "utf8")) as ChildState;
}

/** The parent's successor: a real runtime over the same journal and the platform the child left standing. */
async function startSuccessor(
  platform: BandPlatform,
  journalDir: string,
  inboundId: string,
): Promise<{ runtime: PlatformRuntime; handled: string[]; events: RecordLog<AgentEvent>; posted: string[] }> {
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
  // The killed process is dead: its OS-released locks are no lock at all, so
  // the successor starts on the first attempt and never retries.
  await runtime.start(
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      await args.tools.sendMessage(`successor reply to ${String(args.message.content).slice(0, 8)}`, ["@owner"]);
    }),
  );
  // The re-served message must settle: the journal repairs what the dead process owed, or the
  // successor runs the turn the dead process left running. Either way it ends `processed`.
  await platform.rest.settled.next((settled) => settled.messageId === inboundId && settled.outcome === "processed");
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  return { runtime, handled, events, posted: platform.rest.deliveries.map((delivery) => delivery.content) };
}

/** The successor's platform: the child's platform, rebuilt from the snapshot the child wrote at its boundary. */
function rebuildPlatform(state: ChildState): BandPlatform {
  const platform = BandPlatform.host([person(state.owner)]);
  platform.rest.restore(state.platform);
  return platform;
}

describe("the turn journal across a real process boundary, runtime to runtime", () => {
  it("repairs a killed process's marked message from its settled reply, without posting again or running a turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child posts "answer", settles it durably, and is killed while its turn still runs:
    // the message's processed mark never lands in the child's platform.
    const state = await driveChild(journalDir, "settled-before-mark", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["answer"]);
    // The child's turn never completed: its journal holds the reply but no turn end.
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // The successor neither reposts the settled reply nor runs a turn for it: the
    // journal settles the message, and the room sees exactly what the child posted.
    expect(successor.posted).toEqual(["answer"]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    // The repair is a mark, not a record: the journal stands exactly as the child left it.
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);
  }, 180_000);

  it("settles a killed process's declined message from its settled decline, without posting or running a turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    const state = await driveChild(journalDir, "decline", stateFile);
    expect(state.platform.posted).toEqual([]);
    expect(await journalRecordsOf(journalDir)).toEqual(["decline.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    expect(successor.posted).toEqual([]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
  }, 180_000);

  it("never reposts a killed process's settled reply when its message is served again; the unrecorded second reply is not guessed back", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child durably settles "reply one" and is killed before its second reply's intent is recorded.
    const state = await driveChild(journalDir, "multiple-replies", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["reply one"]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // The settled first reply stands: the message is repaired from it, reposted nowhere, and no
    // turn runs that would post it again. Its second reply was never recorded — the journal has
    // no authority over it, so it is not guessed back: it is simply never posted, in either process.
    expect(successor.posted).toEqual(["reply one"]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
  }, 180_000);

  it("runs the turn again for a killed process's reply that never reached the platform: the intent stands, the reply is the successor's", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's reply post sits at the platform's door: the journal stands on the intent,
    // and the platform has no reply at all.
    const state = await driveChild(journalDir, "intent-only", stateFile);
    expect(state.platform.posted).toEqual([]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // The message never stands answered: the successor runs its turn and posts its own reply.
    // The child's intent is never reposted — its reply is the successor's, recorded as its own.
    expect(successor.handled).toEqual([state.inboundId]);
    // Its own reply, and only its own: the child's intent never becomes a post.
    expect(successor.posted).toHaveLength(1);
    expect(successor.posted[0]).toMatch(/^successor reply to /);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    // The child's intent stands beside the successor's reply, under its own
    // publication id; the successor's recovery records the uncertainty it found.
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "publication.reported", "reply.intent", "reply.settled", "turn.done"]);
  }, 180_000);

  it("neither reposts nor reruns for a reply the platform accepted and the journal never settled: it stands unknown, announced", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child's reply is admitted by the platform; the settle record the journal would have
    // made of it was held, so the journal stands on the intent.
    const state = await driveChild(journalDir, "remote-accept", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["answer"]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // The message never stands answered: the successor runs its turn. The reply the platform
    // already admitted is never reposted — the journal knows only the intent, and reposting it
    // would claim a post the journal never made.
    expect(successor.handled).toEqual([state.inboundId]);
    // The reply the platform admitted stands exactly once — as the child posted it;
    // the successor adds its own reply and never reposts the child's.
    expect(successor.posted).toHaveLength(2);
    expect(successor.posted[0]).toBe("answer");
    expect(successor.posted[1]).toMatch(/^successor reply to /);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    expect(platform.rest.posted.entries.map((posted) => posted.content)).toHaveLength(2);
    expect(platform.rest.posted.entries[0].content).toBe("answer");
  }, 180_000);

  it("reruns a turn a killed process started but never published: nothing it did stands in the journal", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child makes one host tool call and is killed before it publishes anything.
    const state = await driveChild(journalDir, "before-tool-return", stateFile);
    expect(state.platform.posted).toEqual([]);
    // A turn that published nothing left the journal with nothing to settle.
    expect(await journalRecordsOf(journalDir)).toEqual([]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    expect(successor.handled).toEqual([state.inboundId]);
    expect(successor.posted).toHaveLength(1);
    expect(successor.posted[0]).toMatch(/^successor reply to /);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  }, 180_000);

  it("keeps a killed process's settled reply authoritative when it is killed mid-stop", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child durably settles "reset reply"; the parent's stop command lands on it and the
    // child is killed mid-stop, its locks still in the OS's hands.
    const state = await driveChild(journalDir, "reset", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["reset reply"]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // The settled reply stands: the successor repairs the message without posting again or
    // running a turn, and the kill mid-stop neither lost the reply nor kept the lock.
    expect(successor.posted).toEqual(["reset reply"]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
  }, 180_000);

  it("settles a killed process's message from its settled reply while its second stands admitted and unknown", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }).catch(() => undefined));
    // The child settles reply A durably, then posts reply B to the platform with B's settle
    // record held: A stands settled, B stands admitted and unknown.
    const state = await driveChild(journalDir, "ab-mixed", stateFile);
    expect(state.platform.posted.map((posted) => posted.content)).toEqual(["reply A", "reply B"]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled", "reply.intent"]);

    const platform = rebuildPlatform(state);
    const successor = await startSuccessor(platform, journalDir, state.inboundId);
    // A stands settled: the message is repaired from it, reposted nowhere, and no turn runs
    // that would post either reply again. B stands unresolved: its uncertainty is announced,
    // not guessed away.
    expect(successor.posted).toEqual(["reply A", "reply B"]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    expect(successor.events.entries.filter((event) => event.type === "delivery.unrecorded").map((event) => event.type)).toEqual(["delivery.unrecorded"]);
  }, 180_000);
});
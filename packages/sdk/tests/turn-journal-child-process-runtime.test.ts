import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { onTestFinished, expect, it, describe } from "vitest";

import { PlatformRuntime } from "../src/runtime";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import type { AgentEvent } from "../src/contracts/events";
import type { PlatformChatMessage } from "../src/client/rest/types";
import { JournalOwnershipError } from "../src/runtime/journal/ownership";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
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
 * fake platform (`tests/journalChildRuntime.ts`, through tsx), makes its
 * directed publications, and is SIGKILLed by the parent the moment the child
 * reports the durable boundary it reached. The parent then starts its own
 * runtime over the same journal directory and the same re-served message, and
 * is judged on what the journal alone decides: which marks are repaired, which
 * posts are never repeated.
 */

const TSX = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
const CHILD = path.join(__dirname, "journalChildRuntime.ts");

type ChildMode = "settle-before-mark" | "decline" | "multiple-replies";
const CHILD_LINE: Record<ChildMode, string> = {
  "settle-before-mark": "settled",
  decline: "declined",
  "multiple-replies": "settled-one",
};

interface ChildRun {
  child: ChildProcess;
  line: (text: string) => Promise<void>;
  kill: () => Promise<void>;
}

/** Starts the child process and watches its stdout for the lines it reports. */
function runChild(journalDir: string, mode: ChildMode, stateFile: string): ChildRun {
  const child = spawn(TSX, [CHILD, journalDir, mode, stateFile], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const lines: string[] = [];
  const waiters: Array<{ text: string; resolve: (line: string) => void }> = [];
  const failers: Array<(error: Error) => void> = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    let rest = "";
    for (const line of String(chunk).split("\n")) {
      const text = (rest + line).trimEnd();
      rest = "";
      if (text === "") continue;
      lines.push(text);
      const due = waiters.findIndex((waiter) => waiter.text === text);
      if (due !== -1) {
        const [waiter] = waiters.splice(due, 1);
        waiter.resolve(text);
      }
    }
  });
  let failed: Error | undefined;
  child.on("error", (error) => {
    failed = error;
    for (const failer of failers.splice(0)) failer(error);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
    if (failed === undefined) failed = new Error(`the child process exited before ${CHILD_LINE[mode] ?? "its boundary"}`);
    for (const failer of failers.splice(0)) failer(failed);
  });
  const line = (text: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const found = lines.find((existing) => existing === text);
      if (found !== undefined) return resolve();
      if (failed !== undefined) return reject(failed);
      if (exited) return reject(new Error("the child exited without reporting " + text));
      waiters.push({ text, resolve: () => resolve() });
      failers.push(reject);
      setTimeout(() => {
        const due = waiters.findIndex((waiter) => waiter.text === text);
        if (due !== -1) waiters.splice(due, 1);
        const at = failers.indexOf(reject);
        if (at !== -1) failers.splice(at, 1);
        reject(new Error(`timed out waiting for the child to report ${text}`));
      }, 90_000).unref();
    });
  return {
    child,
    line,
    kill: () =>
      new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
        setTimeout(() => reject(new Error("the child did not die on SIGKILL")), 10_000).unref();
      }),
  };
}

interface ChildState {
  inboundId: string;
  room: string;
  owner: string;
  mention: string;
  posted: string[];
}

// A process killed at this instant may still stand behind its lock for a few
// milliseconds — an OS remnant of the dead process, not a live owner: a real
// restart lands later than the kill, so the successor retries across that
// window. A live owner keeps the lock, and the start still fails on it.
async function startWithContendedLocks(
  runtime: PlatformRuntime,
  adapter: GenericAdapter,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runtime.start(adapter);
      return;
    } catch (error) {
      if (error instanceof JournalOwnershipError && error.kind === "contention" && attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      throw error;
    }
  }
}

/** The parent's successor: a real runtime over the same journal and the same re-served message. */
async function startSuccessor(
  platform: BandPlatform,
  journalDir: string,
  state: ChildState,
): Promise<{ runtime: PlatformRuntime; handled: string[]; events: RecordLog<AgentEvent>; posted: string[] }> {
  await platform.room(state.room);
  const inbound: PlatformChatMessage = {
    id: state.inboundId,
    content: `${state.mention} hello`,
    message_type: "text",
    sender_id: state.owner,
    sender_type: "User",
    sender_name: state.owner,
    metadata: { mentions: [{ id: AGENT_ID, name: "Agent", handle: null, type: "agent" }] },
    inserted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  platform.rest.addMessage(state.room, inbound);
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
  await startWithContendedLocks(
    runtime,
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      await args.tools.sendMessage(`successor reply to ${String(args.message.content).slice(0, 8)}`, ["@owner"]);
    }),
  );
  // The re-served message must settle: the journal repairs what the dead process owed.
  await platform.rest.settled.next((settled) => settled.messageId === state.inboundId && settled.outcome === "processed");
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  return { runtime, handled, events, posted: platform.rest.deliveries.map((delivery) => delivery.content) };
}

async function driveChild(journalDir: string, mode: ChildMode, stateFile: string): Promise<ChildState> {
  const run = runChild(journalDir, mode, stateFile);
  onTestFinished(() => {
    if (run.child.exitCode === null && !run.child.killed) run.child.kill("SIGKILL");
  });
  await run.line(CHILD_LINE[mode]);
  await run.kill();
  return JSON.parse(await readFile(stateFile, "utf8")) as ChildState;
}

describe("the turn journal across a real process boundary, runtime to runtime", () => {
  it("repairs a killed process's marked message from its settled reply, without posting again or running a turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "..", "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }));
    // The child posts "answer", settles it durably, and is killed while its turn still runs:
    // the message's processed mark never lands in the child's platform.
    const state = await driveChild(journalDir, "settle-before-mark", stateFile);
    expect(state.posted).toEqual(["answer"]);
    // The child's turn never completed: its journal holds the reply but no turn end.
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const platform = BandPlatform.host([person(state.owner)]);
    const successor = await startSuccessor(platform, journalDir, state);
    // The successor neither reposts the settled reply nor runs a turn for it: the
    // journal settles the message, and the room sees exactly what the child posted.
    expect(successor.posted).toEqual([]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
    // The repair is a mark, not a record: the journal stands exactly as the child left it.
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);
  }, 180_000);

  it("settles a killed process's declined message from its settled decline, without posting or running a turn", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "..", "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }));
    const state = await driveChild(journalDir, "decline", stateFile);
    expect(state.posted).toEqual([]);
    expect(await journalRecordsOf(journalDir)).toEqual(["decline.settled"]);

    const platform = BandPlatform.host([person(state.owner)]);
    const successor = await startSuccessor(platform, journalDir, state);
    expect(successor.posted).toEqual([]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
  }, 180_000);

  it("never reposts a killed process's settled reply when its message is served again; the unrecorded second reply is not guessed back", async () => {
    const journalDir = tmpRoot();
    const stateFile = path.join(journalDir, "..", "child-state.json");
    onTestFinished(() => rm(journalDir, { recursive: true, force: true }));
    // The child durably settles "reply one" and is killed before its second reply's intent is recorded.
    const state = await driveChild(journalDir, "multiple-replies", stateFile);
    expect(state.posted).toEqual(["reply one"]);
    expect(await journalRecordsOf(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const platform = BandPlatform.host([person(state.owner)]);
    const successor = await startSuccessor(platform, journalDir, state);
    // The settled first reply stands: the message is repaired from it, reposted nowhere, and no
    // turn runs that would post it again. Its second reply was never recorded — the journal has
    // no authority over it, so it is not guessed back: it is simply never posted, in either process.
    expect(successor.posted).toEqual([]);
    expect(successor.handled).toEqual([]);
    expect(await (await platform.room(state.room)).outcome(state.inboundId)).toBe("processed");
  }, 180_000);
});
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { TurnJournal } from "../src/runtime/journal/TurnJournal";
import { JournalOwnershipError } from "../src/runtime/journal/ownership";
import { tmpRoot } from "./testUtils";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";
import { AGENT_ID } from "./flows/support/bandPlatform";

const ROOM = "room-1";

/** The runtime entry a child process requires: the built package, as another deployment would load it. */
function runtimeEntry(): string {
  return path.join(__dirname, "..", "dist", "runtime.cjs");
}

beforeAll(async () => {
  if (!existsSync(runtimeEntry())) {
    // The root test gate builds the SDK first; a standalone run builds it here.
    const built = spawnSync("pnpm", ["build"], { cwd: path.join(__dirname, ".."), stdio: "inherit" });
    if (built.status !== 0 || !existsSync(runtimeEntry())) {
      throw new Error(`the SDK build the child-process test requires failed${built.stdout ? `: ${built.stdout}` : ""}`);
    }
  }
});

/**
 * The journaling half of one process, in a real second process: it activates
 * the journal the same way a runtime would, begins the reply, hands its
 * publication id to the parent (the platform's side of the post), and — in
 * `full` mode — records the parent's acknowledgement and the turn's end
 * before it is killed. It outlives its work and is killed by the parent, as
 * a crashed process does.
 */
const CHILD_SCRIPT = `
"use strict";
(async () => {
  const [journalDir, agentId, identitySource, roomId, messageId, mode, runtimeEntry] = process.argv.slice(1);
  const { TurnJournal, canonicalPlatformIdentity } = require(runtimeEntry);
  const generation = await new TurnJournal(journalDir, agentId).activate(canonicalPlatformIdentity(identitySource));
  const room = await generation.room(roomId);
  const publicationId = await room.beginReply(messageId);
  process.stdout.write(JSON.stringify({ type: "intent", publicationId }) + "\\n");
  if (mode === "full") {
    // The parent delivers the platform's acknowledgement before this process
    // records it, as a live process would between the post and the settle.
    await new Promise((resolve) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\\n")) resolve();
      });
    });
    await room.settleReply(messageId, publicationId, "receipt-1");
    await room.turnDone(messageId);
    process.stdout.write(JSON.stringify({ type: "done" }) + "\\n");
  }
  // Hold the journal until the parent kills this process.
  await new Promise(() => undefined);
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + "\\n");
  process.exit(1);
});
`;

interface LineChannel {
  nextLine: () => Promise<string>;
  writeLine: (line: string) => void;
}

function spawnJournalChild(
  journalDir: string,
  messageId: string,
  mode: "full" | "hang-after-intent",
): { child: ChildProcessByStdio<Writable, Readable, Readable>; channel: LineChannel; stdout: () => string } {
  const child = spawn(
    process.execPath,
    ["-e", CHILD_SCRIPT, journalDir, AGENT_ID, "https://band.example", ROOM, messageId, mode, runtimeEntry()],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  const pending: Array<(line: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line === "") continue;
      const wait = pending.shift();
      if (wait) wait(line);
    }
  });
  const channel: LineChannel = {
    nextLine: () =>
      new Promise<string>((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`the child exited ${code} before ${"the line it owed"}`)));
        pending.push(resolve);
      }),
    writeLine: (line) => {
      child.stdin.write(`${line}\n`);
    },
  };
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  return { child, channel, stdout: () => stderr.join("") };
}

/** Kills `child` and resolves once it has really exited. */
function killChild(child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => (code === null ? resolve() : reject(new Error(`the child exited ${code} on its own`))));
    child.kill("SIGKILL");
  });
}

/** The successor process's view of `journalDir`, activated in this (parent) process. */
async function reopenSuccessor(journalDir: string): Promise<import("../src/runtime/journal/TurnJournal").JournalGeneration> {
  const generation = await new TurnJournal(journalDir, AGENT_ID).activate(canonicalPlatformIdentity("https://band.example"));
  return generation;
}

describe("the turn journal across a real process boundary", () => {
  it("lets a successor process settle a crashed process's message from its settled reply, without posting again", async () => {
    const journalDir = tmpRoot();
    const inbound = "msg-crashed-settled";
    const { child, channel } = spawnJournalChild(journalDir, inbound, "full");
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });

    const intentLine = JSON.parse(await channel.nextLine()) as { type: string; publicationId: string };
    expect(intentLine.type).toBe("intent");
    // The platform took the post; the acknowledgement reaches the process before it records it.
    channel.writeLine(JSON.stringify({ type: "ack" }));
    const doneLine = JSON.parse(await channel.nextLine()) as { type: string };
    expect(doneLine.type).toBe("done");

    // The crashed process still holds the ownership lock: a concurrent successor contends on it.
    await expect(new TurnJournal(journalDir, AGENT_ID).activate(canonicalPlatformIdentity("https://band.example")))
      .rejects.toBeInstanceOf(JournalOwnershipError);

    // The process dies mid-ownership: the lock stands, the journal is intact.
    await killChild(child);

    // The successor process (this one, a different PID) reopens what the crashed one settled.
    const generation = await reopenSuccessor(journalDir);
    const room = await generation.room(ROOM);
    expect(room.answered(inbound)).toBe(true);
    expect(await room.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM))).toEqual(["reply.intent", "reply.settled", "turn.done"]);

    // Band serves the message again as a new inbound: the journal settles it as already
    // answered — no turn runs, no reply posts.
    expect(room.answered(inbound)).toBe(true);
    expect(await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM))).toEqual(["reply.intent", "reply.settled", "turn.done"]);
    await generation.close();
  });

  it("reports a reply a crashed process acknowledged but never recorded, instead of reposting it", async () => {
    const journalDir = tmpRoot();
    const inbound = "msg-crashed-acked";
    const { child, channel, stdout } = spawnJournalChild(journalDir, inbound, "hang-after-intent");
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });

    const intentLine = JSON.parse(await channel.nextLine()) as { type: string; publicationId: string };
    expect(intentLine.type).toBe("intent");
    // The platform took the post (its acknowledgement stood), then the process died
    // before the settlement that would record the acknowledgement ever reached disk.
    await killChild(child);
    expect(stdout()).toBe("");

    const generation = await reopenSuccessor(journalDir);
    const room = await generation.room(ROOM);
    // The reply stands unresolved: admitted, with no recorded outcome. The message it owed
    // is not settled, and the reply is not posted again.
    expect(room.answered(inbound)).toBe(false);
    expect(await room.recoverUnresolved()).toEqual([
      { messageId: inbound, publicationId: intentLine.publicationId, outcome: "pending", at: expect.any(Number) },
    ]);
    // The report is recorded: a later open of the same or another generation reports it once.
    expect(await room.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM))).toEqual(["reply.intent", "publication.reported"]);
    await generation.close();
  });
});
/**
 * One journaling process, run in a real child process by
 * `turn-journal-child-process-runtime.test.ts`: a real `PlatformRuntime` over
 * the in-test fake platform, performing its turn's directed publications.
 *
 * Run through tsx, with an IPC pipe the parent spawned it with:
 *   node --import tsx tests/journalChildRuntime.ts <journalDir> <mode> <stateFile>
 *
 * The child is the process that dies: at the boundary its mode directs it to,
 * it writes `<stateFile>` — the platform's standing state, what a test
 * rebuilds in another process — atomically, and tells the parent over the IPC
 * pipe that the boundary is reached. The pipe is the child's liveness anchor:
 * an unresolved Promise is not, and a parent that SIGKILLs it is judging the
 * child on a process that was still alive, whose OS-released locks are all it
 * left behind.
 *
 * Modes:
 *   settled-before-mark  posts "answer" and durably settles it, then hangs
 *                        with the turn still running: the message's processed
 *                        mark never lands in this process.
 *   decline              settles an accepted decline, then hangs: the mark
 *                        never lands in this process.
 *   multiple-replies     durably settles its first reply, then hangs before
 *                        its second reply is even begun.
 *   intent-only          its reply's post is held in flight at the platform's
 *                        door: the journal stands on the intent alone, and
 *                        the platform has no reply at all.
 *   remote-accept        its reply's post is accepted by the platform, then
 *                        the journal's settle record is held: the platform
 *                        has the reply, the journal stands on the intent.
 *   before-tool-return   makes one host tool call and hangs before any
 *                        publication: the journal stands on nothing.
 *   reset                durably settles its reply, then, on the parent's
 *                        stop command, stops without being awaited and is
 *                        killed mid-stop.
 *   ab-mixed             durably settles reply A, then posts reply B to the
 *                        platform with its settle record held: A stands
 *                        settled, B stands admitted and unknown.
 */
import { writeFileSync, renameSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { PlatformRuntime } from "../src/runtime";
import type { PlatformChatMessage } from "../src/client/rest/types";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";

const [journalDir, mode, stateFile] = process.argv.slice(2);
if (journalDir === undefined || mode === undefined || stateFile === undefined) {
  console.error("usage: journalChildRuntime <journalDir> <mode> <stateFile>");
  process.exit(2);
}

const OWNER = "owner";
const MENTION = `@[[${AGENT_ID}]]`;
const ROOM = "room-1";
const INBOUND_ID = "msg-child-inbound";
const IDENTITY = canonicalPlatformIdentity("https://band.example");

type ChildMode = "settled-before-mark" | "decline" | "multiple-replies" | "intent-only" | "remote-accept" | "before-tool-return" | "reset" | "ab-mixed";

const never = (): Promise<never> => new Promise(() => undefined);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("the child timed out waiting for its directed cut");
    await sleep(5);
  }
}

/**
 * Holds the first journal append whose line matches `match` until this process
 * dies. The same FileHandle.prototype patch the in-test fakes use, without
 * them: this process is not a test, and the hold is meant to outlive every
 * release — the process is the release.
 */
async function holdFirstJournalAppend(match: (line: string) => boolean): Promise<{ entered: Promise<void> }> {
  const probe = await open(path.join(path.dirname(stateFile), `append-probe-${randomUUID()}`), "w");
  const proto = Object.getPrototypeOf(probe) as { appendFile: (...args: unknown[]) => Promise<void> };
  await probe.close();
  const original = proto.appendFile;
  const entered = new Promise<void>((resolve) => {
    proto.appendFile = async function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string" && match(args[0])) {
        proto.appendFile = original;
        resolve();
        await never();
      }
      return original.call(this, ...args);
    };
  });
  return { entered };
}

async function main(): Promise<void> {
  const platform = BandPlatform.host([person(OWNER)]);
  await platform.room(ROOM);
  const inbound: PlatformChatMessage = {
    id: INBOUND_ID,
    content: `${MENTION} hello`,
    message_type: "text",
    sender_id: OWNER,
    sender_type: "User",
    sender_name: OWNER,
    metadata: { mentions: [{ id: AGENT_ID, name: "Agent", handle: null, type: "agent" }] },
    inserted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  platform.rest.addMessage(ROOM, inbound);

  let boundary: string;
  const report = (name: string): void => {
    boundary = name;
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode, boundary, inboundId: INBOUND_ID, room: ROOM, owner: OWNER, mention: MENTION, platform: platform.rest.snapshot() }, null, 2));
    renameSync(tmp, stateFile);
    process.send?.({ type: "boundary", name });
  };

  const rest = platform.rest;

  let postInFlight = false;
  if (mode === "intent-only") {
    // Its reply never reaches the platform: the post sits at the platform's door.
    const post = rest.createChatMessage;
    rest.createChatMessage = async (roomId, message, options) => {
      if (message.content === "answer") {
        postInFlight = true;
        await never();
      }
      return post.call(rest, roomId, message, options);
    };
  }

  // Remote-accept's cut is one reply against one platform: its settle record is
  // held before its post is even fired, so the platform accepts it and the
  // journal never learns of the acceptance.
  let remoteAcceptEntered: Promise<void> | undefined;
  if (mode === "remote-accept") {
    remoteAcceptEntered = (await holdFirstJournalAppend((line) => line.includes('"t":"reply.settled"'))).entered;
  }

  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
  });

  if (mode === "reset") {
    process.on("message", (message: { type?: string }) => {
      if (message?.type !== "stop") return;
      // The parent's stop lands here; the child starts it and is killed mid-stop.
      void runtime.stop();
      report("stop-started");
    });
  }

  await runtime.start(
    new GenericAdapter(async (args) => {
      switch (mode as ChildMode) {
        case "settled-before-mark": {
          await args.tools.sendMessage("answer", ["@owner"]);
          report("settled");
          break;
        }
        case "decline": {
          await args.tools.executeToolCall("band_no_reply", { reason: "the turn declines" });
          report("declined");
          break;
        }
        case "multiple-replies": {
          await args.tools.sendMessage("reply one", ["@owner"]);
          report("settled-one");
          break;
        }
        case "intent-only": {
          void args.tools.sendMessage("answer", ["@owner"]);
          await until(() => postInFlight);
          report("post-held");
          break;
        }
        case "remote-accept": {
          void args.tools.sendMessage("answer", ["@owner"]);
          await remoteAcceptEntered;
          report("accepted");
          break;
        }
        case "before-tool-return": {
          await args.tools.executeToolCall("band_lookup_peers", {});
          report("tool-called");
          break;
        }
        case "reset": {
          await args.tools.sendMessage("reset reply", ["@owner"]);
          report("reply-settled");
          break;
        }
        case "ab-mixed": {
          await args.tools.sendMessage("reply A", ["@owner"]);
          // A stands settled; only now is B's settle record held, so B is the
          // reply admitted by the platform and unknown to the journal.
          const enteredB = (await holdFirstJournalAppend((line) => line.includes('"t":"reply.settled"'))).entered;
          void args.tools.sendMessage("reply B", ["@owner"]);
          await enteredB;
          report("mixed");
          break;
        }
        default:
          throw new Error(`journalChildRuntime: unknown mode ${String(mode)}`);
      }
      // The turn now outlives the process: nothing after this settles in it.
      await never();
    }),
  );
  // Hang until the parent kills this process at the directed boundary; the IPC
  // pipe is what keeps this process alive here.
  await never();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.send?.({ type: "failure", message });
  } catch {
    // The pipe is gone: nothing to tell the parent to.
  }
  console.error(error);
  process.exit(1);
});
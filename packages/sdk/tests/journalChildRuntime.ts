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
 *   before-tool-return   its reply's post stands admitted by the platform,
 *                        then the settle record's write is held in flight:
 *                        publication is paused in its last durable step, and
 *                        the turn does not end.
 *   reset                durably settles its reply, then, on the parent's
 *                        command, runs the room's real reset with its cancel
 *                        budget; the un-cancellable turn detaches, and the
 *                        process is killed with the detached turn still up.
 *   ab-mixed             durably settles reply A, then posts reply B to the
 *                        platform with its settle record held: A stands
 *                        settled, B stands admitted and unknown.
 *   durable-ack          wraps the room journal's settle: the real settle
 *                        append, datasync and in-memory settlement complete,
 *                        then the hold stands before the call returns to the
 *                        engine: the reply is durably settled and the turn
 *                        does not end.
 *   ab-unresolved        answers message A to a durably settled reply whose
 *                        turn completes — A's processed mark lands in this
 *                        process — then answers message B with a reply the
 *                        platform admits and whose settle record is held:
 *                        A stands settled, B stands unresolved, and the
 *                        process is killed at the hold.
 */
import { writeFileSync, renameSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { RoomJournal } from "../src/runtime/journal/RoomJournal";
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
const INBOUND_A_ID = "msg-child-a";
const INBOUND_B_ID = "msg-child-b";
const IDENTITY = canonicalPlatformIdentity("https://band.example");

type ChildMode = "settled-before-mark" | "decline" | "multiple-replies" | "intent-only" | "remote-accept" | "before-tool-return" | "reset" | "ab-mixed" | "durable-ack" | "ab-unresolved";

const never = (): Promise<never> => new Promise(() => undefined);

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
  const inboundA: PlatformChatMessage = { ...inbound, id: INBOUND_A_ID, content: `${MENTION} first` };
  const inboundB: PlatformChatMessage = { ...inbound, id: INBOUND_B_ID, content: `${MENTION} second` };
  if (mode === "ab-unresolved") {
    // Two messages, one after the other: A's turn completes in this process
    // (its reply settles, its processed mark lands), B's does not.
    platform.rest.addMessage(ROOM, inboundA);
    platform.rest.addMessage(ROOM, inboundB);
  } else {
    platform.rest.addMessage(ROOM, inbound);
  }

  let boundary: string;
  const report = (name: string, extra: Record<string, unknown> = {}): void => {
    boundary = name;
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode, boundary, inboundId: INBOUND_ID, room: ROOM, owner: OWNER, mention: MENTION, platform: platform.rest.snapshot(), ...extra }, null, 2));
    renameSync(tmp, stateFile);
    process.send?.({ type: "boundary", name });
  };

  const rest = platform.rest;

  const postInFlight = Promise.withResolvers<void>();
  if (mode === "intent-only") {
    // Its reply never reaches the platform: the post sits at the platform's door.
    const post = rest.createChatMessage;
    rest.createChatMessage = async (roomId, message, options) => {
      if (message.content === "answer") {
        postInFlight.resolve();
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

  // Durable-ack's cut stands after the real settlement: the settle record is
  // appended, datasynced, and applied in memory, and only then does the hold
  // stand — before settleReply returns to the engine, so the turn does not end.
  if (mode === "durable-ack") {
    const settle = RoomJournal.prototype.settleReply;
    RoomJournal.prototype.settleReply = async function (this: RoomJournal, ...args: Parameters<RoomJournal["settleReply"]>) {
      await settle.apply(this, args); // the real append, datasync and in-memory settlement
      report("durable-ack", { answered: this.answered(String(args[0])) });
      await never(); // the process is the hold: it dies at the parent's SIGKILL
    };
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
      // The parent's command lands here: the room's real reset, with its cancel
      // budget. The turn's adapter cannot be cancelled within it, so the reset
      // fails and detaches the turn — which keeps running when the process dies.
      void (async () => {
        const ok = await runtime.resetRoomSession(ROOM, 0);
        report(ok ? "reset-done" : "reset-failed");
      })();
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
          await postInFlight.promise;
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
          // Publication stands paused in its last durable step: the reply's
          // post is admitted by the platform, and its settle record's write is
          // held in flight at the journal, which the engine awaits before the
          // tool returns.
          const hold = (await holdFirstJournalAppend((line) => line.includes('"t":"reply.settled"'))).entered;
          void args.tools.sendMessage("tool answer", ["@owner"]);
          await hold;
          report("paused");
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
        case "durable-ack": {
          // The settle wrapper reports the boundary from inside this call's
          // own settlement and never returns: the process parks here until
          // the parent kills it.
          await args.tools.sendMessage("durable pending-tool reply", ["@owner"]);
          break;
        }
        case "ab-unresolved": {
          if (String(args.message.id) === INBOUND_A_ID) {
            // A's reply settles and its turn ends: the processed mark lands
            // in this process, so the successor's input never contains A.
            await args.tools.sendMessage("reply A", ["@owner"]);
            break;
          }
          // B: its reply is admitted by the platform, then its settle record
          // is held: B stands unresolved, and the turn does not end.
          const enteredB = (await holdFirstJournalAppend((line) => line.includes('"t":"reply.settled"'))).entered;
          void args.tools.sendMessage("reply B", ["@owner"]);
          await enteredB;
          report("ab-unresolved", { inboundId: INBOUND_B_ID, secondInboundId: INBOUND_A_ID });
          break;
        }
        default:
          throw new Error(`journalChildRuntime: unknown mode ${String(mode)}`);
      }
      // Ab-unresolved's first turn must end: its reply settles, its mark lands,
      // and the process moves on to the second message. Every other mode parks
      // its turn here: nothing after this settles in it.
      if (mode === "ab-unresolved" && String(args.message.id) === INBOUND_A_ID) return;
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
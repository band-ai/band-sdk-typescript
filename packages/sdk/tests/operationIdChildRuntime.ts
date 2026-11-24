/**
 * One keyed-operation process, run in a real child process by
 * `operation-id-child-process.test.ts`: a real `PlatformRuntime` over the
 * in-test fake platform, performing one keyed `band_send_message` under a fixed
 * operation id.
 *
 * Run through tsx, with an IPC pipe the parent spawned it with:
 *   node --import tsx tests/operationIdChildRuntime.ts <journalDir> <mode> <stateFile>
 *
 * The child is the process that dies: at the boundary its mode stands it at, it
 * writes `<stateFile>` — the platform's standing state, what a test rebuilds in
 * another process — atomically, and tells the parent over the IPC pipe that the
 * boundary is reached. The pipe is the child's liveness anchor; the parent
 * SIGKILLs it on the boundary's message, so it judges a process that was still
 * alive, whose OS-released locks are all it left behind.
 *
 * Modes:
 *   reserve-only   the operation's recipients write stands held, then dropped:
 *                  the reservation stands durable, and the file proves the post
 *                  never ran.
 *   post-unknown   the once post is accepted by the platform, then its
 *                  response is never returned: committed or not, this process
 *                  can never say.
 *   settled-ack    the operation's settle record is appended, datasynced, and
 *                  applied in memory, and only then does the hold stand —
 *                  before the settle call returns to the engine: the tool's
 *                  response stands outstanding, the turn does not end, and the
 *                  message's processed mark never lands in this process.
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
  console.error("usage: operationIdChildRuntime <journalDir> <mode> <stateFile>");
  process.exit(2);
}

const OWNER = "owner";
const MENTION = `@[[${AGENT_ID}]]`;
const ROOM = "room-1";
const INBOUND_ID = "msg-op-child-inbound";
const OP_ID = "op-child-1";
const IDENTITY = canonicalPlatformIdentity("https://band.example");

type ChildMode = "reserve-only" | "post-unknown" | "settled-ack";

const never = (): Promise<never> => new Promise(() => undefined);

/**
 * Holds the first journal append whose line matches `match` until this process
 * dies. The same FileHandle.prototype patch the in-test fakes use, without
 * them: this process is not a test, and the hold is meant to outlive every
 * release — the process is the release.
 */
async function holdFirstJournalAppend(match: (line: string) => boolean): Promise<{ entered: Promise<void> }> {
  const probe = await open(path.join(path.dirname(stateFile), `op-append-probe-${randomUUID()}`), "w");
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
    content: `${MENTION} keyed send please`,
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
  const report = (name: string, extra: Record<string, unknown> = {}): void => {
    boundary = name;
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode, boundary, inboundId: INBOUND_ID, room: ROOM, owner: OWNER, mention: MENTION, operationId: OP_ID, platform: platform.rest.snapshot(), ...extra }, null, 2));
    renameSync(tmp, stateFile);
    process.send?.({ type: "boundary", name });
  };

  const rest = platform.rest;

  if (mode === "post-unknown") {
    // The once post reaches Band and is accepted; the response of the attempt
    // is lost in this process: committed or not, it cannot say.
    const postOnce = rest.createChatMessageOnce;
    rest.createChatMessageOnce = async (roomId, message, options) => {
      if (postOnce === undefined) throw new Error("the test platform has no once port");
      const accepted = await postOnce.call(rest, roomId, message, options);
      await never();
      return accepted;
    };
  }

  if (mode === "settled-ack") {
    // The real settle append, datasync and in-memory settlement complete, then
    // the hold stands before the call returns to the engine: the operation is
    // durably settled, the tool's response still stands outstanding, and the
    // turn does not end.
    const settleOperation = RoomJournal.prototype.settleOperation;
    RoomJournal.prototype.settleOperation = async function (this: RoomJournal, ...args: Parameters<RoomJournal["settleOperation"]>) {
      await settleOperation.apply(this, args);
      report("settled-ack", { answered: this.answered(INBOUND_ID) });
      await never();
    };
  }

  let recipientsEntered: Promise<void> | undefined;
  if (mode === "reserve-only") {
    ({ entered: recipientsEntered } = await holdFirstJournalAppend((line) => line.includes('"op.recipients"')));
  }

  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
  });

  await runtime.start(
    new GenericAdapter(async (args) => {
      const keyed = args.tools
        .executeToolCall("band_send_message", {
          room_id: ROOM,
          content: "keyed child send",
          mentions: [OWNER],
          operation_id: OP_ID,
        })
        .catch((error: unknown) => error);
      switch (mode as ChildMode) {
        case "reserve-only": {
          // The reservation stands recorded; the recipients write stands held,
          // then dropped with this process.
          if (recipientsEntered === undefined) throw new Error("the recipients hold never stood");
          await recipientsEntered;
          report("reserved");
          await keyed;
          break;
        }
        case "post-unknown": {
          // The post is accepted by the platform, and the response never returns.
          await rest.posted.until(() => rest.posted.entries.length > 0);
          report("post-unknown");
          await keyed;
          break;
        }
        case "settled-ack": {
          await keyed;
          break;
        }
      }
    }),
  );
  await never();
}

main().catch((error: unknown) => {
  process.send?.({ type: "failure", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

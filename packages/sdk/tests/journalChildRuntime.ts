/**
 * One journaling process, run in a real child process by
 * `turn-journal-child-process-runtime.test.ts`: a real `PlatformRuntime` over
 * the in-test fake platform, performing its turn's directed publications and
 * reporting each durable boundary it reaches on stdout. It then hangs — the
 * parent decides, by SIGKILL, which part of the turn this process never
 * finishes: the processed mark, its second reply, or its stop.
 *
 * Run through tsx (it imports the SDK sources and the test's fake platform):
 *   tsx tests/journalChildRuntime.ts <journalDir> <mode> <stateFile>
 *
 * Modes:
 *   settle-before-mark  posts and durably settles one reply, then hangs with
 *                       the turn still running: the message's processed mark
 *                       never lands in this process.
 *   decline             settles an accepted decline, then hangs: the mark
 *                       never lands in this process.
 *   multiple-replies    durably settles its first reply, then hangs before
 *                       its second reply is even begun.
 *
 * Before hanging it writes `<stateFile>`: the inbound message it served (id,
 * content, mention), so the parent's successor process can re-serve the same
 * message under the same id and be judged on what the journal alone decides.
 */
import { writeFileSync } from "node:fs";

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

const never = (): Promise<never> => new Promise(() => undefined);

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

  let posted: string[] = [];
  // The state snapshot lands exactly when a boundary is reported: the parent reads
  // it after the child has reached that boundary and been killed.
  const report = (line: string): void => {
    writeFileSync(stateFile, JSON.stringify({ inboundId: INBOUND_ID, room: ROOM, owner: OWNER, mention: MENTION, posted }, null, 2));
    process.stdout.write(`${line}\n`);
  };
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
  });
  await runtime.start(
    new GenericAdapter(async (args) => {
      switch (mode) {
        case "settle-before-mark": {
          await args.tools.sendMessage("answer", ["@owner"]);
          posted = ["answer"];
          report("settled");
          // The turn now outlives the process: nothing after this settles in it.
          await never();
          break;
        }
        case "decline": {
          await args.tools.executeToolCall("band_no_reply", { reason: "the turn declines" });
          report("declined");
          await never();
          break;
        }
        case "multiple-replies": {
          await args.tools.sendMessage("reply one", ["@owner"]);
          posted = ["reply one"];
          report("settled-one");
          // Its second reply is never begun: no intent for it is ever recorded.
          await never();
          break;
        }
        default:
          throw new Error(`journalChildRuntime: unknown mode ${String(mode)}`);
      }
    }),
  );
  // Hang until the parent kills this process at the directed boundary.
  await never();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
/**
 * Operator capture runner for the r4 journal settlement review. Run from
 * packages/sdk: `node --import tsx tests/capture-task10.mts` — writes the
 * corrected operator captures the review needs: the v2 migration with its
 * manifest and a real v1 compaction remnant, the identity refusals, the
 * unbound-legacy start error, and the stop's drain/disconnect ordering.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import type { Logger } from "../src/core/logger";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";
import { identityDirectoryComponent } from "../src/runtime/journal/records";
import { TurnJournal, agentJournalDir, legacyAgentDir, roomFileName } from "../src/runtime/journal/TurnJournal";
import { migrateTurnJournals } from "../src/runtime/journal/migration";
import { PlatformRuntime } from "../src/runtime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";

const IDENTITY = canonicalPlatformIdentity("https://band.example");
const OWNER = "owner";
const out: string[] = [];
const say = (...lines: string[]): void => {
  out.push(...lines);
};
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

say("=== " + new Date().toISOString() + " ===");
say("# r4 operator captures (run through `node --import tsx tests/capture-task10.mts` from packages/sdk).");
say("");

// 1) The v2 migration: preview, refusal, apply, re-apply — with a real v1
//    compaction remnant in the v1 layout.
const journalDir = mkdtempSync(path.join(tmpdir(), "task10-migration-"));
const agentDir = agentJournalDir(journalDir, AGENT_ID);
const legacyDir = legacyAgentDir(journalDir, AGENT_ID);
mkdirSync(legacyDir, { recursive: true });
const room1 = "room-1.jsonl";
const remnant1 = `${room1}.${randomUUID()}.compacting`;
const room2 = "room-2.jsonl";
const room1Lines = [JSON.stringify({ t: "reply.intent", messageId: "m1", at: 1 }), JSON.stringify({ t: "turn.done", messageId: "m1", at: 2 })];
const room2Lines = [JSON.stringify({ t: "reply.intent", messageId: "m2", at: 1 })];
writeFileSync(path.join(legacyDir, room1), room1Lines.join("\n") + "\n");
writeFileSync(path.join(legacyDir, remnant1), room1Lines.join("\n") + "\n");
writeFileSync(path.join(legacyDir, room2), room2Lines.join("\n") + "\n");

say("## 1) A v1 layout with two legacy room files and a crashed v1 compaction's remnant, no migration manifest yet:");
say(`# legacy files: ${room1}, ${remnant1} (the byte-identical output v1 compaction left of ${room1}), ${room2}`);
say("");

const binding1 = { sourceFile: room1, roomId: "room-1", sourceSha256: sha(room1Lines.join("\n") + "\n"), platformIdentity: IDENTITY, provenance: "operator-attested:band deployment A" };
const binding2 = { sourceFile: room2, roomId: "room-2", sourceSha256: sha(room2Lines.join("\n") + "\n"), platformIdentity: IDENTITY, provenance: "operator-attested:band deployment B" };
const preview = await migrateTurnJournals({ journalDir, agentId: AGENT_ID, bindings: [binding1] });
say("## 2) preview with only the first journal bound (its compaction remnant is covered by the journal's binding, so it is not unbound):");
say(JSON.stringify(preview, null, 2));
say("");

const refused = await migrateTurnJournals({ journalDir, agentId: AGENT_ID, apply: true, bindings: [binding1] }).then(
  (result) => `committed: ${JSON.stringify(result.mode)}`,
  (error: Error) => error.message,
);
say("## 3) apply refused while a legacy file is still unbound:");
say(String(refused));
say("");

const applied = await migrateTurnJournals({ journalDir, agentId: AGENT_ID, apply: true, bindings: [binding1, binding2] });
say("## 4) apply with every legacy file bound (the remnant rides its journal; both originals preserved):");
say(JSON.stringify(applied, null, 2));
say("");
const manifest = JSON.parse(readFileSync(path.join(agentDir, "migration", "manifest.json"), "utf8"));
say("## 5) the committed manifest records the import hash-bound, v2:");
say(JSON.stringify(manifest, null, 2));
const staged = path.join(agentDir, identityDirectoryComponent(IDENTITY), roomFileName("room-1"));
say("");
say("## 6) the journal it committed, with the converted v1 records:");
say(readFileSync(staged, "utf8").trim());
say("");

const reapply = await migrateTurnJournals({ journalDir, agentId: AGENT_ID, apply: true, bindings: [binding1, binding2] });
say("## 7) re-apply of a committed migration:");
say(`{ "mode": ${JSON.stringify(reapply.mode)} }`);
say("");

// 2) Identities the runtime will not serve are refused by the migration.
for (const identity of ["onprem:cluster-7", "https://user:token@band.example"]) {
  const dir2 = mkdtempSync(path.join(tmpdir(), "task10-identity-"));
  mkdirSync(legacyAgentDir(dir2, AGENT_ID), { recursive: true });
  writeFileSync(path.join(legacyAgentDir(dir2, AGENT_ID), room1), room1Lines.join("\n") + "\n");
  const failed = await migrateTurnJournals({
    journalDir: dir2,
    agentId: AGENT_ID,
    apply: true,
    bindings: [{ sourceFile: room1, roomId: "room-1", sourceSha256: sha(room1Lines.join("\n") + "\n"), platformIdentity: identity, provenance: "operator-attested" }],
  }).then(
    (result) => `committed: ${JSON.stringify(result.mode)}`,
    (error: Error) => error.message,
  );
  say(`## 8) a binding attesting an identity the runtime refuses to serve (${identity}):`);
  say(String(failed).split("\n")[0]);
  say("");
}

// 3) The unbound-legacy start refusal, with its corrected text.
const dir3 = mkdtempSync(path.join(tmpdir(), "task10-unbound-"));
mkdirSync(legacyAgentDir(dir3, AGENT_ID), { recursive: true });
writeFileSync(path.join(legacyAgentDir(dir3, AGENT_ID), room1), room1Lines.join("\n") + "\n");
const unbound = await new TurnJournal(dir3, AGENT_ID).activate(IDENTITY).then(
  () => "(activated — the capture is wrong)",
  (error: Error) => error.message,
);
say("## 9) start with legacy records no migration has bound:");
say(String(unbound));
say("");

// 4) The stop's drain/disconnect ordering with an in-flight publication.
const dir4 = mkdtempSync(path.join(tmpdir(), "task10-drain-"));
const platform = BandPlatform.host([person(OWNER)]);
const room = await platform.room("room-1");
const logLines: string[] = [];
const events: string[] = [];
const logger: Logger = {
  debug: (message, context) => logLines.push(`debug: ${message} ${JSON.stringify(context ?? {})}`),
  info: (message, context) => logLines.push(`info: ${message} ${JSON.stringify(context ?? {})}`),
  warn: (message, context) => logLines.push(`warn: ${message} ${JSON.stringify(context ?? {})}`),
  error: (message, context) => logLines.push(`error: ${message} ${JSON.stringify(context ?? {})}`),
};
const runtime = new PlatformRuntime({
  agentId: AGENT_ID,
  apiKey: AGENT_API_KEY,
  linkOptions: platform.link,
  agentConfig: { autoSubscribeExistingRooms: true },
  sessionConfig: { journalDir: dir4, journalPlatformIdentity: IDENTITY },
  logger,
});
runtime.observe((event) => events.push(event.type));
// The reply's post sits at the platform's door: held until the drain's release.
const originalCreate = platform.rest.createChatMessage;
let postBlocked = false;
let releasePost: (() => void) | undefined;
const postAtDoor = new Promise<void>((resolve) => {
  releasePost = resolve;
});
platform.rest.createChatMessage = async (roomId, message, options) => {
  if (message.content === "late") {
    postBlocked = true;
    await postAtDoor;
  }
  return originalCreate.call(platform.rest, roomId, message, options);
};
const untilPostAtDoor = async (): Promise<void> => {
  for (let i = 0; i < 6000 && !postBlocked; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const handler = new GenericAdapter(async (args) => {
  await args.tools.sendMessage("late", ["@owner"]);
});
await runtime.start(handler);
await room.say(OWNER, `@[[${AGENT_ID}]] hello`);
await untilPostAtDoor();
const stopping = runtime.stop(50);
await new Promise((resolve) => setTimeout(resolve, 120));
const stateWhileDraining = runtime.state.status;
const startRefused = await runtime.start(new GenericAdapter(async () => undefined)).then(
  () => false,
  () => true,
);
const activateRefused = await new TurnJournal(dir4, AGENT_ID).activate(IDENTITY).then(
  () => false,
  () => true,
);
releasePost?.();
const stopResult = await stopping;
const finalState = runtime.state.status;
const journalFile = path.join(agentJournalDir(dir4, AGENT_ID), identityDirectoryComponent(IDENTITY), roomFileName("room-1"));
const records = readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).t);
say("## 10) runtime.stop(50) while the room's reply post is still in flight:");
say(`# runtime events observed: [${events.join(",")}]`);
say(`# while the stop times out, the state is ${stateWhileDraining}; a new start is refused (${startRefused}) and activating the journal is refused (${activateRefused}).`);
for (const line of logLines.filter((line) => /lifecycle|stop|drain/i.test(line))) {
  say(`# ${line}`);
}
say(`# the stop returned ${stopResult} and the state is ${finalState}; the journal records the reply reached:`);
say(JSON.stringify(records));

process.stdout.write(out.join("\n") + "\n");
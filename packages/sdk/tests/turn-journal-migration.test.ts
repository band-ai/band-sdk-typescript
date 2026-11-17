import { appendFile, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JournalFileError } from "../src/runtime/journal/errors";
import { identityDirectoryComponent, roomFileComponent } from "../src/runtime/journal/records";
import { migrateTurnJournals, type MigrationBinding } from "../src/runtime/journal/migration";
import { TurnJournal, agentJournalDir, legacyAgentDir } from "../src/runtime/journal/TurnJournal";
import { tmpRoot } from "./testUtils";
import { AGENT, IDENTITY, ROOM, legacyRoomFile, recordTypes, roomFile, seedLegacyFile } from "./turnJournalSupport";

const V1_ROOM_FILE = legacyRoomFile(ROOM);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One agent's legacy file, its hash, and a binding attesting `identity` for the room the file name encodes. */
async function seedAgent(
  dir: string,
  legacy: Record<string, string[]>,
  identities: Record<string, string> = {},
  rooms: Record<string, string> = {},
): Promise<{ bindings: MigrationBinding[] }> {
  const bindings: MigrationBinding[] = [];
  for (const [fileName, lines] of Object.entries(legacy)) {
    const source = await seedLegacyFile(dir, AGENT, fileName, lines);
    bindings.push({
      sourceFile: fileName,
      roomId: rooms[fileName] ?? (fileName.endsWith(".jsonl") ? decodeURIComponent(fileName.slice(0, -6)) : fileName),
      sourceSha256: sha256(await readFile(source, "utf8")),
      platformIdentity: identities[fileName] ?? IDENTITY,
      provenance: `operator-attested:${fileName}`,
    });
  }
  return { bindings };
}

describe("migrateTurnJournals preview", () => {
  it("reports what a migration would do, writing nothing", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await seedLegacyFile(dir, AGENT, "other-room.jsonl", [JSON.stringify({ t: "reply.intent", messageId: "x", at: 1 })]);

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, bindings });
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") return;
    expect(result.sources.map((source) => source.sourceFile).sort()).toEqual(["other-room.jsonl", V1_ROOM_FILE].sort());
    expect(result.unbound).toEqual(["other-room.jsonl"]);
    expect(result.sources.find((source) => source.sourceFile === V1_ROOM_FILE)).toMatchObject({ platformIdentity: IDENTITY, provenance: `operator-attested:${V1_ROOM_FILE}` });

    // The preview wrote nothing: no identity directories, no manifest, and the agent dir holds only the legacy files.
    const entries = await readdir(legacyAgentDir(dir, AGENT));
    expect(entries.sort()).toEqual(["other-room.jsonl", V1_ROOM_FILE].sort());
  });

  it("previews with no bindings as everything unbound", async () => {
    const dir = tmpRoot();
    await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })]);
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT });
    expect(result).toEqual({ mode: "preview", sources: expect.any(Array), unbound: [V1_ROOM_FILE] });
  });
});

describe("migrateTurnJournals apply", () => {
  it("stages each bound file under its identity, converts v1 records, and commits the manifest", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
      JSON.stringify({ t: "replies.reported", messageId: "a", at: 3 }),
    ];
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    if (result.mode !== "committed") return;

    const staged = roomFile(dir);
    const lines = (await readFile(staged, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM });
    expect(lines.slice(1).map((line) => String(line.t))).toEqual(["reply.intent", "reply.unknown", "turn.done"]);
    // The legacy intent's uncertainty is carried over, under a stable publication id.
    const intent = lines[1] as { publicationId: string };
    const unknown = lines[2] as { publicationId: string };
    expect(unknown.publicationId).toBe(intent.publicationId);
    expect(intent.publicationId).toBe(sha256(`${V1_ROOM_FILE}:a:1`));
    // `replies.reported` has no v2 meaning: it is dropped.
    expect(lines.some((line) => String(line.t) === "replies.reported")).toBe(false);

    // The original stands untouched, byte for byte.
    const original = path.join(legacyAgentDir(dir, AGENT), V1_ROOM_FILE);
    expect(await readFile(original, "utf8")).toBe(legacy.join("\n") + "\n");
    const manifest = JSON.parse(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8"));
    expect(manifest.state).toBe("committed");
    expect(manifest.bindings).toHaveLength(1);

    // A start over the committed migration runs, and the staged file is its authority.
    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
    expect(await room.recoverUnresolved()).toEqual([
      { messageId: "a", publicationId: intent.publicationId, outcome: "unknown", at: expect.any(Number) },
    ]);
    expect(await recordTypes(staged)).toEqual(["reply.intent", "reply.unknown", "turn.done", "publication.reported"]);
  });

  it("refuses to apply without a binding for every legacy file, naming the rest", async () => {
    const dir = tmpRoot();
    await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })]);
    await seedLegacyFile(dir, AGENT, "stray.jsonl", [JSON.stringify({ t: "turn.done", messageId: "n", at: 1 })]);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });

    const failed = migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    await expect(failed).rejects.toMatchObject({ kind: "corrupt" });
    await expect(failed).rejects.toThrow("stray.jsonl");
    // And it wrote nothing: no manifest, no identity directory.
    const entries = await readdir(legacyAgentDir(dir, AGENT));
    expect(entries.sort()).toEqual([V1_ROOM_FILE, "stray.jsonl"].sort());
  });

  it("refuses a binding that names a room other than the file's name encodes", async () => {
    const dir = tmpRoot();
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })]);
    const binding: MigrationBinding = {
      sourceFile: V1_ROOM_FILE,
      roomId: "another-room",
      sourceSha256: sha256(await readFile(source, "utf8")),
      platformIdentity: IDENTITY,
      provenance: "operator-attested",
    };
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [binding] }))
      .rejects.toThrow("names room another-room");
  });

  it("refuses a source that changed after the binding was made", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    // A legacy writer appends after the operator's attestation: the source no longer matches.
    await appendFile(path.join(legacyAgentDir(dir, AGENT), V1_ROOM_FILE), `${JSON.stringify({ t: "turn.done", messageId: "m2", at: 2 })}\n`);
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings })).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("refuses a legacy line it cannot parse or a record it does not know", async () => {
    const corrupt = [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 }), `{"t":"turn.done","messageId":"m"`];
    const dir = tmpRoot();
    await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, corrupt);
    await expect(
      migrateTurnJournals({
        journalDir: dir,
        agentId: AGENT,
        apply: true,
        bindings: [{ sourceFile: V1_ROOM_FILE, roomId: ROOM, sourceSha256: sha256(corrupt.join("\n") + "\n"), platformIdentity: IDENTITY, provenance: "operator-attested" }],
      }),
    ).rejects.toMatchObject({ kind: "corrupt" });

    const unknown = [JSON.stringify({ t: "a-newer-unknown", messageId: "m", at: 1 })];
    const dir2 = tmpRoot();
    await seedLegacyFile(dir2, AGENT, V1_ROOM_FILE, unknown);
    await expect(
      migrateTurnJournals({
        journalDir: dir2,
        agentId: AGENT,
        apply: true,
        bindings: [{ sourceFile: V1_ROOM_FILE, roomId: ROOM, sourceSha256: sha256(unknown.join("\n") + "\n"), platformIdentity: IDENTITY, provenance: "operator-attested" }],
      }),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("is a no-op with the same bindings once committed, and refuses different ones", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    const first = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(first.mode).toBe("committed");

    const again = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(again.mode).toBe("already-committed");

    const conflicting: MigrationBinding[] = [{ ...bindings[0], provenance: "a different attestation" }];
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: conflicting })).rejects.toBeInstanceOf(JournalFileError);
  });

  it("keeps records appended after the commit on a reapply, and reports nothing to do", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    // A process answers one more turn after the migration; its record stands on the journal.
    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    await (await generation.room(ROOM)).turnDone("later");
    const withLater = await readFile(roomFile(dir), "utf8");
    await generation.close();

    const again = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(again.mode).toBe("already-committed");
    // The reapply restages nothing: the appended record is still the authority's.
    expect(await readFile(roomFile(dir), "utf8")).toBe(withLater);
  });

  it("keeps a file a later legacy writer added unbound after the commit", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    await seedLegacyFile(dir, AGENT, "late.jsonl", [JSON.stringify({ t: "turn.done", messageId: "l", at: 1 })]);
    await expect(new TurnJournal(dir, AGENT).activate(IDENTITY)).rejects.toMatchObject({ kind: "unbound-legacy" });
  });

  it("binds several files to different identities under one agent", async () => {
    const dir = tmpRoot();
    const other = IDENTITY.replace("band.example", "other.example");
    const { bindings } = await seedAgent(
      dir,
      { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "a", at: 1 })], "other-room.jsonl": [JSON.stringify({ t: "turn.done", messageId: "b", at: 1 })] },
      { [V1_ROOM_FILE]: IDENTITY, "other-room.jsonl": other },
      { [V1_ROOM_FILE]: ROOM, "other-room.jsonl": "other-room" },
    );
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    const entries = new Set(await readdir(agentJournalDir(dir, AGENT), { withFileTypes: true }).then(async (list) => list.map((entry) => entry.name)));
    expect(entries).toContain(identityDirectoryComponent(IDENTITY));
    expect(entries).toContain(identityDirectoryComponent(other));
    const staged = path.join(agentJournalDir(dir, AGENT), identityDirectoryComponent(other), `${roomFileComponent("other-room")}.jsonl`);
    expect((await readFile(staged, "utf8")).split("\n").filter(Boolean)[0]).toContain(`"platformIdentity":"${other}"`);
  });
});

describe("migration phases survive interruption", () => {
  it("commits a prepared migration a crash left with its destination staged, keeping what stands", async () => {
    const dir = tmpRoot();
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, [JSON.stringify({ t: "turn.done", messageId: "old", at: 1 })]);
    const sourceSha256 = createHash("sha256").update(await readFile(source, "utf8")).digest("hex");
    const agentDir = agentJournalDir(dir, AGENT);
    const manifestDir = path.join(agentDir, "migration");
    await mkdir(manifestDir, { recursive: true });
    // The prepared manifest, exactly as the migration would have written it before staging.
    await writeFile(
      path.join(manifestDir, "manifest.json"),
      `${JSON.stringify({ v: 1, state: "prepared", createdAt: 1, bindings: [{ sourceFile: V1_ROOM_FILE, roomId: ROOM, sourceSha256, platformIdentity: IDENTITY, provenance: "crash" }] }, null, 2)}\n`,
    );
    // The destination already stands, as a crash after staging but before committing leaves it —
    // with a record an earlier process settled on it.
    const staged = roomFile(dir);
    await mkdir(path.dirname(staged), { recursive: true });
    const stood = `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n${JSON.stringify({ t: "turn.done", messageId: "old", at: 1 })}\n${JSON.stringify({ t: "reply.intent", messageId: "s", publicationId: "p", at: 2 })}\n${JSON.stringify({ t: "reply.settled", messageId: "s", publicationId: "p", at: 3 })}\n`;
    await writeFile(staged, stood);

    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await generation.room(ROOM);
    expect(room.answered("old")).toBe(true);
    // The re-staged nothing: the record the earlier process settled is still the authority's.
    expect(await readFile(staged, "utf8")).toBe(stood);
    const state = JSON.parse(await readFile(path.join(manifestDir, "manifest.json"), "utf8"));
    expect(state.state).toBe("committed");
    await generation.close();
  });

  it("refuses a start over a committed migration whose journal is gone, never an empty authority", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    // The committed journal's file is gone: its authority cannot be reopened as an empty file.
    await rm(roomFile(dir));
    await expect(new TurnJournal(dir, AGENT).activate(IDENTITY)).rejects.toMatchObject({ kind: "corrupt" });
  });
});
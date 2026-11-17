import { appendFile, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JournalFileError } from "../src/runtime/journal/errors";
import { identityDirectoryComponent, roomFileComponent } from "../src/runtime/journal/records";
import { migrateTurnJournals, type MigrationBinding } from "../src/runtime/journal/migration";
import { TurnJournal, agentJournalDir, legacyAgentDir } from "../src/runtime/journal/TurnJournal";
import { tmpRoot } from "./testUtils";
import { AGENT, IDENTITY, ROOM, generationIn, legacyRoomFile, recordTypes, roomFile, seedLegacyFile } from "./turnJournalSupport";

const V1_ROOM_FILE = legacyRoomFile(ROOM);

/** The name a v1 compaction crash left the output of `V1_ROOM_FILE` under. */
const V1_REMNANT_FILE = `${V1_ROOM_FILE}.${randomUUID()}.compacting`;

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
    const room = rooms[fileName] ?? (fileName.endsWith(".jsonl") ? decodeURIComponent(fileName.slice(0, -6)) : fileName);
    bindings.push({
      sourceFile: fileName,
      roomId: room,
      sourceSha256: sha256(await readFile(source, "utf8")),
      platformIdentity: identities[fileName] ?? IDENTITY,
      provenance: `operator-attested:${fileName}`,
    });
  }
  return { bindings };
}

/** The room a legacy file's name encodes, including a v1 compaction remnant's. */
function roomOfLegacyFile(fileName: string): string {
  const base = fileName.replace(/\.jsonl\..+\.compacting$/, ".jsonl");
  return decodeURIComponent(base.slice(0, -".jsonl".length));
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
    // The manifest records the import hash-bound: the staged file and its settlements.
    expect(manifest.bindings[0]).toMatchObject({
      sourceFile: V1_ROOM_FILE,
      stagesFrom: V1_ROOM_FILE,
      stagingSha256: sha256(legacy.join("\n") + "\n"),
      importedFacts: { publicationIds: [intent.publicationId], turnDone: ["b"] },
    });

    // A start over the committed migration runs, and the staged file is its authority.
    const { generation } = await generationIn(dir);
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

  it("commits a migration only once when two applies race for it: the other contends, or finds it committed", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    // Two applies for the same journal race: the ownership lock admits one at a
    // time, and a committed migration is not committed a second time.
    const results = await Promise.allSettled([
      migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }),
      migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }),
    ]);
    const outcomes = results.map((result) => (result.status === "fulfilled" ? result.value.mode : result.reason instanceof Error ? `error: ${result.reason.message.split("\n")[0]}` : "unknown"));
    const committed = results.filter((result) => result.status === "fulfilled" && result.value.mode === "committed").length;
    // Exactly one apply commits; the other contends for the ownership it never gets,
    // or acquires it after the commit and reports the migration already made.
    expect(committed).toBe(1);
    const other = results.find((result) => !(result.status === "fulfilled" && result.value.mode === "committed"));
    if (other !== undefined) {
      expect(
        other.status === "fulfilled" ? other.value.mode === "already-committed" : other.reason instanceof JournalFileError || other.reason instanceof Error,
        `the losing apply must fail closed or find the commit: ${JSON.stringify(outcomes)}`,
      ).toBe(true);
    }
    // The journal stands on the one commit: its records are the room's authority.
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("m")).toBe(true);
  });

  it("keeps records appended after the commit on a reapply, and reports nothing to do", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    // A process answers one more turn after the migration; its record stands on the journal.
    const { generation } = await generationIn(dir);
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
    const sourceSha256 = sha256(await readFile(source, "utf8"));
    const agentDir = agentJournalDir(dir, AGENT);
    const manifestDir = path.join(agentDir, "migration");
    await mkdir(manifestDir, { recursive: true });
    // The prepared manifest, exactly as the migration would have written it before staging:
    // the import recorded hash-bound, so it stands as authority's record of itself.
    await writeFile(
      path.join(manifestDir, "manifest.json"),
      `${JSON.stringify({
        v: 2,
        state: "prepared",
        createdAt: 1,
        bindings: [
          {
            sourceFile: V1_ROOM_FILE,
            roomId: ROOM,
            sourceSha256,
            platformIdentity: IDENTITY,
            provenance: "crash",
            stagesFrom: V1_ROOM_FILE,
            stagingSha256: sourceSha256,
            importedFacts: { publicationIds: [], turnDone: ["old"] },
          },
        ],
      }, null, 2)}\n`,
    );
    // The destination already stands, as a crash after staging but before committing leaves it —
    // with a record an earlier process settled on it.
    const staged = roomFile(dir);
    await mkdir(path.dirname(staged), { recursive: true });
    const stood = `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n${JSON.stringify({ t: "turn.done", messageId: "old", at: 1 })}\n${JSON.stringify({ t: "reply.intent", messageId: "s", publicationId: "p", at: 2 })}\n${JSON.stringify({ t: "reply.settled", messageId: "s", publicationId: "p", at: 3 })}\n`;
    await writeFile(staged, stood);

    const { generation } = await generationIn(dir);
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

describe("migration identity and imported authority", () => {
  it("stages a noncanonical identity spelling under the canonical layout, bound canonically", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    // The binding names the deployment the runtime serves in a noncanonical spelling:
    // an explicit default port where the runtime's identity drops it.
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy }, { [V1_ROOM_FILE]: "https://band.example:443" });
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    if (result.mode !== "committed") return;
    expect(result.sources[0].platformIdentity).toBe(IDENTITY);

    // The staged journal stands where the runtime looks for the identity it serves,
    // bound to the canonical spelling — not to the spelling the operator typed.
    const staged = roomFile(dir);
    expect(JSON.parse((await readFile(staged, "utf8")).split("\n")[0])).toMatchObject({ t: "header", platformIdentity: IDENTITY });
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
  });

  it("refuses identities the runtime itself will not serve: a label, a credential URL, a query-token URL", async () => {
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    for (const identity of ["onprem:cluster-7", "https://user:token@band.example", "https://band.example?token=abc"]) {
      const dir = tmpRoot();
      const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
      const binding: MigrationBinding = {
        sourceFile: V1_ROOM_FILE,
        roomId: ROOM,
        sourceSha256: sha256(await readFile(source, "utf8")),
        platformIdentity: identity,
        provenance: "operator-attested",
      };
      // Staging a journal under an identity the runtime rejects would leave records it
      // can never read: the binding is refused, and nothing is written. The refusal
      // names the check that failed, never the identity it refused — a rejected
      // identity may carry credentials, and an error the operator greps must not
      // print them.
      let refusal = "";
      await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [binding] }).catch((error: unknown) => {
        refusal = error instanceof Error ? error.message : String(error);
      });
      expect(refusal, "the binding was not refused").not.toBe("");
      expect(refusal).toContain("the runtime will not serve");
      expect(refusal).not.toContain(identity);
      expect(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null)).toBeNull();
      expect(await readFile(roomFile(dir), "utf8").catch(() => null)).toBeNull();
    }
  });

  it("refuses a destination that stands by its header alone, with the imported settlements missing", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });
    // A destination whose header is right but which holds none of the source's records.
    const destination = roomFile(dir);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n`);

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
      .rejects.toMatchObject({ kind: "corrupt" });
    // It refused: the migration is not committed over a destination that lost its imported authority.
    const manifest = await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null);
    expect(manifest === null ? null : JSON.parse(manifest).state).toBe("prepared");
  });

  it("refuses a header-only destination whether or not the preserved source still stands", async () => {
    const headerOnly = `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n`;
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];

    // The destination is replaced by its header: the imported settlements are gone, and the
    // import the migration recorded — hash-bound in its manifest — stands whether the
    // preserved source is still there or not.
    for (const sourceFate of ["kept", "removed", "emptied"] as const) {
      const dir = tmpRoot();
      const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });
      await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
      const destination = roomFile(dir);
      const source = path.join(legacyAgentDir(dir, AGENT), V1_ROOM_FILE);
      await writeFile(destination, headerOnly);
      if (sourceFate === "removed") await rm(source);
      if (sourceFate === "emptied") await writeFile(source, "");

      // The destination cannot activate: it holds the import's header but not its settlements.
      await expect(new TurnJournal(dir, AGENT).activate(IDENTITY)).rejects.toMatchObject({ kind: "corrupt" });
      if (sourceFate === "kept") {
        // A reapply checks the destination against the import it recorded.
        await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
          .rejects.toThrow("stands by its header alone");
      } else {
        // With the source gone or changed, the binding itself can no longer be checked,
        // and that too is refused — never a silent downgrade of the destination's authority.
        await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
          .rejects.toBeInstanceOf(JournalFileError);
      }
    }
  });

  it("refuses a destination a runtime would refuse: a settlement for a reply it never began", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    // A destination that records a settlement whose intent it never holds: the
    // journal's own state machine rejects it, so the migration's must too.
    const destination = roomFile(dir);
    await writeFile(
      destination,
      `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n` +
        `${JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })}\n` +
        `${JSON.stringify({ t: "reply.settled", messageId: "m2", publicationId: "no-intent", at: 2 })}\n`,
    );
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings })).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("keeps a destination that holds the imported settlements and a later reply's records", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "a", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    const destination = roomFile(dir);
    const before = await readFile(destination, "utf8");
    // A later process answers another turn: its reply's intent and settlement stand on the journal.
    const later = `${JSON.stringify({ t: "reply.intent", messageId: "b", publicationId: "later-reply", at: 3 })}\n${JSON.stringify({ t: "reply.settled", messageId: "b", publicationId: "later-reply", at: 4 })}\n`;
    await appendFile(destination, later);

    // A reapply keeps the destination byte for byte: the imported settlements stand, and the
    // records an earlier process wrote after the import are not restaged away.
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("already-committed");
    expect(await readFile(destination, "utf8")).toBe(before + later);
  });

  it("activates a destination whose last append was torn: the journal's own recovery policy stands", async () => {
    const dir = tmpRoot();
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: [JSON.stringify({ t: "turn.done", messageId: "a", at: 1 })] });
    await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });

    // A process answers another turn and dies mid-append: its reply's intent is
    // durable, its settlement append is a torn tail.
    const destination = roomFile(dir);
    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await generation.room(ROOM);
    await room.beginReply("b");
    await generation.close();
    await appendFile(destination, `{"t":`);

    // The journal's reader recovers the intent the torn tail left behind; the
    // migration's validation stands on that same policy, so the destination
    // activates and the unresolved publication is recovered on admission.
    const restarted = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const revived = await restarted.room(ROOM);
    expect(await revived.recoverUnresolved()).toEqual([
      expect.objectContaining({ messageId: "b", outcome: "pending" }),
    ]);
    expect(room.answered("a")).toBe(true);
    await restarted.close();
  });
});

describe("v1 compaction remnants", () => {
  it("treats a remnant that stands byte-identical to its journal as the journal it is, binding without a second staging", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // The compaction wrote its output and died before the rename: the two files stand byte-identical.
    await writeFile(path.join(path.dirname(source), V1_REMNANT_FILE), await readFile(source, "utf8"));
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    // The duplicate compaction output is not a separate authority: the preview
    // reports nothing unbound, and the migration stages the journal once.
    const preview = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, bindings });
    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") return;
    expect(preview.unbound).toEqual([]);

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    // A start over the committed migration runs: the remnant stands bound with its
    // journal, and no operator is asked to delete it.
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
  });

  it("refuses to stage a remnant's journal when only the remnant is attested", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    await writeFile(path.join(path.dirname(source), V1_REMNANT_FILE), await readFile(source, "utf8"));
    // The operator attests the copy they found; the journal the copy was staged from stands
    // unattested. Staging from an unattested file would write authority from what the
    // operator has not checked, so the migration refuses and names the journal.
    const remnantSource = path.join(path.dirname(source), V1_REMNANT_FILE);
    const binding: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(await readFile(remnantSource, "utf8")),
      platformIdentity: IDENTITY,
      provenance: "operator-attested",
    };
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [binding] }))
      .rejects.toThrow(`${V1_ROOM_FILE}`);
    // The preview shows what is still unbound.
    const preview = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, bindings: [binding] });
    if (preview.mode === "preview") expect(preview.unbound).toEqual([V1_ROOM_FILE]);
  });

  it("binds both a journal and its remnant when they attest the same provenance, staging the room once", async () => {
    const dir = tmpRoot();
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    await writeFile(path.join(path.dirname(source), V1_REMNANT_FILE), await readFile(source, "utf8"));
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy }, {}, { [V1_ROOM_FILE]: ROOM });
    const remnant: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(await readFile(path.join(path.dirname(source), V1_REMNANT_FILE), "utf8")),
      platformIdentity: IDENTITY,
      provenance: `operator-attested:${V1_ROOM_FILE}`,
    };
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [...bindings, remnant] });
    expect(result.mode).toBe("committed");
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
  });

  it("refuses a journal and its remnant attested to different platforms", async () => {
    const dir = tmpRoot();
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    await writeFile(path.join(path.dirname(source), V1_REMNANT_FILE), await readFile(source, "utf8"));
    const other = IDENTITY.replace("band.example", "other.example");
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy }, { [V1_ROOM_FILE]: IDENTITY }, { [V1_ROOM_FILE]: ROOM });
    const remnant: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(await readFile(path.join(path.dirname(source), V1_REMNANT_FILE), "utf8")),
      platformIdentity: other,
      provenance: "a different attestation",
    };
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [...bindings, remnant] })).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("carries a remnant that differs from its journal with the journal: the journal's records are the room's authority", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "reply.intent", messageId: "a", at: 1 }),
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // A compaction that filtered records before it died: its output is not the journal's bytes.
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, `${legacy[1]}\n`);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    // The journal keeps every record the copy holds, so the copy is covered by the
    // journal's binding; both files stand untouched, and the room's authority is the journal's.
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    expect(await readFile(source, "utf8")).toBe(legacy.join("\n") + "\n");
    expect(await readFile(compacting, "utf8")).toBe(`${legacy[1]}\n`);
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
  });

  it("refuses a settlement only the unbound compaction copy holds: the name carries no attestation", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // The copy holds a settlement the journal on disk no longer records, but
    // nothing binds the copy: importing it under the journal's identity would
    // let any file the room name names stand as the room's authority.
    const copy = `${legacy.join("\n")}\n${JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 })}\n`;
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, copy);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
      .rejects.toMatchObject({ kind: "corrupt" });
    // It refused before staging: no manifest, no destination, both files untouched.
    expect(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(roomFile(dir), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(source, "utf8")).toBe(`${legacy.join("\n")}\n`);
    expect(await readFile(compacting, "utf8")).toBe(copy);
  });

  it("imports a settlement only the compaction copy holds, under a binding of the copy's own", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    const copyText = `${legacy.join("\n")}\n${JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 })}\n`;
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, copyText);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });
    // The copy's surplus stands attested by a binding of its own: its hash, the
    // platform the room stands on, its provenance, and the room its name encodes.
    // The copy is the journal's output: it attests the same provenance the
    // journal's binding carries, or the two would stand at odds.
    bindings.push({
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(copyText),
      platformIdentity: IDENTITY,
      provenance: `operator-attested:${V1_ROOM_FILE}`,
    });

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    // Both files stand byte for byte, and the staging coalesced the copy's extra
    // settlement into the room's authority under its attested identity.
    expect(await readFile(source, "utf8")).toBe(`${legacy.join("\n")}\n`);
    expect(await readFile(compacting, "utf8")).toBe(copyText);
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
    // The copy-only settlement stands answered in the destination: a restart does
    // not answer it again.
    expect(room.answered("only-in-copy")).toBe(true);
  });

  it("refuses a copy it cannot verify: an interior line that is not a record", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // A copy that is not a journal a v1 writer could have left stands verified by
    // no one: the journal's name does not cover it, and the binding is refused.
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, `${legacy.join("\n")}\n{not-a-record}\n`);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
      .rejects.toMatchObject({ kind: "corrupt" });
    // It refused before staging: no manifest, no destination, both files untouched.
    expect(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(roomFile(dir), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(source, "utf8")).toBe(`${legacy.join("\n")}\n`);
  });

  it("stands a copy its writer cut off mid-line: the torn tail holds no authority", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // The copy's writer died mid-record: its last line is a fragment, the way the
    // journal's own reader treats a torn tail — the finished records stand.
    const torn = JSON.stringify({ t: "turn.done", messageId: "cut", at: 3 }).slice(0, 8);
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, `${legacy.join("\n")}\n${torn}`);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    // The finished record stands; the fragment never became a settlement.
    expect(room.answered("b")).toBe(true);
    expect(room.answered("cut")).toBe(false);
    await generation.close();
    // A reapply stands on the same reading: the torn tail is not authority.
    const again = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(again.mode).toBe("already-committed");
  });

  it("binds a remnant whose journal is gone as the room's authority in its own right", async () => {
    const dir = tmpRoot();
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const source = await seedLegacyFile(dir, AGENT, V1_REMNANT_FILE, legacy);
    const binding: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(await readFile(source, "utf8")),
      platformIdentity: IDENTITY,
      provenance: "operator-attested",
    };
    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [binding] });
    expect(result.mode).toBe("committed");
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
  });

  it("refuses two journals gone for one room, each surviving as a remnant, to stand for it", async () => {
    const dir = tmpRoot();
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const first = await seedLegacyFile(dir, AGENT, V1_REMNANT_FILE, legacy);
    const second = `${V1_ROOM_FILE}.${randomUUID()}.compacting`;
    await seedLegacyFile(dir, AGENT, second, legacy);
    const firstBinding: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: roomOfLegacyFile(V1_REMNANT_FILE),
      sourceSha256: sha256(await readFile(first, "utf8")),
      platformIdentity: IDENTITY,
      provenance: "operator-attested",
    };
    const secondBinding: MigrationBinding = {
      sourceFile: second,
      roomId: roomOfLegacyFile(second),
      sourceSha256: sha256(await readFile(path.join(legacyAgentDir(dir, AGENT), second), "utf8")),
      platformIdentity: IDENTITY,
      provenance: "operator-attested",
    };
    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [firstBinding, secondBinding] })).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("refuses a binding whose expected hash is not the file's, whatever it stands for", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // A binding that attests a hash the file does not stand at is a lie, or a
    // file that moved: either way it may not stage, and an all-zero hash must be
    // no different from any other hash the file does not bear.
    const bindings: MigrationBinding[] = [
      {
        sourceFile: V1_ROOM_FILE,
        roomId: ROOM,
        sourceSha256: "0".repeat(64),
        platformIdentity: IDENTITY,
        provenance: "operator-attested:wrong-hash",
      },
    ];

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
      .rejects.toMatchObject({ kind: "corrupt" });
    expect(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null)).toBeNull();
  });

  it("refuses a complete record at the copy's end: no trailing newline does not make it torn", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    // The copy's last line is a finished record the importer does not know: a torn
    // tail is a fragment, but a record that parses whole is not torn, whether or
    // not its writer ended it with the newline.
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, `${legacy.join("\n")}\n${JSON.stringify({ t: "not.a.record", messageId: "x", at: 3 })}`);
    const { bindings } = await seedAgent(dir, { [V1_ROOM_FILE]: legacy });

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings }))
      .rejects.toMatchObject({ kind: "unsupported" });
  });

  it("stages a journal that ends without its newline beside a bound surplus copy", async () => {
    const dir = tmpRoot();
    const legacy = [
      JSON.stringify({ t: "turn.done", messageId: "b", at: 2 }),
    ];
    // The journal's writer closed without its trailing newline; the bound copy
    // ends with it. A reader that splits their concatenation at newlines would
    // splice the last record into a first and stage a record neither file holds.
    const agentDir = legacyAgentDir(dir, AGENT);
    await mkdir(agentDir, { recursive: true });
    const primary = path.join(agentDir, V1_ROOM_FILE);
    await writeFile(primary, legacy.join("\n")); // no trailing newline
    const copyText = `${legacy.join("\n")}\n${JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 })}\n`;
    const compacting = path.join(agentDir, V1_REMNANT_FILE);
    await writeFile(compacting, copyText);
    const bindings: MigrationBinding[] = [
      {
        sourceFile: V1_ROOM_FILE,
        roomId: ROOM,
        sourceSha256: sha256(await readFile(primary, "utf8")),
        platformIdentity: IDENTITY,
        provenance: `operator-attested:${V1_ROOM_FILE}`,
      },
      {
        sourceFile: V1_REMNANT_FILE,
        roomId: ROOM,
        sourceSha256: sha256(copyText),
        platformIdentity: IDENTITY,
        provenance: `operator-attested:${V1_ROOM_FILE}`,
      },
    ];

    const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
    expect(result.mode).toBe("committed");
    // The primary stands byte for byte, newline-less end and all.
    expect(await readFile(primary, "utf8")).toBe(legacy.join("\n"));
    expect(await readFile(compacting, "utf8")).toBe(copyText);
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
    expect(room.answered("only-in-copy")).toBe(true);
  });

  it("migrates a journal and its copies in any binding order, through the journal they are the output of", async () => {
    // A copy that arrives before the journal in the binding list used to anchor
    // the destination on the copy: a later copy was then paired against the
    // copy it was filed beside, which no copy is, and the migration refused a
    // set of attestations the journal-first order commits.
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const orderings: ReadonlyArray<readonly [number, number, number]> = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const ordering of orderings) {
      const dir = tmpRoot();
      const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
      const agentDir = path.dirname(source);
      const copyA = `${V1_ROOM_FILE}.${randomUUID()}.compacting`;
      const copyB = `${V1_ROOM_FILE}.${randomUUID()}.compacting`;
      const plain = `${legacy.join("\n")}\n`;
      const surplus = `${plain}${JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 })}\n`;
      await writeFile(path.join(agentDir, copyA), surplus);
      await writeFile(path.join(agentDir, copyB), plain);
      const files = [
        [V1_ROOM_FILE, plain],
        [copyA, surplus],
        [copyB, plain],
      ] as const;
      const bindings = ordering.map((index) => ({
        sourceFile: files[index][0],
        roomId: roomOfLegacyFile(files[index][0]),
        sourceSha256: sha256(files[index][1]),
        platformIdentity: IDENTITY,
        provenance: `operator-attested:${V1_ROOM_FILE}`,
      })) satisfies MigrationBinding[];

      const result = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
      expect(result.mode, `binding order [${ordering.join(", ")}]`).toBe("committed");
      // The surplus the second copy holds stands answered under the journal,
      // whatever order the three attestations arrived in.
      const { generation } = await generationIn(dir);
      const room = await generation.room(ROOM);
      expect(room.answered("b")).toBe(true);
      expect(room.answered("only-in-copy")).toBe(true);
      await generation.close();
      // A reapply stands on the same committed migration.
      const again = await migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings });
      expect(again.mode).toBe("already-committed");
      // The migration reads the files it converts; all three stand untouched.
      expect(await readFile(path.join(agentDir, V1_ROOM_FILE), "utf8")).toBe(plain);
      expect(await readFile(path.join(agentDir, copyA), "utf8")).toBe(surplus);
      expect(await readFile(path.join(agentDir, copyB), "utf8")).toBe(plain);
    }
  });

  it("refuses an expected hash the bound copy does not stand at, beside a valid journal binding", async () => {
    const dir = tmpRoot();
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const source = await seedLegacyFile(dir, AGENT, V1_ROOM_FILE, legacy);
    const copyText = `${legacy.join("\n")}\n${JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 })}\n`;
    const compacting = path.join(path.dirname(source), V1_REMNANT_FILE);
    await writeFile(compacting, copyText);
    // The journal's attestation is true; the copy's is not. The fold may not
    // ride the journal's binding past a hash the copy does not stand at.
    const journal: MigrationBinding = {
      sourceFile: V1_ROOM_FILE,
      roomId: ROOM,
      sourceSha256: sha256(`${legacy.join("\n")}\n`),
      platformIdentity: IDENTITY,
      provenance: `operator-attested:${V1_ROOM_FILE}`,
    };
    const copy: MigrationBinding = {
      sourceFile: V1_REMNANT_FILE,
      roomId: ROOM,
      sourceSha256: "0".repeat(64),
      platformIdentity: IDENTITY,
      provenance: `operator-attested:${V1_ROOM_FILE}`,
    };

    await expect(migrateTurnJournals({ journalDir: dir, agentId: AGENT, apply: true, bindings: [journal, copy] })).rejects.toMatchObject({ kind: "corrupt" });
    // It refused before staging: no manifest, no destination.
    expect(await readFile(path.join(agentJournalDir(dir, AGENT), "migration", "manifest.json"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(roomFile(dir), "utf8").catch(() => null)).toBeNull();
  });
});
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";

import { agentJournalDir, legacyAgentDir } from "./TurnJournal";
import { JournalFileError } from "./errors";
import { JournalOwnership } from "./ownership";
import { RoomJournal, hasErrorCode, rewriteFile } from "./RoomJournal";
import { identityDirectoryComponent, roomFileComponent } from "./records";
import { canonicalPlatformIdentity } from "./identity";

const MIGRATION_DIR = "migration";
const MANIFEST_FILE = "manifest.json";

export interface MigrationBinding {
  /** The legacy file under the agent's journal directory, by its file name. */
  sourceFile: string;
  /** The room the file's records belong to; the file's name encodes the same room, and the two must agree. */
  roomId: string;
  /** The exact SHA-256 of the source, so a changed original is refused, not imported. */
  sourceSha256: string;
  /** The platform identity the source's records belong to, attested by the operator. */
  platformIdentity: string;
  /** Where the operator attests the source came from: a deployment reference, backup label, or similar. */
  provenance: string;
}

/**
 * A binding as the migration records it: what the operator attested, plus what
 * the migration derived from it while the sources stood — the file whose
 * records are staged, its hash, and the settlements the staging imports. The
 * manifest is the durable record of the import, so a destination is checked
 * against it even when the preserved sources are no longer on disk.
 */
interface PreparedBinding extends MigrationBinding {
  /**
   * The file whose records the migration stages. It differs from `sourceFile`
   * only when the attested file is a v1 compaction copy whose journal still
   * stands: the journal is the room's authority, and the copy rides with it.
   */
  stagesFrom: string;
  /**
   * The SHA-256 of what the import staged: the journal's records plus the
   * extra records of any compaction copy beside it, as they stood when the
   * import was recorded.
   */
  stagingSha256: string;
  /** The settlements the staging imports: stable publication ids and settled turns. */
  importedFacts: ImportedFacts;
}

export interface ImportedFacts {
  /** The stable publication ids the migration wrote for the source's replies. */
  publicationIds: string[];
  /** The inbounds whose turn the source settled. */
  turnDone: string[];
}

export interface MigrationSourceReport {
  sourceFile: string;
  /** The source's SHA-256 as it stands on disk now. */
  sourceSha256: string;
  /** The binding that claims it, when `bindings` named it. */
  platformIdentity?: string;
  provenance?: string;
}

export type MigrationResult =
  | { mode: "preview"; sources: MigrationSourceReport[]; unbound: string[] }
  | { mode: "committed"; sources: MigrationSourceReport[] }
  | { mode: "already-committed"; sources: MigrationSourceReport[] };

export interface MigrateTurnJournalsOptions {
  /** The configured journal root the legacy files live under. */
  journalDir: string;
  /** The agent whose legacy files are migrated. */
  agentId: string;
  /** What each legacy file is; required in full for `apply: true`. */
  bindings?: MigrationBinding[];
  /** Default false: report what a migration would do, without writing anything. */
  apply?: boolean;
  /** A test seam supplying the `node:sqlite` module `apply` locks through. */
  loadSqlite?: () => Promise<Pick<typeof import("node:sqlite"), "DatabaseSync">>;
  now?: () => number;
  logger?: Logger;
}

const bindingSchema = z.strictObject({
  sourceFile: z.string().min(1),
  /** The room the file's records belong to; must name the room the file's own name encodes. */
  roomId: z.string().min(1),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  platformIdentity: z.string().min(1),
  provenance: z.string().min(1),
});

const manifestBindingSchema = bindingSchema.extend({
  stagesFrom: z.string().min(1),
  stagingSha256: z.string().regex(/^[0-9a-f]{64}$/),
  importedFacts: z.strictObject({
    publicationIds: z.array(z.string().min(1)),
    turnDone: z.array(z.string().min(1)),
  }),
});

const manifestSchema = z.strictObject({
  v: z.literal(2),
  state: z.enum(["prepared", "committed"]),
  createdAt: z.number(),
  committedAt: z.number().optional(),
  bindings: z.array(manifestBindingSchema),
});

type Manifest = z.infer<typeof manifestSchema>;

/** The v1 record types the importer converts; a line none of these knows is not imported. */
const legacyRecordSchema = z.looseObject({
  messageId: z.string(),
  at: z.number(),
  t: z.enum(["reply.intent", "turn.done", "replies.reported"]),
});

type LegacyRecord = z.infer<typeof legacyRecordSchema>;

function manifestPath(agentDir: string): string {
  return path.join(agentDir, MIGRATION_DIR, MANIFEST_FILE);
}

/** The agent's migration state: no manifest, one awaiting its commit, or one committed. */
export async function migrationState(agentDir: string): Promise<"none" | "prepared" | "committed"> {
  const text = await readFile(manifestPath(agentDir), "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (text === null) return "none";
  const manifest = parseManifest(text);
  if (manifest.state === "prepared" && manifest.bindings.length === 0) {
    throw new JournalFileError("The journal's migration manifest is prepared but binds no sources; it cannot be resumed.", "corrupt", manifestPath(agentDir));
  }
  return manifest.state;
}

function parseManifest(text: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JournalFileError("The journal's migration manifest is not readable JSON; it cannot be trusted or resumed.", "corrupt", manifestPath(""));
  }
  const check = manifestSchema.safeParse(json);
  if (!check.success) {
    throw new JournalFileError(`The journal's migration manifest is in a shape this version does not understand: ${check.error.issues.map((issue) => issue.message).join(", ")}.`, "unsupported", manifestPath(""));
  }
  return check.data;
}

async function readManifest(agentDir: string): Promise<Manifest | null> {
  const text = await readFile(manifestPath(agentDir), "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  return text === null ? null : parseManifest(text);
}

async function sha256File(file: string): Promise<string> {
  const text = await readFile(file);
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The name a pre-v2 process gave a crashed compaction's output: the room's
 * journal name with the writer's `<uuid>.compacting` suffix, as v1's rewrite
 * wrote it. A journal without that suffix is its own authority; one with it
 * is the copy the writer never renamed over its journal.
 */
const V1_REMNANT = /^(.+\.jsonl)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.compacting$/;

/** The journal a compaction copy is the unrenamed output of; `undefined` for a plain journal file. */
function remnantPrimaryOf(file: string): string | undefined {
  return V1_REMNANT.exec(file)?.[1];
}

async function legacyFiles(legacyDir: string): Promise<string[]> {
  const names = await readdir(legacyDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [] as Array<{ name: string; isFile: () => boolean }>;
    throw error;
  });
  return names
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".compacting")))
    .map((entry) => entry.name);
}

/**
 * Whether `file` is bound by a committed migration: a file a migration bound
 * is bound, and a compaction copy whose journal the migration bound rides with
 * it — the copy is not a separate authority, so it does not stand unbound.
 */
function fileIsBound(file: string, bound: Set<string>, legacy: string[]): boolean {
  if (bound.has(file)) return true;
  const primary = remnantPrimaryOf(file);
  return primary !== undefined && legacy.includes(primary) && bound.has(primary);
}

/** The agent's legacy files no committed migration bound: they may belong to any deployment. */
export async function unboundLegacyFiles(legacyDir: string, agentDir: string): Promise<string[]> {
  const [legacy, manifest] = await Promise.all([legacyFiles(legacyDir), readManifest(agentDir)]);
  if (manifest === null || manifest.state !== "committed") return legacy;
  const bound = new Set(manifest.bindings.map((binding) => binding.sourceFile));
  return legacy.filter((file) => !fileIsBound(file, bound, legacy));
}

/**
 * The room a legacy file's name encodes: v1 named the file
 * `encodeURIComponent(roomId).jsonl`, and a compaction that crashed mid-write
 * left its output at that name suffixed `<uuid>.compacting`, which encodes the
 * same room. A name that is not a valid percent-encoding was never written by
 * a v1 journal, so it encodes no room.
 */
function roomIdOfSourceFile(sourceFile: string): string | undefined {
  const name = remnantPrimaryOf(sourceFile) ?? path.basename(sourceFile);
  if (!name.endsWith(".jsonl")) return undefined;
  try {
    return decodeURIComponent(name.slice(0, -".jsonl".length));
  } catch {
    return undefined;
  }
}

/**
 * The platform identity the journal layout and header bind to, resolved to the
 * canonical HTTP(S) URL the runtime itself requires: a binding that names the
 * same deployment in another spelling (an explicit default port, a trailing
 * slash) stages where the runtime looks. Anything that is not a strict
 * canonical HTTP(S) URL — a label, a credential- or query-bearing URL — names
 * no deployment the runtime can serve, so the binding is refused: staging a
 * journal under an identity the runtime rejects would leave records the
 * runtime will never read.
 */
function normalizeIdentity(value: string, sourceFile: string, agentDir: string): string {
  try {
    return canonicalPlatformIdentity(value);
  } catch (error) {
    // The rejection names the check that failed, never the identity itself:
    // a refused identity may carry credentials, and an error the operator
    // greps must not print them.
    throw new JournalFileError(
      `A migration binding for ${sourceFile} names a platform identity the runtime will not serve: ${error instanceof Error ? error.message : String(error)}. The journal binds its layout and every header to that identity, and the runtime serves only strict canonical HTTP(S) URLs; attest an identity of that form.`,
      "corrupt",
      agentDir,
    );
  }
}

/** Where a binding's v2 journal lives: under the attested identity's directory, named by the room's id hash. */
function destinationOf(agentDir: string, binding: MigrationBinding): string {
  const identityDir = path.join(agentDir, identityDirectoryComponent(binding.platformIdentity));
  return path.join(identityDir, `${roomFileComponent(binding.roomId)}.jsonl`);
}

/**
 * The records a v1 compaction copy left behind, the way the runtime reads a
 * journal's tail: every whole line must parse to a record the importer knows.
 * A final line a crash cut short of its newline is a torn fragment only while
 * it is not a whole record — a complete record at the end of the file stands
 * whether or not its newline is there, and is held to the same rule as any
 * other line. A copy that holds anything else — a line that is not a record,
 * a record the importer does not know — stands verified by no one, and is
 * refused, not covered by the name of the journal beside it.
 */
function parseRemnantRecords(file: string, text: string): Array<{ line: string; record: LegacyRecord }> {
  const entries: Array<{ line: string; record: LegacyRecord }> = [];
  const check = (line: string, lineNumber: number, record: unknown): void => {
    const parsed = legacyRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new JournalFileError(
        `The compaction copy ${file} beside its journal holds a record at line ${lineNumber} the importer does not know (${line.slice(0, 120)}); it cannot be verified against the journal, so the journal's binding cannot carry it. Reconcile the copy against the v1 writer that produced it before migrating.`,
        "unsupported",
        file,
      );
    }
    entries.push({ line, record: parsed.data });
  };
  const lines = text.split("\n");
  const tornTail = text.endsWith("\n") ? null : (lines.pop() ?? null);
  lines.forEach((line, n) => {
    if (line.trim() === "") return;
    try {
      check(line, n + 1, JSON.parse(line));
    } catch (error) {
      if (error instanceof JournalFileError) throw error;
      throw new JournalFileError(
        `The compaction copy ${file} beside its journal holds a line that is not a record at line ${n + 1}; it cannot be verified against the journal, so the journal's binding cannot carry it. Reconcile the copy against the v1 writer that produced it before migrating.`,
        "corrupt",
        file,
      );
    }
  });
  if (tornTail !== null && tornTail.trim() !== "") {
    try {
      // A whole record at EOF, with or without its newline: it is a record,
      // and it is held to the record's rule — a record the importer does not
      // know is refused, not dropped.
      check(tornTail, lines.length + 1, JSON.parse(tornTail));
    } catch (error) {
      if (error instanceof JournalFileError) throw error;
      // A torn tail that is not a whole record: the records above stand.
    }
  }
  return entries;
}

/**
 * What the migration stages for a binding: the journal's own records, plus —
 * for every compaction copy that stands beside it — the records the copy
 * holds that the journal does not. A copy is the unrenamed output of a crash
 * of its journal's compaction: normally byte-identical to the journal's
 * records, and nothing more. Where it holds more — a settlement the journal
 * on disk no longer records — that settlement is authority of the copy's own,
 * and it stands attested only by a binding of its own (`explicitSources`); a
 * copy whose surplus is attested by no one is refused, not imported under
 * the journal beside it. Where the copy holds less, the journal stands whole.
 * The staged text is deterministic in the files as they stand, so its hash
 * is what the manifest records and what activation rechecks.
 */
async function coalescedStaging(
  legacyDir: string,
  binding: { sourceFile: string; stagesFrom: string },
  legacy: string[],
  explicitSources: Set<string>,
): Promise<{ text: string; records: LegacyRecord[] }> {
  const primary = binding.stagesFrom;
  const primaryPath = path.join(legacyDir, primary);
  const primaryText = await readFile(primaryPath, "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      throw new JournalFileError(
        `The journal ${primary} the migration stages ${binding.sourceFile} through is gone from the journal; its import can no longer be checked against it. Restore it from backup before re-running the migration.`,
        "io",
        primaryPath,
      );
    }
    throw error;
  });
  const primaryRecords = parseLegacyRecords(primary, primaryText);
  const coalesced: LegacyRecord[] = [];
  const surplusLines: string[] = [];
  const intentCounts = new Map<string, number>();
  const doneInbounds = new Set<string>();
  const admit = (record: LegacyRecord, line: string | undefined): void => {
    if (record.t === "reply.intent") intentCounts.set(record.messageId, (intentCounts.get(record.messageId) ?? 0) + 1);
    if (record.t === "turn.done") doneInbounds.add(record.messageId);
    coalesced.push(record);
    if (line !== undefined) surplusLines.push(line);
  };
  for (const record of primaryRecords) admit(record, undefined);
  // The copies in the order the journal directory lists them: the staging
  // must be the same whatever run computes it.
  for (const file of legacy.filter((candidate) => remnantPrimaryOf(candidate) === primary)) {
    const copyPath = path.join(legacyDir, file);
    const copyText = await readFile(copyPath, "utf8").catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (copyText === null) {
      // A copy gone since the directory read: it held no record this staging
      // can claim, and the hash check against what stood refuses it below.
      throw new JournalFileError(
        `The compaction copy ${file} beside the journal ${primary} is gone from the journal; the migration's staging can no longer be checked against what it held. Restore it from backup before re-running the migration.`,
        "io",
        copyPath,
      );
    }
    const entries = parseRemnantRecords(file, copyText);
    const localIntents = new Map<string, number>();
    let copySurplus = 0;
    for (const { line, record } of entries) {
      if (record.t === "reply.intent") {
        const n = (localIntents.get(record.messageId) ?? 0) + 1;
        localIntents.set(record.messageId, n);
        if (n > (intentCounts.get(record.messageId) ?? 0)) {
          admit(record, line);
          copySurplus++;
        }
        continue;
      }
      if (record.t === "turn.done" && !doneInbounds.has(record.messageId)) {
        admit(record, line);
        copySurplus++;
      }
    }
    if (copySurplus > 0 && !explicitSources.has(file)) {
      // The copy stands for settlements its journal no longer records; a
      // name is not an attestation, and the journal's binding does not cover
      // them.
      throw new JournalFileError(
        `The compaction copy ${file} beside the journal ${primary} holds records the journal does not; that authority stands on the copy alone, and no binding attests it. Bind the copy — its hash, identity and provenance — so the surplus stands attested, or reconcile it against the v1 writer that produced it.`,
        "corrupt",
        copyPath,
      );
    }
  }
  // The journal's text and the surplus are whole lines: where the journal
  // ends without its final newline, the boundary stands between the records,
  // never inside one. The originals are never rewritten.
  const base = primaryText.length === 0 || primaryText.endsWith("\n") ? primaryText : `${primaryText}\n`;
  return { text: base + surplusLines.map((line) => `${line}\n`).join(""), records: coalesced };
}

/**
 * The copy's records its journal's do not cover: an intent the journal
 * records fewer of, a turn.done the journal never recorded. The authority a
 * copy stands for on its own, beyond the journal beside it.
 */
function uncoveredRemnantRecords(primaryRecords: LegacyRecord[], copyRecords: LegacyRecord[]): number {
  const intentCounts = new Map<string, number>();
  const doneInbounds = new Set<string>();
  for (const record of primaryRecords) {
    if (record.t === "reply.intent") intentCounts.set(record.messageId, (intentCounts.get(record.messageId) ?? 0) + 1);
    if (record.t === "turn.done") doneInbounds.add(record.messageId);
  }
  const localIntents = new Map<string, number>();
  let uncovered = 0;
  for (const record of copyRecords) {
    if (record.t === "reply.intent") {
      const n = (localIntents.get(record.messageId) ?? 0) + 1;
      localIntents.set(record.messageId, n);
      if (n > (intentCounts.get(record.messageId) ?? 0)) uncovered++;
    } else if (record.t === "turn.done" && !doneInbounds.has(record.messageId)) {
      uncovered++;
    }
  }
  return uncovered;
}

/**
 * A staged destination must still be the journal it claims to be: a v2 file
 * bound to the binding's identity, agent and room, holding only records the
 * runtime accepts in a state the runtime's own state machine admits.
 *
 * And it must still hold what the migration imported from the binding's
 * source: the settlement facts the migration's manifest recorded, under the
 * stable publication ids the conversion gave them. Records appended since the
 * import (a settlement an earlier process recorded) stand alongside and are
 * preserved, never restaged away. The check stands on the manifest's record
 * of the import — hash-bound when the migration ran — so a destination that
 * stands by its header alone, with the imported settlements missing, is
 * refused even when the preserved source is no longer on disk to re-check
 * against.
 */
async function validateDestination(
  destination: string,
  binding: PreparedBinding,
  agentId: string,
  legacyDir: string | undefined,
  options: { checkSources: boolean },
  explicitSources: Set<string>,
): Promise<void> {
  // The destination stands the way the runtime's own reader stands it: the
  // journal's own open validates its header's identity, agent and room binding
  // and every whole record it holds, and its recovery policy decides what a
  // torn tail is worth — a whole record a crash left without its newline
  // stands, a torn tail that is no whole record does not. A parser here that
  // disagreed with that reader would let the migration commit a destination
  // the runtime then refuses to open, or the runtime would refuse a
  // destination the migration had accepted; the reader is the policy.
  await stat(destination).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      throw new JournalFileError(
        `The migration's destination for ${binding.sourceFile} is no longer on disk; its authority must not open as an empty file and settle no one. Restore the destination from backup, or re-run the migration from the preserved source.`,
        "corrupt",
        destination,
      );
    }
    throw error;
  });
  const journal = await RoomJournal.open(destination, {
    platformIdentity: binding.platformIdentity,
    agentId,
    roomId: binding.roomId,
  });
  try {
    for (const publicationId of binding.importedFacts.publicationIds) {
      if (journal.publication(publicationId) === undefined) {
        throw new JournalFileError(
          `The migration's destination for ${binding.sourceFile} stands by its header alone: the settlement its source recorded (publication ${publicationId}) is not in it, so the imported authority is lost. Restore the destination from backup, or re-run the migration from its preserved source.`,
          "corrupt",
          destination,
        );
      }
    }
    for (const messageId of binding.importedFacts.turnDone) {
      if (!journal.answered(messageId)) {
        throw new JournalFileError(
          `The migration's destination for ${binding.sourceFile} stands by its header alone: its source's turn ${messageId} settled, and the destination does not record it. Restore the destination from backup, or re-run the migration from the preserved source.`,
          "corrupt",
          destination,
        );
      }
    }
    if (legacyDir !== undefined && options.checkSources) {
      // The preserved sources must still be what the operator attested and
      // what the import was recorded from: a change since means the import no
      // longer describes them, and the migration runs again against what
      // stands.
      const legacy = await legacyFiles(legacyDir);
      const sourceFile = path.join(legacyDir, binding.sourceFile);
      const sourceSha256 = await sha256File(sourceFile).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      if (sourceSha256 === null) {
        throw new JournalFileError(
          `The migration's preserved source ${binding.sourceFile} is gone from the journal; the import it recorded can no longer be checked against it. Restore the source from backup before re-running the migration.`,
          "io",
          sourceFile,
        );
      }
      if (sourceSha256 !== binding.sourceSha256) {
        throw new JournalFileError(
          `The migration's source ${binding.sourceFile} no longer matches the hash its manifest recorded (observed ${sourceSha256}); it changed after the migration ran, so its import no longer describes it. Re-run the migration against the current file.`,
          "corrupt",
          sourceFile,
        );
      }
      // The staging may coalesce the journal's compaction copies: it is
      // checked against what the staging computes from the files as they
      // stand now, so a journal or a copy that moved since the import is
      // refused, not imported past.
      const staging = await coalescedStaging(legacyDir, binding, legacy, explicitSources);
      const stagingSha256 = createHash("sha256").update(staging.text).digest("hex");
      if (stagingSha256 !== binding.stagingSha256) {
        throw new JournalFileError(
          `The journal ${binding.stagesFrom} and the compaction copies beside it no longer match the import the migration recorded (observed ${stagingSha256}); they changed after the migration ran, so its import no longer describes them. Re-run the migration against the current files.`,
          "corrupt",
          path.join(legacyDir, binding.stagesFrom),
        );
      }
    }
  } finally {
    await journal.close();
  }
}

/**
 * Every destination a committed migration named must still stand and still be
 * the journal it committed: a start over a missing or untrustworthy
 * destination would otherwise open an empty file where an authority used to
 * be, and settle no one.
 */
export async function validateCommittedDestinations(agentDir: string, agentId: string): Promise<void> {
  const manifest = await readManifest(agentDir);
  if (manifest === null || manifest.state !== "committed") return;
  const explicit = new Set(manifest.bindings.map((binding) => binding.sourceFile));
  for (const binding of manifest.bindings) {
    const destination = destinationOf(agentDir, binding);
    const text = await readFile(destination, "utf8").catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (text === null) {
      throw new JournalFileError(
        `The migration committed ${binding.sourceFile} to a journal that is no longer on disk; its authority must not open as an empty file and settle no one. Restore the journal from backup, or re-run the migration from its preserved source.`,
        "corrupt",
        destination,
      );
    }
    await validateDestination(destination, binding, agentId, undefined, { checkSources: false }, explicit);
  }
}

function parseLegacyRecords(file: string, text: string): LegacyRecord[] {
  const records: LegacyRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new JournalFileError(
        `The legacy journal ${file} holds a line that is not a record at line ${i + 1}; it is corrupt, and importing it would guess at authority it does not hold. Restore it from a backup before migrating.`,
        "corrupt",
        file,
      );
    }
    const check = legacyRecordSchema.safeParse(json);
    if (!check.success) {
      throw new JournalFileError(
        `The legacy journal ${file} holds a record at line ${i + 1} the importer does not know (${line.slice(0, 120)}). Reconcile it against the SDK version that wrote it before migrating.`,
        "unsupported",
        file,
      );
    }
    records.push(check.data);
  }
  return records;
}

/** The v2 destination of one legacy file under one binding: a header binding it to the attested identity, then the file's records converted. Legacy intents keep their uncertainty — none of them was ever proven posted — and a valid turn.done settles its inbound without claiming any post. */
function convertLegacy(sourceFile: string, text: string, binding: MigrationBinding, agentId: string, headerAt: number): string {
  const records = parseLegacyRecords(path.join("<agent>", sourceFile), text);
  const roomId = binding.roomId;
  const lines: string[] = [
    `${JSON.stringify({ t: "header", v: 2, platformIdentity: binding.platformIdentity, agentId, roomId, at: headerAt })}\n`,
  ];
  const seenIntent = new Map<string, number>();
  const stableId = (messageId: string, n: number): string =>
    createHash("sha256").update(`${sourceFile}:${messageId}:${n}`).digest("hex");
  for (const record of records) {
    switch (record.t) {
      case "reply.intent": {
        const n = (seenIntent.get(record.messageId) ?? 0) + 1;
        seenIntent.set(record.messageId, n);
        const publicationId = stableId(record.messageId, n);
        lines.push(`${JSON.stringify({ t: "reply.intent", messageId: record.messageId, publicationId, at: record.at })}\n`);
        lines.push(`${JSON.stringify({ t: "reply.unknown", messageId: record.messageId, publicationId, at: record.at })}\n`);
        break;
      }
      case "turn.done":
        lines.push(`${JSON.stringify({ t: "turn.done", messageId: record.messageId, at: record.at })}\n`);
        break;
      case "replies.reported":
        break;
    }
  }
  return lines.join("");
}

/** The settlement facts the staging file imports: its stable publication ids and settled turns. */
function importedFactsOf(stagingFile: string, records: LegacyRecord[]): ImportedFacts {
  const publicationIds: string[] = [];
  const turnDone: string[] = [];
  const seen = new Map<string, number>();
  for (const record of records) {
    if (record.t === "reply.intent") {
      const n = (seen.get(record.messageId) ?? 0) + 1;
      seen.set(record.messageId, n);
      publicationIds.push(createHash("sha256").update(`${stagingFile}:${record.messageId}:${n}`).digest("hex"));
    } else if (record.t === "turn.done") {
      turnDone.push(record.messageId);
    }
  }
  return { publicationIds, turnDone };
}

/**
 * Makes the binding's v2 destination stand: if it already stands and is the
 * journal it claims, it is kept as is — records appended to it since the
 * migration (a settlement an earlier process recorded) are the current
 * authority, and restaging from the source would silently lose them. If it
 * does not stand, a prepared migration restages it from the preserved source
 * (a crash between the manifest's write and the file's); a committed
 * migration's missing destination is refused — its authority is gone, and
 * nothing here may guess it back.
 */
async function stageDestination(
  agentDir: string,
  legacyDir: string,
  agentId: string,
  binding: PreparedBinding,
  headerAt: number,
  state: "prepared" | "committed",
  logger: Logger,
  explicitSources: Set<string>,
): Promise<void> {
  const destination = destinationOf(agentDir, binding);
  const existing = await readFile(destination, "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing !== null) {
    await validateDestination(destination, binding, agentId, legacyDir, { checkSources: state === "committed" }, explicitSources);
    return;
  }
  if (state === "committed") {
    throw new JournalFileError(
      `The migration committed ${binding.sourceFile} to a journal that is no longer on disk; its authority must not be guessed back. Restore the journal from backup, or re-run the migration from the preserved source.`,
      "corrupt",
      destination,
    );
  }
  const legacy = await legacyFiles(legacyDir);
  const staging = await coalescedStaging(legacyDir, binding, legacy, explicitSources);
  const expected = convertLegacy(binding.stagesFrom, staging.text, binding, agentId, headerAt);
  await mkdir(path.dirname(destination), { recursive: true });
  await rewriteFile(destination, expected);
  logger.info("Migrated a legacy journal file", { source: binding.sourceFile, identity: binding.platformIdentity, provenance: binding.provenance });
}

/**
 * Records the manifest's state durably: the new bytes are written whole to a
 * copy, synced, and renamed over the old file — a crash leaves the previous
 * state or the new one, never a truncated manifest. The manifest is written
 * only after everything it asserts is already durable: the prepared state
 * lands before any destination is staged, the committed state only after
 * every destination stands.
 */
async function commitManifest(agentDir: string, manifest: Manifest, now: () => number): Promise<void> {
  const committed: Manifest = { ...manifest, state: "committed", committedAt: now() };
  await rewriteFile(manifestPath(agentDir), `${JSON.stringify(committed, null, 2)}\n`);
}

/**
 * Completes a prepared migration a crash left mid-commit, under the caller's
 * ownership: every source is re-verified by hash, every missing destination
 * is restaged from its preserved source (a destination that stands is kept —
 * it may hold records appended after the crash), and only then is the
 * manifest committed. It never initializes empty over a half-migrated journal.
 */
export async function resumeInterruptedMigration(
  agentDir: string,
  legacyDir: string,
  agentId: string,
  _identity: string,
  options: { now?: () => number; logger?: Logger; loadSqlite?: () => Promise<Pick<typeof import("node:sqlite"), "DatabaseSync">> } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? resolveLogger();
  const manifest = await readManifest(agentDir);
  if (manifest === null || manifest.state !== "prepared") {
    throw new JournalFileError("The journal's migration is not in a resumable prepared state.", "corrupt", manifestPath(agentDir));
  }
  for (const binding of manifest.bindings) {
    await checkSource(legacyDir, binding, logger);
  }
  for (const binding of manifest.bindings) {
    if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
    const explicit = new Set(manifest.bindings.map((binding) => binding.sourceFile));
    await stageDestination(agentDir, legacyDir, agentId, binding, manifest.createdAt, "prepared", logger, explicit);
  }
  await commitManifest(agentDir, manifest, now);
}

async function checkSource(legacyDir: string, binding: PreparedBinding, logger: Logger): Promise<void> {
  const source = path.join(legacyDir, binding.sourceFile);
  await stat(source).catch(() => {
    throw new JournalFileError(
      `The migration's source ${binding.sourceFile} is gone from the journal; its records cannot be re-staged. Restore the source from backup and re-run the migration.`,
      "io",
      source,
    );
  });
  const observed = await sha256File(source);
  if (observed !== binding.sourceSha256) {
    throw new JournalFileError(
      `The migration's source ${binding.sourceFile} no longer matches the hash its prepared manifest recorded (observed ${observed}); it changed after the migration began, so it is not staged. Re-run the migration against the current file.`,
      "corrupt",
      source,
    );
  }
  parseLegacyRecords(source, await readFile(source, "utf8"));
  logger.debug("Verified a migration source", { source: binding.sourceFile });
}

/**
 * Migrates an agent's legacy (v1) turn journals into v2 journals bound to the
 * platform identities their operator attests, offline: in an ordinary Node
 * script, with the agent's old writers stopped and auto-restart disabled,
 * because they do not honor the ownership lock the new journals hold.
 *
 * Preview is the default: it reports what `apply: true` would do, writing
 * nothing. Applying requires a complete, hash-verified binding for every
 * legacy file; the originals are preserved byte-for-byte. A compaction copy a
 * crashed v1 writer left beside its journal is bound with the journal it is
 * the unrenamed output of — the journal's records are the room's authority,
 * and the copy is not a second one; a copy whose journal is gone is authority
 * in its own right. The phases are durable in order — the prepared manifest,
 * each staged destination, then the committed manifest — so a crash at any
 * point leaves a state the next apply or start resumes: a destination that
 * stands is kept with whatever records it has since, and a committed
 * migration's missing destination is refused, never guessed back.
 */
export async function migrateTurnJournals(options: MigrateTurnJournalsOptions): Promise<MigrationResult> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? resolveLogger();
  const agentDir = agentJournalDir(options.journalDir, options.agentId);
  const legacyDir = legacyAgentDir(options.journalDir, options.agentId);
  const legacy = await legacyFiles(legacyDir);
  const bindings = await validateBindings(options.bindings ?? [], legacy, legacyDir, agentDir);
  const isBound = (file: string): boolean => fileIsBound(file, new Set(bindings.map((binding) => binding.sourceFile)), legacy);

  if (options.apply !== true) {
    return { mode: "preview", sources: await reportSources(legacyDir, legacy, bindings), unbound: legacy.filter((file) => !isBound(file)) };
  }

  const unbound = legacy.filter((file) => !isBound(file));
  if (unbound.length > 0) {
    throw new JournalFileError(
      `Applying the migration requires a binding — its platform identity and provenance — for every legacy file, and none covers: ${unbound.join(", ")}. ` +
        `Each of them may belong to any deployment this agent ever pointed at, and no record says which; bind them with the identity and provenance you can attest. ` +
        `The migration preserves every file it touches; start refuses to run over a file no binding attests until it is bound or is gone from the directory, and removing one discards the authority it holds.`,
      "corrupt",
      legacyDir,
    );
  }

  await mkdir(agentDir, { recursive: true });
  const ownership = await JournalOwnership.acquire(path.join(agentDir, ".ownership.sqlite"), { loadSqlite: options.loadSqlite });
  try {
    // The copies whose surplus stands imported are the ones the operator
    // attested by a binding of their own: a name beside a journal is not an
    // attestation.
    const explicit = new Set(bindings.map((binding) => binding.sourceFile));
    const prepared: PreparedBinding[] = [];
    for (const binding of bindings) {
      await checkSource(legacyDir, binding, logger);
      // What the import records is what the staging holds: the journal's own
      // records plus, where a compaction copy stands beside it, the records
      // the copy holds beyond them — settlements the journal on disk no
      // longer holds are the room's authority too, and they stand imported
      // only where a binding of their own attests the copy.
      const staging = await coalescedStaging(legacyDir, binding, legacy, explicit);
      prepared.push({
        ...binding,
        stagingSha256: createHash("sha256").update(staging.text).digest("hex"),
        importedFacts: importedFactsOf(binding.stagesFrom, staging.records),
      });
    }
    const existing = await readManifest(agentDir);
    if (existing !== null && existing.state === "committed") {
      if (!sameBindings(existing.bindings, prepared)) {
        throw new JournalFileError(
          "The agent's journal already has a committed migration with different bindings than this one applies; it is not overwritten. " +
            "Re-run with the committed migration's bindings, or reconcile the two operator attestations first.",
          "corrupt",
          manifestPath(agentDir),
        );
      }
      // Already committed: every destination that stands is kept exactly as it
      // stands — records appended since the commit are its authority — and the
      // migration reports that it needs nothing done.
      for (const binding of prepared) {
        if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
        await stageDestination(agentDir, legacyDir, options.agentId, binding, existing.createdAt, "committed", logger, explicit);
      }
      return { mode: "already-committed", sources: await reportSources(legacyDir, legacy, prepared) };
    }
    if (existing !== null) {
      // A prepared manifest from an earlier interrupted run: it must be this same set of bindings.
      if (!sameBindings(existing.bindings, prepared)) {
        throw new JournalFileError(
          "The agent's journal holds a prepared migration for different bindings than this one applies; an interrupted migration is resumed as prepared, not replaced. " +
            "Let it finish (re-run apply with its bindings), or reconcile the attestations first.",
          "corrupt",
          manifestPath(agentDir),
        );
      }
    }
    const manifest: Manifest = existing !== null ? existing : { v: 2, state: "prepared", createdAt: now(), bindings: prepared };
    if (existing === null) {
      // The prepared manifest is durable before any destination is staged: a
      // crash afterwards is a resume, never an empty initialization.
      await mkdir(path.join(agentDir, MIGRATION_DIR), { recursive: true });
      await rewriteFile(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const binding of prepared) {
      if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
      await stageDestination(agentDir, legacyDir, options.agentId, binding, manifest.createdAt, "prepared", logger, explicit);
    }
    await commitManifest(agentDir, manifest, now);
    return { mode: "committed", sources: await reportSources(legacyDir, legacy, prepared) };
  } finally {
    await ownership.release().catch(() => undefined);
  }
}

/**
 * Checks the operator's bindings against the agent's legacy files: every file
 * one of them names must be a legacy file, its room must be the room its name
 * encodes, its identity one the runtime can serve, and two of them must not
 * claim one file or one room's journal under conflicting attestations. A
 * compaction copy is checked as the journal it is the unrenamed output of:
 * where that journal stands, the copy is covered by the journal's binding, and
 * a copy bound beside its journal folds into it when the two attest the same
 * provenance, or is refused when they attest two.
 */
async function validateBindings(
  bindings: MigrationBinding[],
  legacy: string[],
  legacyDir: string,
  agentDir: string,
): Promise<PreparedBinding[]> {
  const claimed = new Map<string, MigrationBinding>();
  const destinations = new Map<string, MigrationBinding>();
  const normalized: PreparedBinding[] = [];
  for (const raw of bindings) {
    const check = bindingSchema.safeParse(raw);
    if (!check.success) {
      throw new JournalFileError(`A migration binding is invalid: ${check.error.issues.map((issue) => issue.message).join(", ")}.`, "corrupt", agentDir);
    }
    // The layout and the journal's header bind the canonical identity: a
    // noncanonical URL spelling names the same deployment the runtime serves,
    // and a binding that names anything the runtime cannot serve is refused.
    const binding: MigrationBinding = { ...check.data, platformIdentity: normalizeIdentity(check.data.platformIdentity, check.data.sourceFile, agentDir) };
    // A v1 compaction that crashed mid-write left its output at
    // `<journal>.jsonl.<uuid>.compacting`: the unrenamed form of that
    // journal's records, which the journal keeps in full. Where the journal
    // stands it is the room's one authority, and the copy is staged through
    // it; a copy whose journal is gone is authority in its own right.
    const remnantPrimary = remnantPrimaryOf(binding.sourceFile);
    const stagesFrom = remnantPrimary !== undefined && legacy.includes(remnantPrimary) ? remnantPrimary : binding.sourceFile;
    // A v1 file's name encodes its room; a binding that names another room would
    // stage the records under a journal whose header binds them elsewhere.
    const encoded = roomIdOfSourceFile(binding.sourceFile);
    if (encoded === undefined || encoded !== binding.roomId) {
      throw new JournalFileError(
        `A migration binding for ${binding.sourceFile} names room ${binding.roomId}, but the file's name ${encoded === undefined ? "encodes no room" : `encodes ${encoded}`} and the two must agree.`,
        "corrupt",
        agentDir,
      );
    }
    if (!legacy.includes(binding.sourceFile)) {
      throw new JournalFileError(
        `A migration binding names ${binding.sourceFile}, which is not a legacy file under the agent's journal directory; bindings name only the files it holds.`,
        "corrupt",
        agentDir,
      );
    }
    // The expected hash is the operator's attestation that this is the file
    // it means to migrate: it is checked against the file as it stands, for
    // every binding — a journal and each copy it names alike — before any of
    // them is folded into another's destination.
    {
      const sourceFile = path.join(legacyDir, binding.sourceFile);
      const observed = await sha256File(sourceFile);
      if (observed !== binding.sourceSha256) {
        throw new JournalFileError(
          `The binding for ${binding.sourceFile} expects the hash its attestation recorded (${binding.sourceSha256}), but the file stands at ${observed}; it changed since the attestation, or the attestation names a different file. Re-attest the binding against the file as it stands.`,
          "corrupt",
          sourceFile,
        );
      }
    }
    // One file has one provenance; two bindings for it agree or are a conflict.
    const claimingFile = claimed.get(binding.sourceFile);
    if (claimingFile !== undefined) {
      if (claimingFile.platformIdentity === binding.platformIdentity && claimingFile.provenance === binding.provenance) {
        continue;
      }
      throw new JournalFileError(
        `Two migration bindings claim ${binding.sourceFile} with different attestations (${claimingFile.platformIdentity} / ${binding.platformIdentity}); one file has one provenance.`,
        "corrupt",
        agentDir,
      );
    }
    claimed.set(binding.sourceFile, binding);
    // Two sources may not convert into one destination: it is one room's journal.
    const destination = `${identityDirectoryComponent(binding.platformIdentity)}/${roomFileComponent(binding.roomId)}`;
    const claimingRoom = destinations.get(destination);
    if (claimingRoom !== undefined) {
      // The fold is the journal-and-its-copy case: a compaction copy beside
      // the journal it is the output of, in any binding order. Anything
      // else that stands for the same room — two journals, two orphan copies —
      // is two authorities for one room, and one room's journal takes one
      // migration. The destination stands anchored on the journal where the
      // journal is bound, whatever order the attestations arrived in: a copy
      // that arrived first anchors the destination only until the journal it
      // is the output of arrives too, and later copies are paired against the
      // journal, not against the copy they were filed beside.
      const isCopyPair =
        remnantPrimaryOf(binding.sourceFile) === claimingRoom.sourceFile ||
        (remnantPrimaryOf(claimingRoom.sourceFile) !== undefined && remnantPrimaryOf(claimingRoom.sourceFile) === binding.sourceFile);
      // Two copies beside the journal they both stage through are pending that
      // journal's binding, whatever order they arrived in: one room's journal
      // is one authority, and the copies are its outputs. Copies whose journal
      // is gone stage through themselves, and two of them are two authorities.
      const stagesThrough = (file: string): string => {
        const primary = remnantPrimaryOf(file);
        return primary !== undefined && legacy.includes(primary) ? primary : file;
      };
      const bothPendingSamePrimary =
        stagesThrough(claimingRoom.sourceFile) !== claimingRoom.sourceFile &&
        stagesThrough(claimingRoom.sourceFile) === stagesThrough(binding.sourceFile);
      if ((isCopyPair || bothPendingSamePrimary) && claimingRoom.platformIdentity === binding.platformIdentity && claimingRoom.provenance === binding.provenance) {
        // The same room's journal, attested twice (a journal and the copy it
        // crashed from): one migration, staged through the journal. The
        // copy's attestation still stands in the migration: its surplus,
        // where it holds any, is imported only because it is bound.
        normalized.push({ ...binding, stagesFrom, stagingSha256: "", importedFacts: { publicationIds: [], turnDone: [] } });
        if (remnantPrimaryOf(claimingRoom.sourceFile) === binding.sourceFile) {
          destinations.set(destination, binding);
        }
        continue;
      }
      throw new JournalFileError(
        isCopyPair
          ? `Two bindings (${claimingRoom.sourceFile} and ${binding.sourceFile}) stand for the same room of the same platform with different attestations; one room's journal takes one migration.`
          : `Two bindings (${claimingRoom.sourceFile} and ${binding.sourceFile}) stand for the same room of the same platform, and neither is the compaction copy of the other; one room's journal takes one migration. Reconcile the two files before applying.`,
        "corrupt",
        agentDir,
      );
    }
    destinations.set(destination, binding);
    normalized.push({ ...binding, stagesFrom, stagingSha256: "", importedFacts: { publicationIds: [], turnDone: [] } });
  }
  // A compaction copy is its journal's output: where the journal is bound too,
  // the two attestations must agree, or the copy claims a platform the journal
  // binds the room to and the room's authority is two files apart.
  const byFile = new Map(normalized.map((binding) => [binding.sourceFile, binding]));
  for (const binding of normalized) {
    if (binding.stagesFrom === binding.sourceFile) continue;
    const primary = byFile.get(binding.stagesFrom);
    if (primary !== undefined && (primary.platformIdentity !== binding.platformIdentity || primary.provenance !== binding.provenance)) {
      throw new JournalFileError(
        `The journal ${binding.stagesFrom} and the copy ${binding.sourceFile} it crashed from are attested to different platforms (${primary.platformIdentity} vs ${binding.platformIdentity}); one room's records stand on one platform. Re-attest the two files before applying.`,
        "corrupt",
        agentDir,
      );
    }
  }
  // A compaction copy is its journal's output: where the journal is bound too,
  // the two attestations must agree, or the copy claims a platform the journal
  // binds the room to and the room's authority is two files apart. A copy
  // beside a bound journal that holds nothing its journal does not rides the
  // journal's binding; one that holds more stands for authority of its own,
  // and a filename attests nothing — it needs a binding of its own, or it is
  // reconciled away before the migration commits.
  const stagedPrimaries = new Set(normalized.map((binding) => binding.stagesFrom));
  const explicit = new Set(bindings.map((binding) => binding.sourceFile));
  const primaryRecordsCache = new Map<string, LegacyRecord[]>();
  for (const file of legacy) {
    const primary = remnantPrimaryOf(file);
    if (primary === undefined || !stagedPrimaries.has(primary)) continue;
    const text = await readFile(path.join(legacyDir, file), "utf8").catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (text === null) continue;
    const copyRecords = parseRemnantRecords(file, text).map((entry) => entry.record);
    if (explicit.has(file)) continue;
    let primaryRecords = primaryRecordsCache.get(primary);
    if (primaryRecords === undefined) {
      primaryRecords = parseLegacyRecords(primary, await readFile(path.join(legacyDir, primary), "utf8"));
      primaryRecordsCache.set(primary, primaryRecords);
    }
    if (uncoveredRemnantRecords(primaryRecords, copyRecords) > 0) {
      throw new JournalFileError(
        `The compaction copy ${file} beside the journal ${primary} holds records the journal does not; that authority stands on the copy alone, and no binding attests it. Bind the copy — its hash, identity and provenance — so the surplus stands attested, or reconcile it against the v1 writer that produced it.`,
        "corrupt",
        path.join(legacyDir, file),
      );
    }
  }
  return normalized;
}

async function reportSources(legacyDir: string, legacy: string[], bindings: Array<Pick<MigrationBinding, "sourceFile" | "platformIdentity" | "provenance">>): Promise<MigrationSourceReport[]> {
  const reports: MigrationSourceReport[] = [];
  for (const file of legacy) {
    const binding = bindings.find((candidate) => candidate.sourceFile === file);
    reports.push({
      sourceFile: file,
      sourceSha256: await sha256File(path.join(legacyDir, file)),
      ...(binding !== undefined ? { platformIdentity: binding.platformIdentity, provenance: binding.provenance } : {}),
    });
  }
  return reports;
}

function sameBindings(a: Array<Pick<PreparedBinding, "sourceFile" | "sourceSha256" | "platformIdentity" | "provenance">>, b: Array<Pick<PreparedBinding, "sourceFile" | "sourceSha256" | "platformIdentity" | "provenance">>): boolean {
  if (a.length !== b.length) return false;
  const key = (binding: Pick<PreparedBinding, "sourceFile" | "sourceSha256" | "platformIdentity" | "provenance">): string => `${binding.sourceFile}|${binding.sourceSha256}|${binding.platformIdentity}|${binding.provenance}`;
  const right = new Map(b.map((binding) => [binding.sourceFile, key(binding)]));
  return a.every((binding) => right.get(binding.sourceFile) === key(binding));
}
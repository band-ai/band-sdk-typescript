import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { asErrorMessage } from "../../core/coercion";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";

import { JournalFileError } from "./errors";
import { JournalOwnership, type JournalOwnershipOptions } from "./ownership";
import { RoomJournal, headerLine, rewriteFile } from "./RoomJournal";
import {
  JOURNAL_FILE_EXTENSION,
  OWNERSHIP_FILE,
  agentJournalDir,
  compactingCopyTarget,
  hasErrorCode,
  identityRoomFile,
  legacyAgentDir,
  readTextIfExists,
  sha256Hex,
  sha256HexSchema,
  toLine,
  type JournalRecord,
} from "./records";
import { canonicalPlatformIdentity } from "./identity";

const MIGRATION_DIR = "migration";
const MANIFEST_FILE = "manifest.json";
/** The manifest format this version writes and reads. */
const MANIFEST_VERSION = 2;
/** How much of an unknown record a refusal quotes. */
const UNKNOWN_RECORD_PREVIEW = 120;

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
  loadSqlite?: JournalOwnershipOptions["loadSqlite"];
  now?: () => number;
  logger?: Logger;
}

const bindingSchema = z.strictObject({
  sourceFile: z.string().min(1),
  /** The room the file's records belong to; must name the room the file's own name encodes. */
  roomId: z.string().min(1),
  sourceSha256: sha256HexSchema,
  platformIdentity: z.string().min(1),
  provenance: z.string().min(1),
});

const manifestBindingSchema = bindingSchema.extend({
  stagesFrom: z.string().min(1),
  stagingSha256: sha256HexSchema,
  importedFacts: z.strictObject({
    publicationIds: z.array(z.string().min(1)),
    turnDone: z.array(z.string().min(1)),
  }),
});

const manifestSchema = z.strictObject({
  v: z.literal(MANIFEST_VERSION),
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
  const text = await readTextIfExists(manifestPath(agentDir));
  return text === null ? null : parseManifest(text);
}

async function sha256File(file: string): Promise<string> {
  return sha256Hex(await readFile(file));
}

/**
 * The journal a compaction copy is the unrenamed output of; `undefined` for a
 * plain journal file. v1's rewrite named its copy as the journal does, so a
 * journal without the copy suffix is its own authority, and one with it is
 * the copy the writer never renamed over its journal.
 */
function remnantPrimaryOf(file: string): string | undefined {
  const target = compactingCopyTarget(file);
  return target?.endsWith(JOURNAL_FILE_EXTENSION) === true ? target : undefined;
}

/**
 * The file `file`'s records stage through: the journal a compaction copy is
 * the output of, where that journal stands; otherwise the file itself.
 */
function stagesFromOf(file: string, legacy: string[]): string {
  const primary = remnantPrimaryOf(file);
  return primary !== undefined && legacy.includes(primary) ? primary : file;
}

async function legacyFiles(legacyDir: string): Promise<string[]> {
  const names = await readdir(legacyDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [] as Array<{ name: string; isFile: () => boolean }>;
    throw error;
  });
  return names
    .filter((entry) => entry.isFile() && (entry.name.endsWith(JOURNAL_FILE_EXTENSION) || remnantPrimaryOf(entry.name) !== undefined))
    .map((entry) => entry.name);
}

/**
 * Whether `file` is bound by a committed migration: a file a migration bound
 * is bound, and a compaction copy whose journal the migration bound rides with
 * it — the copy is not a separate authority, so it does not stand unbound.
 */
function fileIsBound(file: string, bound: Set<string>, legacy: string[]): boolean {
  return bound.has(file) || bound.has(stagesFromOf(file, legacy));
}

/** The agent's legacy files no committed migration bound: they may belong to any deployment. */
async function unboundLegacyFiles(legacyDir: string, manifest: Manifest | null): Promise<string[]> {
  const legacy = await legacyFiles(legacyDir);
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
  if (!name.endsWith(JOURNAL_FILE_EXTENSION)) return undefined;
  try {
    return decodeURIComponent(name.slice(0, -JOURNAL_FILE_EXTENSION.length));
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
      `A migration binding for ${sourceFile} names a platform identity the runtime will not serve: ${asErrorMessage(error)}. The journal binds its layout and every header to that identity, and the runtime serves only strict canonical HTTP(S) URLs; attest an identity of that form.`,
      "corrupt",
      agentDir,
    );
  }
}

/** Where a binding's v2 journal lives: where the runtime opens the room under the attested identity. */
function destinationOf(agentDir: string, binding: Pick<MigrationBinding, "platformIdentity" | "roomId">): string {
  return identityRoomFile(agentDir, binding.platformIdentity, binding.roomId);
}

interface LegacyLine {
  line: string;
  record: LegacyRecord;
}

type LegacyLineProblem = "not-a-record" | "unknown-record";

function parseJsonLine(line: string): { json: unknown } | undefined {
  try {
    return { json: JSON.parse(line) };
  } catch {
    return undefined;
  }
}

/**
 * Where a v1 file can hold a torn fragment — the start of a record a failed
 * write cut short, which never parses and was never acknowledged. Any write
 * can leave one at the file's end; v1's appender also resumed after a failed
 * write on a fresh line, leaving its fragment inside the journal.
 */
type TornFragments = "tail" | "anywhere";

/**
 * A v1 file's records: every line must parse to a record the importer knows,
 * except a torn fragment where `torn` admits one, which is dropped as v1's
 * own reader dropped it. A complete record is held to the rule wherever it
 * stands, with or without its newline. `refusal` names a line that breaks it.
 */
function parseLegacyLines(
  text: string,
  torn: TornFragments,
  refusal: (problem: LegacyLineProblem, lineNumber: number, line: string) => JournalFileError,
): LegacyLine[] {
  const lines = text.split("\n");
  const entries: LegacyLine[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const parsed = parseJsonLine(line);
    if (parsed === undefined) {
      const fragmentMayStand = torn === "anywhere" || i === lines.length - 1;
      if (fragmentMayStand && line.startsWith("{")) return;
      throw refusal("not-a-record", i + 1, line);
    }
    const record = legacyRecordSchema.safeParse(parsed.json);
    if (!record.success) throw refusal("unknown-record", i + 1, line);
    entries.push({ line, record: record.data });
  });
  return entries;
}

/**
 * The records a v1 compaction copy left behind. A copy that holds anything
 * but records the importer knows stands verified by no one, and is refused,
 * not covered by the name of the journal beside it.
 */
function parseRemnantRecords(file: string, text: string): LegacyLine[] {
  return parseLegacyLines(text, "tail", (problem, lineNumber, line) =>
    problem === "not-a-record"
      ? new JournalFileError(
          `The compaction copy ${file} beside its journal holds a line that is not a record at line ${lineNumber}; it cannot be verified against the journal, so the journal's binding cannot carry it. Reconcile the copy against the v1 writer that produced it before migrating.`,
          "corrupt",
          file,
        )
      : new JournalFileError(
          `The compaction copy ${file} beside its journal holds a record at line ${lineNumber} the importer does not know (${line.slice(0, UNKNOWN_RECORD_PREVIEW)}); it cannot be verified against the journal, so the journal's binding cannot carry it. Reconcile the copy against the v1 writer that produced it before migrating.`,
          "unsupported",
          file,
        ),
  );
}

/** A v1 journal's records; a journal that holds anything else is refused, never guessed at. */
function parseLegacyJournal(file: string, text: string): LegacyLine[] {
  return parseLegacyLines(text, "anywhere", (problem, lineNumber, line) =>
    problem === "not-a-record"
      ? new JournalFileError(
          `The legacy journal ${file} holds a line that is not a record at line ${lineNumber}; it is corrupt, and importing it would guess at authority it does not hold. Restore it from a backup before migrating.`,
          "corrupt",
          file,
        )
      : new JournalFileError(
          `The legacy journal ${file} holds a record at line ${lineNumber} the importer does not know (${line.slice(0, UNKNOWN_RECORD_PREVIEW)}). Reconcile it against the SDK version that wrote it before migrating.`,
          "unsupported",
          file,
        ),
  );
}

function parseLegacyRecords(file: string, text: string): LegacyRecord[] {
  return parseLegacyJournal(file, text).map((entry) => entry.record);
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
  const primaryText = await readTextIfExists(primaryPath);
  if (primaryText === null) {
    throw new JournalFileError(
      `The journal ${primary} the migration stages ${binding.sourceFile} through is gone from the journal; its import can no longer be checked against it. Restore it from backup before re-running the migration.`,
      "io",
      primaryPath,
    );
  }
  const primaryLines = parseLegacyJournal(primary, primaryText);
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
  for (const { record } of primaryLines) admit(record, undefined);
  // Sorted by name, since listing order must not flip stagingSha256; attested
  // copies first, so an unattested one is judged against everything attested
  // whatever the names' order (it adds no lines, so the hash is unchanged).
  const copies = legacy.filter((candidate) => remnantPrimaryOf(candidate) === primary).sort();
  const remnants = [...copies.filter((file) => explicitSources.has(file)), ...copies.filter((file) => !explicitSources.has(file))];
  for (const file of remnants) {
    const copyPath = path.join(legacyDir, file);
    const copyText = await readTextIfExists(copyPath);
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
    const surplus = remnantSurplusRecords(intentCounts, doneInbounds, entries.map((entry) => entry.record));
    if (surplus.length > 0 && !explicitSources.has(file)) {
      // The copy stands for settlements its journal no longer records; a
      // name is not an attestation, and the journal's binding does not cover
      // them.
      throw unboundSurplusRemnantError(file, primary, copyPath);
    }
    const admitSurplus = new Set(surplus);
    for (const { line, record } of entries) {
      if (admitSurplus.has(record)) admit(record, line);
    }
  }
  // The staging is whole record lines: the journal's records, then the
  // surplus. A torn tail the reader dropped never reaches it, and the
  // originals are never rewritten.
  const lines = [...primaryLines.map((entry) => entry.line), ...surplusLines];
  return { text: lines.map((line) => `${line}\n`).join(""), records: coalesced };
}

/**
 * The copy's records a baseline (the journal, or the journal plus surplus
 * already admitted from earlier remnants) does not cover: an intent the
 * baseline records fewer of, a turn.done it never recorded.
 */
function remnantSurplusRecords(
  intentCounts: ReadonlyMap<string, number>,
  doneInbounds: ReadonlySet<string>,
  copyRecords: LegacyRecord[],
): LegacyRecord[] {
  const localIntents = new Map<string, number>();
  const surplus: LegacyRecord[] = [];
  for (const record of copyRecords) {
    if (record.t === "reply.intent") {
      const n = (localIntents.get(record.messageId) ?? 0) + 1;
      localIntents.set(record.messageId, n);
      if (n > (intentCounts.get(record.messageId) ?? 0)) surplus.push(record);
    } else if (record.t === "turn.done" && !doneInbounds.has(record.messageId)) {
      surplus.push(record);
    }
  }
  return surplus;
}

/** Refuse a compaction copy whose surplus stands with no binding of its own. */
function unboundSurplusRemnantError(file: string, primary: string, copyPath: string): JournalFileError {
  return new JournalFileError(
    `The compaction copy ${file} beside the journal ${primary} holds records the journal does not; that authority stands on the copy alone, and no binding attests it. Bind the copy — its hash, identity and provenance — so the surplus stands attested, or reconcile it against the v1 writer that produced it.`,
    "corrupt",
    copyPath,
  );
}

/**
 * A staged destination must open as the runtime opens it and still hold every
 * settlement the manifest recorded importing, so it never stands by its header
 * alone; records appended since stand alongside. `checkSources` also holds the
 * preserved sources to the hashes the import recorded.
 */
async function validateDestination(
  destination: string,
  binding: PreparedBinding,
  agentId: string,
  legacyDir: string | undefined,
  options: { checkSources: boolean },
  explicitSources: Set<string>,
): Promise<void> {
  // The runtime's own reader is the policy: a parser of our own could commit what it refuses.
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
      const stagingSha256 = sha256Hex(staging.text);
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
async function validateCommittedDestinations(agentDir: string, agentId: string, manifest: Manifest): Promise<void> {
  const explicit = new Set(manifest.bindings.map((binding) => binding.sourceFile));
  for (const binding of manifest.bindings) {
    await validateDestination(destinationOf(agentDir, binding), binding, agentId, undefined, { checkSources: false }, explicit);
  }
}

/**
 * The stable publication id a legacy intent becomes under migration: derived
 * from the staging file, the inbound, and which intent it is for that inbound,
 * so convert and imported-facts checks name the same publication.
 */
function stablePublicationId(sourceFile: string, messageId: string, n: number): string {
  return sha256Hex(`${sourceFile}:${messageId}:${n}`);
}

/**
 * A staging's legacy records as v2 records. Legacy intents keep their
 * uncertainty — none of them was ever proven posted — and a turn.done settles
 * its inbound without claiming any post.
 */
function convertRecords(stagingFile: string, records: LegacyRecord[]): JournalRecord[] {
  const intents = new Map<string, number>();
  return records.flatMap(({ t, messageId, at }): JournalRecord[] => {
    switch (t) {
      case "reply.intent": {
        const n = (intents.get(messageId) ?? 0) + 1;
        intents.set(messageId, n);
        const publicationId = stablePublicationId(stagingFile, messageId, n);
        return [{ t: "reply.intent", messageId, publicationId, at }, { t: "reply.unknown", messageId, publicationId, at }];
      }
      case "turn.done":
        return [{ t: "turn.done", messageId, at }];
      case "replies.reported":
        return [];
    }
  });
}

/** The settlement facts the staging file imports: its stable publication ids and settled turns. */
function importedFactsOf(stagingFile: string, records: LegacyRecord[]): ImportedFacts {
  const converted = convertRecords(stagingFile, records);
  return {
    publicationIds: converted.flatMap((record) => (record.t === "reply.intent" ? [record.publicationId] : [])),
    turnDone: converted.flatMap((record) => (record.t === "turn.done" ? [record.messageId] : [])),
  };
}

/**
 * Makes the binding's v2 destination stand. A destination that validates is
 * kept as is: records appended since staging are its authority. A missing
 * one is staged from the preserved sources while the migration is prepared,
 * and refused once it is committed. `restageIfInvalid` (an already-prepared
 * migration) restages a prepared destination that no longer matches its
 * import instead of refusing; a committed destination never restages.
 */
async function stageDestination(
  agentDir: string,
  legacyDir: string,
  agentId: string,
  binding: PreparedBinding,
  headerAt: number,
  state: Manifest["state"],
  logger: Logger,
  explicitSources: Set<string>,
  restageIfInvalid = false,
): Promise<void> {
  const destination = destinationOf(agentDir, binding);
  if ((await readTextIfExists(destination)) !== null) {
    try {
      await validateDestination(destination, binding, agentId, legacyDir, { checkSources: state === "committed" }, explicitSources);
      return;
    } catch (error) {
      if (!restageIfInvalid || !(error instanceof JournalFileError) || state !== "prepared") throw error;
      logger.warn("Restaging a prepared migration's destination that no longer matches its import", {
        destination,
        source: binding.sourceFile,
        kind: error.kind,
        reason: error.message,
      });
    }
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
  const converted = convertRecords(binding.stagesFrom, staging.records);
  await mkdir(path.dirname(destination), { recursive: true });
  await rewriteFile(destination, headerLine(binding.platformIdentity, agentId, binding.roomId, headerAt) + converted.map(toLine).join(""));
  logger.info("Migrated a legacy journal file", { source: binding.sourceFile, identity: binding.platformIdentity, provenance: binding.provenance });
}

/**
 * Refuses, before a prepared manifest first names them, destinations that
 * already stand and are not this import: a resumed prepare restages a
 * destination that fails validation, so a journal a v2 process wrote there
 * must never be named, or the next start would overwrite its settlements.
 * Destinations `named` by the manifest already were staged by this migration.
 */
async function refuseForeignDestinations(
  agentDir: string,
  legacyDir: string,
  agentId: string,
  bindings: PreparedBinding[],
  named: PreparedBinding[],
  explicitSources: Set<string>,
): Promise<void> {
  const staged = new Set(named.map((binding) => destinationOf(agentDir, binding)));
  for (const binding of bindings) {
    if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
    const destination = destinationOf(agentDir, binding);
    if (staged.has(destination) || (await readTextIfExists(destination)) === null) continue;
    try {
      await validateDestination(destination, binding, agentId, legacyDir, { checkSources: false }, explicitSources);
    } catch (error) {
      if (!(error instanceof JournalFileError)) throw error;
      throw new JournalFileError(
        `The destination for ${binding.sourceFile} already holds a journal this migration did not stage (${error.message}); a v2 process may have recorded settlements there, and the migration never overwrites them. Reconcile the legacy file against that journal before migrating.`,
        "corrupt",
        destination,
        error,
      );
    }
  }
}

/**
 * Records the manifest's state durably: the new bytes are written whole to a
 * copy, synced, and renamed over the old file — a crash leaves the previous
 * state or the new one, never a truncated manifest. The manifest is written
 * only after everything it asserts is already durable: the prepared state
 * lands before any destination is staged, the committed state only after
 * every destination stands.
 */
async function commitManifest(agentDir: string, manifest: Manifest, now: () => number): Promise<Manifest> {
  const committed: Manifest = { ...manifest, state: "committed", committedAt: now() };
  await rewriteFile(manifestPath(agentDir), `${JSON.stringify(committed, null, 2)}\n`);
  return committed;
}

/**
 * Refuses a start whose identity none of the migration's bindings attested:
 * opening under it would serve empty room journals beside the settled ones
 * staged under the attested identities.
 */
function assertStartIdentityAttested(manifest: Manifest, identity: string, agentDir: string): void {
  if (manifest.bindings.some((binding) => binding.platformIdentity === identity)) return;
  throw new JournalFileError(
    `This start's platform identity is not among the identities the journal's migration attested; ` +
      `opening under it would serve empty room journals while settled authority stands under the attested identities. ` +
      `Start with an attested identity, or re-run the migration with bindings for this identity.`,
    "corrupt",
    agentDir,
  );
}

/**
 * Completes a prepared migration a crash left mid-commit, under the caller's
 * ownership: every source is re-verified by hash, every missing destination
 * is restaged from its preserved source (a destination that stands is kept —
 * it may hold records appended after the crash), and only then is the
 * manifest committed. It never initializes empty over a half-migrated journal.
 */
async function resumeInterruptedMigration(agentDir: string, legacyDir: string, agentId: string, manifest: Manifest, now: () => number, logger: Logger): Promise<Manifest> {
  for (const binding of manifest.bindings) {
    await checkSource(legacyDir, binding, logger);
  }
  const explicit = new Set(manifest.bindings.map((binding) => binding.sourceFile));
  for (const binding of manifest.bindings) {
    if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
    // A prepared resume (an amend's crash included) restages a destination that fails validation.
    await stageDestination(agentDir, legacyDir, agentId, binding, manifest.createdAt, "prepared", logger, explicit, true);
  }
  return await commitManifest(agentDir, manifest, now);
}

/**
 * Refuses a start, under the caller's ownership, where the journal's migrated
 * authority is unsettled: a start identity the migration did not attest, a
 * prepared migration that cannot be resumed (one that can is committed here),
 * a committed destination that is missing or untrustworthy, or legacy files
 * no committed migration bound — they might belong to any deployment, and no
 * legacy record says which.
 */
export async function assertMigrationStartable(
  agentDir: string,
  legacyDir: string,
  agentId: string,
  identity: string,
  options: { now: () => number; logger: Logger },
): Promise<void> {
  let manifest = await readManifest(agentDir);
  if (manifest !== null) {
    assertStartIdentityAttested(manifest, identity, agentDir);
    if (manifest.state === "prepared") {
      manifest = await resumeInterruptedMigration(agentDir, legacyDir, agentId, manifest, options.now, options.logger);
    }
    await validateCommittedDestinations(agentDir, agentId, manifest);
  }
  const unbound = await unboundLegacyFiles(legacyDir, manifest);
  if (unbound.length > 0) {
    throw new JournalFileError(
      `This agent's journal holds legacy records (${unbound.join(", ")}) no offline migration has bound to a platform identity; ` +
        `they might belong to any deployment this agent ever pointed at. Run the exported migrateTurnJournals against them with their ` +
        `provenance before starting; it preserves what it binds and removes nothing. A file start will not run over until it is bound, ` +
        `or it is removed — removal discards whatever authority the file holds.`,
      "unbound-legacy",
      path.join(legacyDir, unbound[0]),
    );
  }
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
 * platform identities their operator attests. It runs offline, with the
 * agent's old writers stopped: they do not honor the ownership lock.
 *
 * Preview (the default) writes nothing. `apply: true` requires a
 * hash-verified binding for every legacy file and preserves the originals
 * byte-for-byte; a compaction copy stages through the journal it is the
 * output of, where that journal stands. The prepared manifest, each staged
 * destination, and the committed manifest are durable in that order, so a
 * crash leaves a state the next apply or start resumes. A prepared migration
 * accepts the same bindings or bindings that only add sources; any other
 * change, and any change after commit, is refused.
 */
export async function migrateTurnJournals(options: MigrateTurnJournalsOptions): Promise<MigrationResult> {
  const now = options.now ?? Date.now;
  const logger = resolveLogger(options.logger);
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
  const ownership = await JournalOwnership.acquire(path.join(agentDir, OWNERSHIP_FILE), { loadSqlite: options.loadSqlite });
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
        stagingSha256: sha256Hex(staging.text),
        importedFacts: importedFactsOf(binding.stagesFrom, staging.records),
      });
    }
    const existing = await readManifest(agentDir);
    if (existing === null && prepared.length === 0) {
      // Nothing to bind: a manifest attesting no identity would refuse every start.
      return { mode: "committed", sources: [] };
    }
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
    let manifest: Manifest;
    // Only a prepared manifest this migration already wrote may restage its
    // destinations; a first prepare refuses a destination it did not stage.
    const restageIfInvalid = existing !== null;
    if (existing !== null) {
      if (sameBindings(existing.bindings, prepared)) {
        manifest = existing;
      } else if (bindingsExtendPrepared(existing.bindings, prepared)) {
        await refuseForeignDestinations(agentDir, legacyDir, options.agentId, prepared, existing.bindings, explicit);
        manifest = { v: MANIFEST_VERSION, state: "prepared", createdAt: existing.createdAt, bindings: prepared };
        await mkdir(path.join(agentDir, MIGRATION_DIR), { recursive: true });
        await rewriteFile(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`);
      } else {
        throw new JournalFileError(
          "The agent's journal holds a prepared migration for different bindings than this one applies; an interrupted migration is resumed as prepared, not replaced. " +
            "Let it finish (re-run apply with its bindings), amend by binding additional sources its prepare lacked, or reconcile the attestations first.",
          "corrupt",
          manifestPath(agentDir),
        );
      }
    } else {
      // The prepared manifest is durable before any destination is staged: a
      // crash afterwards is a resume, never an empty initialization.
      await refuseForeignDestinations(agentDir, legacyDir, options.agentId, prepared, [], explicit);
      manifest = { v: MANIFEST_VERSION, state: "prepared", createdAt: now(), bindings: prepared };
      await mkdir(path.join(agentDir, MIGRATION_DIR), { recursive: true });
      await rewriteFile(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const binding of prepared) {
      if (binding.stagesFrom !== binding.sourceFile) continue; // folded into the journal it is the output of
      await stageDestination(agentDir, legacyDir, options.agentId, binding, manifest.createdAt, "prepared", logger, explicit, restageIfInvalid);
    }
    await commitManifest(agentDir, manifest, now);
    return { mode: "committed", sources: await reportSources(legacyDir, legacy, prepared) };
  } finally {
    await ownership.release().catch((error: unknown) => logger.warn("Failed to release the journal's ownership after a migration", { agentId: options.agentId, error }));
  }
}

/** A binding accepted for staging; its hash and imported facts are filled when the import runs. */
function pendingStaging(binding: MigrationBinding, stagesFrom: string): PreparedBinding {
  return { ...binding, stagesFrom, stagingSha256: "", importedFacts: { publicationIds: [], turnDone: [] } };
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
    const stagesFrom = stagesFromOf(binding.sourceFile, legacy);
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
    const destination = destinationOf(agentDir, binding);
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
      const claimingPrimary = remnantPrimaryOf(claimingRoom.sourceFile);
      const isCopyPair =
        remnantPrimaryOf(binding.sourceFile) === claimingRoom.sourceFile ||
        (claimingPrimary !== undefined && claimingPrimary === binding.sourceFile);
      // Two copies beside the journal they both stage through are pending that
      // journal's binding, whatever order they arrived in: one room's journal
      // is one authority, and the copies are its outputs. Copies whose journal
      // is gone stage through themselves, and two of them are two authorities.
      const claimingStagesFrom = stagesFromOf(claimingRoom.sourceFile, legacy);
      const bothPendingSamePrimary =
        claimingStagesFrom !== claimingRoom.sourceFile &&
        claimingStagesFrom === stagesFromOf(binding.sourceFile, legacy);
      if ((isCopyPair || bothPendingSamePrimary) && claimingRoom.platformIdentity === binding.platformIdentity && claimingRoom.provenance === binding.provenance) {
        // The same room's journal, attested twice (a journal and the copy it
        // crashed from): one migration, staged through the journal. The
        // copy's attestation still stands in the migration: its surplus,
        // where it holds any, is imported only because it is bound.
        normalized.push(pendingStaging(binding, stagesFrom));
        if (claimingPrimary === binding.sourceFile) {
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
    normalized.push(pendingStaging(binding, stagesFrom));
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
  // A copy beside a bound journal that holds nothing its journal does not rides
  // the journal's binding; one that holds more stands for authority of its own,
  // and a filename attests nothing — it needs a binding of its own, or it is
  // reconciled away before the migration commits.
  const explicit = new Set(normalized.map((binding) => binding.sourceFile));
  for (const stagesFrom of new Set(normalized.map((binding) => binding.stagesFrom))) {
    await coalescedStaging(legacyDir, { sourceFile: stagesFrom, stagesFrom }, legacy, explicit);
  }
  return normalized;
}

/** What the operator attested for one file: a resume or amend must keep it unchanged. */
type BindingAttestation = Pick<MigrationBinding, "sourceFile" | "sourceSha256" | "platformIdentity" | "provenance">;

async function reportSources(legacyDir: string, legacy: string[], bindings: BindingAttestation[]): Promise<MigrationSourceReport[]> {
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

function attestationKey(binding: BindingAttestation): string {
  return `${binding.sourceFile}|${binding.sourceSha256}|${binding.platformIdentity}|${binding.provenance}`;
}

/** Whether every attestation in `existing` stands unchanged in `next`. */
function keepsAttestations(existing: BindingAttestation[], next: BindingAttestation[]): boolean {
  const attested = new Map(next.map((binding) => [binding.sourceFile, attestationKey(binding)]));
  return existing.every((binding) => attested.get(binding.sourceFile) === attestationKey(binding));
}

function sameBindings(a: BindingAttestation[], b: BindingAttestation[]): boolean {
  return a.length === b.length && keepsAttestations(a, b);
}

/** Whether `next` keeps every attestation in `existing` and adds sources: an amend of a prepared migration. */
function bindingsExtendPrepared(existing: BindingAttestation[], next: BindingAttestation[]): boolean {
  return next.length > existing.length && keepsAttestations(existing, next);
}

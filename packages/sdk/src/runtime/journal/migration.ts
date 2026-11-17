import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";

import { identityDirectoryComponent } from "./records";
import { JournalOwnership } from "./ownership";
import { hasErrorCode, rewriteFile, syncDirectory } from "./RoomJournal";
import { JournalFileError } from "./errors";
import { canonicalPlatformIdentity } from "./identity";
import { agentJournalDir } from "./TurnJournal";

const MIGRATION_DIR = "migration";
const MANIFEST_FILE = "manifest.json";

export interface MigrationBinding {
  /** The legacy file under the agent's journal directory, by its file name. */
  sourceFile: string;
  /** The exact SHA-256 of the source, so a changed original is refused, not imported. */
  sourceSha256: string;
  /** The platform identity the source's records belong to, attested by the operator. */
  platformIdentity: string;
  /** Where the operator attests the source came from: a deployment reference, backup label, or similar. */
  provenance: string;
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
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  platformIdentity: z.string().min(1),
  provenance: z.string().min(1),
});

const manifestSchema = z.strictObject({
  v: z.literal(1),
  state: z.enum(["prepared", "committed"]),
  createdAt: z.number(),
  committedAt: z.number().optional(),
  bindings: z.array(bindingSchema),
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
    throw new JournalFileError(`The journal's migration manifest is in a shape this version does not understand: ${check.error.issues.map((i) => i.message).join(", ")}.`, "unsupported", manifestPath(""));
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

async function legacyFiles(agentDir: string): Promise<string[]> {
  const names = await readdir(agentDir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [] as Array<{ name: string; isFile: () => boolean }>;
    throw error;
  });
  return names
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".compacting")))
    .map((entry) => entry.name);
}

/** The agent's legacy files no committed migration bound: they may belong to any deployment. */
export async function unboundLegacyFiles(agentDir: string): Promise<string[]> {
  const [legacy, manifest] = await Promise.all([legacyFiles(agentDir), readManifest(agentDir)]);
  if (manifest === null || manifest.state !== "committed") return legacy;
  const bound = new Set(manifest.bindings.map((binding) => binding.sourceFile));
  return legacy.filter((file) => !bound.has(file));
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

/**
 * The v2 destination of one legacy file under one binding: a header binding
 * it to the attested identity, then the file's records converted. Legacy
 * intents keep their uncertainty — none of them was ever proven posted — and
 * a valid turn.done settles its inbound without claiming any post.
 */
function convertLegacy(sourceFile: string, text: string, binding: MigrationBinding, agentId: string, headerAt: number): string {
  const records = parseLegacyRecords(path.join("<agent>", sourceFile), text);
  const lines: string[] = [
    `${JSON.stringify({ t: "header", v: 2, platformIdentity: binding.platformIdentity, agentId, at: headerAt })}\n`,
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

async function stageDestination(
  agentDir: string,
  agentId: string,
  binding: MigrationBinding,
  headerAt: number,
  logger: Logger,
): Promise<void> {
  const identityDir = path.join(agentDir, identityDirectoryComponent(binding.platformIdentity));
  const sourceFile = path.join(agentDir, binding.sourceFile);
  const destination = path.join(identityDir, binding.sourceFile);
  const expected = convertLegacy(binding.sourceFile, await readFile(sourceFile, "utf8"), binding, agentId, headerAt);
  const actual = await readFile(destination, "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (actual === expected) return;
  if (actual !== null) {
    throw new JournalFileError(
      `The migration's destination for ${binding.sourceFile} under ${binding.platformIdentity} holds different content than the source converts to; a crash left it partial, or another writer touched it. Re-run the migration so it restages from the source.`,
      "corrupt",
      destination,
    );
  }
  await mkdir(identityDir, { recursive: true });
  await rewriteFile(destination, expected);
  logger.info("Migrated a legacy journal file", { source: binding.sourceFile, identity: binding.platformIdentity, provenance: binding.provenance });
}

async function commitManifest(agentDir: string, manifest: Manifest, now: () => number): Promise<void> {
  const committed: Manifest = { ...manifest, state: "committed", committedAt: now() };
  await writeFile(manifestPath(agentDir), `${JSON.stringify(committed, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await syncDirectory(path.join(agentDir, MIGRATION_DIR));
}

/** Completes a prepared migration a crash left mid-commit; it never initializes empty over one. */
export async function resumeInterruptedMigration(
  agentDir: string,
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
    await checkSource(agentDir, binding, logger);
  }
  for (const binding of manifest.bindings) {
    await stageDestination(agentDir, agentId, binding, manifest.createdAt, logger);
  }
  await commitManifest(agentDir, manifest, now);
}

async function checkSource(agentDir: string, binding: MigrationBinding, logger: Logger): Promise<void> {
  const source = path.join(agentDir, binding.sourceFile);
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
 * legacy file; the originals are preserved byte-for-byte, and a migration a
 * crash interrupts is resumed on the next apply or start, never reset.
 */
export async function migrateTurnJournals(options: MigrateTurnJournalsOptions): Promise<MigrationResult> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? resolveLogger();
  const agentDir = agentJournalDir(options.journalDir, options.agentId);
  const legacy = await legacyFiles(agentDir);
  const bindings = validateBindings(options.bindings ?? [], legacy, agentDir);

  if (options.apply !== true) {
    return { mode: "preview", sources: await reportSources(agentDir, legacy, bindings), unbound: legacy.filter((file) => !bindings.some((binding) => binding.sourceFile === file)) };
  }

  const unbound = legacy.filter((file) => !bindings.some((binding) => binding.sourceFile === file));
  if (unbound.length > 0) {
    throw new JournalFileError(
      `Applying the migration requires a binding — its platform identity and provenance — for every legacy file, and none covers: ${unbound.join(", ")}. ` +
        `Name what deployment each of them came from, or remove it only if you accept losing its authority.`,
      "corrupt",
      agentDir,
    );
  }

  const ownership = await JournalOwnership.acquire(path.join(agentDir, ".ownership.sqlite"), { loadSqlite: options.loadSqlite });
  try {
    for (const binding of bindings) {
      await checkSource(agentDir, binding, logger);
    }
    const existing = await readManifest(agentDir);
    if (existing !== null && existing.state === "committed") {
      if (!sameBindings(existing.bindings, bindings)) {
        throw new JournalFileError(
          "The agent's journal already has a committed migration with different bindings than this one applies; it is not overwritten. " +
            "Re-run with the committed migration's bindings, or reconcile the two operator attestations first.",
          "corrupt",
          manifestPath(agentDir),
        );
      }
      for (const binding of bindings) {
        await stageDestination(agentDir, options.agentId, binding, existing.createdAt, logger);
      }
      return { mode: "already-committed", sources: await reportSources(agentDir, legacy, bindings) };
    }
    if (existing !== null) {
      // A prepared manifest from an earlier interrupted run: it must be this same set of bindings.
      if (!sameBindings(existing.bindings, bindings)) {
        throw new JournalFileError(
          "The agent's journal holds a prepared migration for different bindings than this one applies; an interrupted migration is resumed as prepared, not replaced. " +
            "Let it finish (re-run apply with its bindings), or reconcile the attestations first.",
          "corrupt",
          manifestPath(agentDir),
        );
      }
    }
    const manifest: Manifest = existing !== null ? existing : { v: 1, state: "prepared", createdAt: now(), bindings };
    if (existing === null) {
      await mkdir(path.join(agentDir, MIGRATION_DIR), { recursive: true });
      await writeFile(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      await syncDirectory(path.join(agentDir, MIGRATION_DIR));
    }
    for (const binding of bindings) {
      await stageDestination(agentDir, options.agentId, binding, manifest.createdAt, logger);
    }
    await commitManifest(agentDir, manifest, now);
    return { mode: "committed", sources: await reportSources(agentDir, legacy, bindings) };
  } finally {
    await ownership.release().catch(() => undefined);
  }
}

function validateBindings(bindings: MigrationBinding[], legacy: string[], agentDir: string): MigrationBinding[] {
  const seen = new Set<string>();
  for (const raw of bindings) {
    const check = bindingSchema.safeParse(raw);
    if (!check.success) {
      throw new JournalFileError(`A migration binding is invalid: ${check.error.issues.map((issue) => issue.message).join(", ")}.`, "corrupt", agentDir);
    }
    const binding = check.data;
    canonicalPlatformIdentity(binding.platformIdentity);
    if (seen.has(binding.sourceFile)) {
      throw new JournalFileError(`Two migration bindings claim the same source file ${binding.sourceFile}; one file has one provenance.`, "corrupt", agentDir);
    }
    seen.add(binding.sourceFile);
    if (!legacy.includes(binding.sourceFile)) {
      throw new JournalFileError(
        `A migration binding names ${binding.sourceFile}, which is not a legacy file under the agent's journal directory; bindings name only the files it holds.`,
        "corrupt",
        agentDir,
      );
    }
  }
  return bindings;
}

async function reportSources(agentDir: string, legacy: string[], bindings: MigrationBinding[]): Promise<MigrationSourceReport[]> {
  const reports: MigrationSourceReport[] = [];
  for (const file of legacy) {
    const binding = bindings.find((candidate) => candidate.sourceFile === file);
    reports.push({
      sourceFile: file,
      sourceSha256: await sha256File(path.join(agentDir, file)),
      ...(binding !== undefined ? { platformIdentity: binding.platformIdentity, provenance: binding.provenance } : {}),
    });
  }
  return reports;
}

function sameBindings(a: MigrationBinding[], b: MigrationBinding[]): boolean {
  if (a.length !== b.length) return false;
  const key = (binding: MigrationBinding) => `${binding.sourceFile}|${binding.sourceSha256}|${binding.platformIdentity}|${binding.provenance}`;
  const right = new Map(b.map((binding) => [binding.sourceFile, key(binding)]));
  return a.every((binding) => right.get(binding.sourceFile) === key(binding));
}
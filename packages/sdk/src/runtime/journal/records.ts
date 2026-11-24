import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/** The only journal format this version reads and writes. */
export const JOURNAL_FORMAT_VERSION = 2;

/** The extension of a room's journal file, in v1's layout and v2's alike. */
export const JOURNAL_FILE_EXTENSION = ".jsonl";

/**
 * The file's first line: who the journal is bound to. The platform identity,
 * the agent, and the room are hashed into the path components the file lives
 * in; all three are kept whole here so a file moved or forged into another
 * identity's, agent's, or room's namespace is refused, not adopted.
 */
export const journalHeaderSchema = z.strictObject({
  t: z.literal("header"),
  v: z.literal(JOURNAL_FORMAT_VERSION),
  platformIdentity: z.string().min(1),
  agentId: z.string().min(1),
  roomId: z.string().min(1),
  at: z.number(),
});

export type JournalHeader = z.infer<typeof journalHeaderSchema>;

/** The SHA-256 of `value` (a string hashes as UTF-8), in hex. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** What {@link sha256Hex} returns. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The tool a keyed operation stood for. */
const operationKindSchema = z.enum(["send", "decline"]);

const recordBase = z.strictObject({ messageId: z.string(), at: z.number() });

/** Every keyed operation's record names the operation it stands for. */
const operationRecordBase = recordBase.extend({ operationId: z.string().min(1) });

/**
 * One room's v2 records. Publication records carry the `publicationId` the
 * SDK minted when the reply was admitted; `reply.settled` is the durable
 * proof a posted reply was acknowledged, and `decline.settled` / `turn.done`
 * settle the inbound without one.
 */
export const journalRecordSchema = z.discriminatedUnion("t", [
  /** A reply is about to begin posting; nothing yet says whether it will land. */
  recordBase.extend({ t: z.literal("reply.intent"), publicationId: z.string().min(1) }),
  /** Band acknowledged the reply; its receipt, if any, is stored with it. */
  recordBase.extend({ t: z.literal("reply.settled"), publicationId: z.string().min(1), receiptId: z.string().optional() }),
  /** Band answered and saved nothing: the reply is definitely not in the room. */
  recordBase.extend({ t: z.literal("reply.refused"), publicationId: z.string().min(1) }),
  /** Whether Band has the reply is unknown; it may already be in the room. */
  recordBase.extend({ t: z.literal("reply.unknown"), publicationId: z.string().min(1) }),
  /** The inbound's no-reply was accepted; it is answered and runs again never. */
  recordBase.extend({ t: z.literal("decline.settled") }),
  /** The inbound's turn ended and was marked processed; it is answered, with no post claimed. */
  recordBase.extend({ t: z.literal("turn.done") }),
  /** The publication's uncertainty was announced to the operator once. */
  recordBase.extend({ t: z.literal("publication.reported"), publicationId: z.string().min(1) }),
  /**
   * An explicit keyed operation (a send or a no-reply with an operation id)
   * was admitted: the fingerprint binds the payload it may stand for, and the
   * first caller's inbound is the message whose turn the operation ran in.
   */
  operationRecordBase.extend({
    t: z.literal("op.reserved"),
    fingerprint: sha256HexSchema,
    kind: operationKindSchema,
  }),
  /** The first send's resolved recipient identities, as the roster stood when the operation was admitted. */
  operationRecordBase.extend({
    t: z.literal("op.recipients"),
    recipients: z.array(z.string()),
  }),
  /** Band acknowledged the keyed send; its stored public result, if any, stands for every later same-id call. */
  operationRecordBase.extend({
    t: z.literal("op.settled"),
    receiptId: z.string().optional(),
    resultJson: z.string().optional(),
  }),
  /** The keyed operation definitely did not stand: Band refused the send, or the harness refused the no-reply. */
  operationRecordBase.extend({
    t: z.literal("op.refused"),
    reasonText: z.string().optional(),
  }),
  /** Whether Band has the keyed send is unknown: it may already be in the room. */
  operationRecordBase.extend({
    t: z.literal("op.unknown"),
  }),
  /** The operation's uncertainty was announced to the operator once. */
  operationRecordBase.extend({
    t: z.literal("op.reported"),
  }),
]);

export type JournalRecord = z.infer<typeof journalRecordSchema>;

/** One journal line: the header or a record, as the file stores it. */
export function toLine(record: JournalHeader | JournalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Whether `error` is a file system error with `code`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** `file`'s text, or `null` when it does not exist. */
export async function readTextIfExists(file: string): Promise<string | null> {
  return await readFile(file, "utf8").catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
}

/** The suffix a rewrite gives the copy it renames over its file: `<file>.<uuid>.compacting`. */
const COMPACTING_COPY_SUFFIX = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.compacting$/;

/** A fresh name for the copy a rewrite of `file` writes before renaming it over `file`. */
export function compactingCopyName(file: string): string {
  return `${file}.${randomUUID()}.compacting`;
}

/** The file a compaction copy was written to replace; `undefined` for a name that is no such copy. */
export function compactingCopyTarget(name: string): string | undefined {
  const suffix = COMPACTING_COPY_SUFFIX.exec(name);
  return suffix === null || suffix.index === 0 ? undefined : name.slice(0, suffix.index);
}

/** The agent's exclusive ownership lock file under its journal directory. */
export const OWNERSHIP_FILE = ".ownership.sqlite";

/** What a keyed operation stood for: a send or a no-reply. */
export type OperationKind = z.infer<typeof operationKindSchema>;

/** The directory component of an identity in the journal's file layout. */
export function identityDirectoryComponent(identity: string): string {
  return sha256Hex(identity);
}

/** The file-name component of a room id in the journal's file layout. Hashed, for the same reason as the agent's. */
export function roomFileComponent(roomId: string): string {
  return sha256Hex(roomId);
}

/**
 * The directory of one agent's v2 journal under `journalDir`. The agent id is
 * hashed, never percent-encoded: a caller-controlled id must not reach the
 * file system as a path component it can steer. The full id stands in every
 * file's header, which is what is validated on open.
 */
export function agentJournalDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, sha256Hex(agentId));
}

/**
 * The directory a pre-v2 (legacy) process of `agentId` journaled under. Kept
 * verbatim — percent-encoded, as the legacy layout wrote it — because that
 * is where legacy files actually live and where the migration reads them.
 */
export function legacyAgentDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, encodeURIComponent(agentId));
}

/** The name of `roomId`'s journal file: its id hashed, so the id cannot steer the path. */
export function roomFileName(roomId: string): string {
  return `${roomFileComponent(roomId)}${JOURNAL_FILE_EXTENSION}`;
}

/** The path of `roomId`'s v2 journal under the agent directory `agentDir`, in `identity`'s directory. */
export function identityRoomFile(agentDir: string, identity: string, roomId: string): string {
  return path.join(agentDir, identityDirectoryComponent(identity), roomFileName(roomId));
}

/** How one admitted reply stands: unposted-and-pending, or one terminal state. */
export type PublicationOutcome = "pending" | "settled" | "refused" | "unknown";

export interface PublicationState {
  outcome: PublicationOutcome;
  /** The receipt Band returned for the settled reply, when it gave one. */
  receiptId?: string;
  /** Whether its uncertainty was announced to the operator (durable via publication.reported). */
  reported: boolean;
  /** When its last record landed. */
  at: number;
}

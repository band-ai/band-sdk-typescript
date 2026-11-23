import { createHash } from "node:crypto";

import { z } from "zod";

/** The only journal format this version reads and writes. */
export const JOURNAL_FORMAT_VERSION = 2;

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

const recordBase = z.strictObject({ messageId: z.string(), at: z.number() });

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
]);

export type JournalRecord = z.infer<typeof journalRecordSchema>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The directory component of an identity in the journal's file layout. */
export function identityDirectoryComponent(identity: string): string {
  return sha256Hex(identity);
}

/**
 * The directory component of an agent id in the journal's file layout. It is
 * hashed, never percent-encoded: an agent id must not reach the file system
 * as a path component it can steer (dots, slashes, NULs). The full id stands
 * in every file's header, which is what is validated on open.
 */
export function agentDirectoryComponent(agentId: string): string {
  return sha256Hex(agentId);
}

/** The file-name component of a room id in the journal's file layout. Hashed, for the same reason. */
export function roomFileComponent(roomId: string): string {
  return sha256Hex(roomId);
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

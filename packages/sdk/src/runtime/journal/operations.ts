import { isDeepStrictEqual } from "node:util";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import type { MentionReference } from "../../contracts/dtos";
import { isToolExecutorError } from "../../contracts/protocols";
import { DeliveryFailedError, unknownDeliveryText } from "../../core/deliveryFailedError";
import { RoomExecutionStoppedError, statusCodeOf } from "../../core/errors";
import { OPERATION_ID_MAX_BYTES } from "../../contracts/toolSchemas";
import { sha256Hex, type OperationKind } from "./records";

/** The fingerprint layout's version: a layout change must not collide with this one. */
const FINGERPRINT_VERSION = 1;

type OperationIdIssue = "empty" | "too-long" | "not-a-string";

const OPERATION_ID_MESSAGES = {
  empty: "The operation id must not be empty: an id names the operation a retry must be able to find, and no name names anything.",
  "too-long": `The operation id is longer than ${OPERATION_ID_MAX_BYTES} UTF-8 bytes; shorter ids are accepted, longer ones are not.`,
  "not-a-string": "The operation id must be a string: the id is opaque, and the journal does not interpret anything else as one.",
} as const satisfies Record<OperationIdIssue, string>;

/** A supplied operation id is not one the journal can stand behind. */
export class OperationIdError extends Error {
  public constructor(public readonly issue: OperationIdIssue) {
    super(OPERATION_ID_MESSAGES[issue]);
    this.name = "OperationIdError";
  }
}

/**
 * A call with an id the journal already knows, standing for something else:
 * the stored operation was admitted with different content, mentions, or tool
 * kind, so this call cannot be a retry of it. It is refused before any post;
 * a different id would name a different operation.
 */
export class OperationConflictError extends Error {
  public constructor(public readonly operationId: string) {
    super(
      `The operation id "${operationId}" was already used for a different operation (different content, mentions, or kind); this call is refused rather than posted. Delivery of the original is whatever the journal records for that id. Use a new id for a new operation — reusing one is not a recovery action.`,
    );
    this.name = "OperationConflictError";
  }
}

/**
 * A keyed operation's definite failure under its classified text: a refusal
 * the journal stands, or a send it released. It reads as the
 * `DeliveryFailedError` it is; the class only marks it a routine refusal.
 */
export class OperationRefusedError extends DeliveryFailedError {}

type OperationUnsupportedIssue = "no-journal" | "no-inbound" | "no-once-transport" | "invalid-input";

const OPERATION_UNSUPPORTED_MESSAGES = {
  "no-journal":
    "The operation id is accepted, but this room has no turn journal standing behind it, so the operation cannot be recorded durably and is refused before any post. Configure the room's journal to use operation ids.",
  "no-inbound":
    "The operation id is accepted, but this turn answers no inbound message the operation could settle (a synthetic turn, such as a contact hub event), so it is refused before any post.",
  "no-once-transport":
    "The operation id is accepted, but this room's transport cannot make a single-attempt, redirect-forbidden post, so the operation is refused before any post rather than delivered over the retrying legacy path.",
  "invalid-input":
    "The call is missing a field the operation's record needs (a send's content or a mention), so it is refused before any record or post: the operation id was not the problem, the call is not one the journal can stand.",
} as const satisfies Record<OperationUnsupportedIssue, string>;

/** A keyed send the journal cannot durably stand: no journal, no inbound to settle, no once transport, or inputs the record needs. */
export class OperationUnsupportedError extends Error {
  public constructor(public readonly issue: OperationUnsupportedIssue) {
    super(OPERATION_UNSUPPORTED_MESSAGES[issue]);
    this.name = "OperationUnsupportedError";
  }
}

/** The operation id, as supplied: opaque, untrimmed, and validated to stand in a record. */
export function validateOperationId(id: unknown): string {
  if (typeof id !== "string") throw new OperationIdError("not-a-string");
  if (id.length === 0) throw new OperationIdError("empty");
  if (Buffer.byteLength(id, "utf8") > OPERATION_ID_MAX_BYTES) throw new OperationIdError("too-long");
  return id;
}

/**
 * The mention inputs as strings, the way the fingerprint admits them: a
 * reference mention binds by its identity, its handle, then its name, in
 * that order — the roster's resolution of the input stands outside the
 * fingerprint, so a roster change never retargets a keyed operation.
 */
export function mentionInputsAsStrings(mentions: readonly (string | MentionReference)[]): string[] {
  return mentions.map(
    (mention) => (typeof mention === "string" ? mention : mention.id ?? mention.handle ?? mention.name ?? ""),
  );
}

/**
 * The mention inputs, as the fingerprint carries them: each trimmed, the
 * blanks and repeats dropped, the rest sorted, so two calls that mean the
 * same mentions bind to the same operation — the roster posts a repeated
 * mention once — and a call that names a different set does not.
 */
function canonicalMentions(mentions: readonly string[]): string[] {
  const trimmed = mentions.map((mention) => mention.trim()).filter((mention) => mention.length > 0);
  return [...new Set(trimmed)].sort();
}

/**
 * What the fingerprint binds: the version (a record layout change must not
 * collide with this one), the tool kind (so a send and a no-reply reuse
 * collides instead of one standing for the other), the exact effective
 * content or the decline's reason, and the canonical mention inputs. The id
 * itself is not in it: the id names the operation, the fingerprint says what
 * it stood for.
 */
export function operationFingerprint(input: {
  kind: OperationKind;
  content?: string;
  reason?: string;
  mentions?: readonly string[];
}): string {
  const payload = input.kind === "send" ? { content: input.content ?? "" } : { reason: input.reason ?? "" };
  // Key order is part of the hash: version, kind, payload, mentions.
  return sha256Hex(
    JSON.stringify({ v: FINGERPRINT_VERSION, kind: input.kind, ...payload, mentions: canonicalMentions(input.mentions ?? []) }),
  );
}

/** A resolved outcome that stands as a failure: an executor error, or an explicit failed or not-ok result. */
export function isFailedOperationResult(result: unknown): boolean {
  if (isToolExecutorError(result)) return true;
  if (typeof result !== "object" || result === null) return false;
  const { status, ok } = result as { status?: unknown; ok?: unknown };
  return status === "failed" || ok === false;
}

/**
 * A settled send's stored result, as the file proves it: JSON that parses to
 * a plain object that does not stand as a failure. `undefined` when it has no
 * such authority; the journal's load and every replay read it the same way.
 */
export function storedSendResult(resultJson: string | undefined): Record<string, unknown> | undefined {
  if (resultJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || isFailedOperationResult(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * The text a keyed operation of each kind stands unknown under, which the
 * operator reads in the tool result: a send may already be in the room, a
 * decline posts nothing, so nothing is held.
 */
export const UNKNOWN_OPERATION_MESSAGES: Readonly<Record<OperationKind, string>> = {
  send: unknownDeliveryText("operation"),
  decline:
    "The no-reply's outcome is unknown: its decision did not stand as a stored result, so the journal proves nothing either. The turn journal records the operation as unknown; the reply is not credited as declined, and the operation is never re-run as a success.",
};

/**
 * The classified public text a definite refusal stands under: it is what the
 * journal stores as the refusal's reason and what every later caller, joiner,
 * and replay reads. It names the refusal's class and, for an HTTP refusal,
 * its status — and nothing else. A transport's raw message, body, headers,
 * and credentials never stand in the record: a classifier that echoed them
 * would persist what the operator must not keep.
 */
export function publicRefusalText(value: unknown): string {
  // A resolved executor error may carry the failure it stands for: classify from it.
  const carried: unknown = isToolExecutorError(value) && value.details?.error !== undefined ? value.details.error : value;
  const code = statusCodeOf(carried);
  if (code !== undefined) {
    return `the platform refused the post (HTTP ${code})`;
  }
  if (carried instanceof Error) {
    // The transport's failure class, not its message: a message can carry a body.
    return `the post was refused by the transport: ${carried.name}`;
  }
  if (isToolExecutorError(value)) {
    return `the post was refused by the transport (${value.errorType})`;
  }
  return "the post was refused before it reached Band";
}

/**
 * A failed post that provably committed nothing and is no refusal of the post
 * itself: a 408/429 from infrastructure in front of Band, or Band's answer for
 * a room it stopped the agent in, which a play lifts.
 */
export function committedNothing(error: unknown): boolean {
  return error instanceof RoomExecutionStoppedError || classifyFailedAttempt(error) === "notCommitted";
}

/**
 * A resolved post result that stands as a settled operation's stored result:
 * a plain object the journal's JSON store keeps unchanged on the round trip.
 * Anything else — a non-object, a value the store coerces (a NaN, an
 * undefined property, a value a string would not carry back) — would settle
 * the operation on a copy different from the original result, and no such
 * copy may stand for the replay.
 */
export function isStorableResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(result);
  } catch {
    return false;
  }
  try {
    return isDeepStrictEqual(JSON.parse(encoded), result);
  } catch {
    return false;
  }
}

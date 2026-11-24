import type { MentionReference } from "../../contracts/dtos";
import { isToolExecutorError } from "../../contracts/protocols";
import { DeliveryFailedError } from "../../core/deliveryFailedError";
import { OPERATION_ID_MAX_BYTES } from "../../contracts/toolSchemas";
import { sha256Hex, type OperationKind } from "./records";

/** The fingerprint layout's version: a layout change must not collide with this one. */
const FINGERPRINT_VERSION = 1;

/** A supplied operation id is not one the journal can stand behind. */
export class OperationIdError extends Error {
  public constructor(public readonly issue: "empty" | "too-long" | "not-a-string") {
    const message =
      issue === "empty"
        ? "The operation id must not be empty: an id names the operation a retry must be able to find, and no name names anything."
        : issue === "too-long"
          ? `The operation id is longer than ${OPERATION_ID_MAX_BYTES} UTF-8 bytes; shorter ids are accepted, longer ones are not.`
          : "The operation id must be a string: the id is opaque, and the journal does not interpret anything else as one.";
    super(message);
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

/** A keyed send the journal cannot durably stand: no journal, no inbound to settle, no once transport, or inputs the record needs. */
export class OperationUnsupportedError extends Error {
  public constructor(public readonly issue: "no-journal" | "no-inbound" | "no-once-transport" | "invalid-input") {
    const message =
      issue === "no-journal"
        ? "The operation id is accepted, but this room has no turn journal standing behind it, so the operation cannot be recorded durably and is refused before any post. Configure the room's journal to use operation ids."
        : issue === "no-inbound"
          ? "The operation id is accepted, but this turn answers no inbound message the operation could settle (a synthetic turn, such as a contact hub event), so it is refused before any post."
        : issue === "no-once-transport"
          ? "The operation id is accepted, but this room's transport cannot make a single-attempt, redirect-forbidden post, so the operation is refused before any post rather than delivered over the retrying legacy path."
          : "The call is missing a field the operation's record needs (a send's content or a mention), so it is refused before any record or post: the operation id was not the problem, the call is not one the journal can stand.";
    super(message);
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
 * blanks dropped, the rest sorted, so two calls that mean the same mentions
 * in any order bind to the same operation, and a call that names a different
 * set does not.
 */
function canonicalMentions(mentions: readonly string[]): string[] {
  return [...mentions]
    .map((mention) => mention.trim())
    .filter((mention) => mention.length > 0)
    .sort();
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

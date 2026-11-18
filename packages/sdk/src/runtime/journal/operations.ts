import { createHash } from "node:crypto";

import type { MentionReference } from "../../contracts/dtos";
import type { OperationKind } from "./records";

/**
 * The longest an operation id may be, in encoded UTF-8 bytes. Ids are opaque
 * to the SDK: they are never trimmed into aliases, interpreted, or used as
 * file system paths — the bound is a storage guarantee, not a shape rule.
 */
export const OPERATION_ID_MAX_BYTES = 256;

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

/** A keyed send the journal cannot durably stand: no journal, or no once transport. */
export class OperationUnsupportedError extends Error {
  public constructor(public readonly issue: "no-journal" | "no-once-transport") {
    const message =
      issue === "no-journal"
        ? "The operation id is accepted, but this room has no turn journal standing behind it, so the operation cannot be recorded durably and is refused before any post. Configure the room's journal to use operation ids."
        : "The operation id is accepted, but this room's transport cannot make a single-attempt, redirect-forbidden post, so the operation is refused before any post rather than delivered over the retrying legacy path.";
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
 * A promise that settles one way or the other: a joiner to an in-flight
 * operation must learn an outcome the call refused, not wait forever for a
 * success.
 */
export interface SettledOperation<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function createSettledOperation<T>(): SettledOperation<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = (error) => innerReject(error instanceof Error ? error : new Error(String(error)));
  });
  return { promise, resolve, reject };
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
export function canonicalMentions(mentions: readonly string[]): string[] {
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
  const payload =
    input.kind === "send"
      ? { v: 1, kind: "send", content: input.content ?? "", mentions: canonicalMentions(input.mentions ?? []) }
      : { v: 1, kind: "decline", reason: input.reason ?? "", mentions: canonicalMentions(input.mentions ?? []) };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
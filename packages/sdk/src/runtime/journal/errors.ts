import { BandSdkError } from "../../core/errors";

/** Why a v2 journal file cannot be trusted; every kind refuses the room, never empties it. */
export type JournalFileKind = "corrupt" | "unsupported" | "unbound-legacy" | "io";

/** The journal file at `file` fails strict validation; the room stays closed, not reset. */
export class JournalFileError extends BandSdkError {
  public constructor(
    message: string,
    public readonly kind: JournalFileKind,
    public readonly file: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "JournalFileError";
  }
}

/**
 * Why the room's publications are not admitted; the room's replies refuse to
 * post until it is resolved.
 *
 * - `poisoned` / `closed`: the handle will not take records.
 * - `fenced`: the inbound already has a pending or unknown publication; a
 *   replacement must not POST beside a reply Band may already hold.
 */
export type JournalPublicationKind = "poisoned" | "closed" | "fenced";

/** A publication the room's journal will not admit; the reply does not post. */
export class JournalPublicationError extends BandSdkError {
  public constructor(
    message: string,
    public readonly kind: JournalPublicationKind,
  ) {
    super(message);
    this.name = "JournalPublicationError";
  }
}
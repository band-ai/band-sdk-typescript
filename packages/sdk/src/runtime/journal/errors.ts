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
 * - `fenced`: the turn already has a reply whose delivery stands unknown; a
 *   replacement must not post beside a reply Band may already hold.
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

/** The room's handling stopped: its journal, or the generation it belongs to, closed. */
export function closedJournalError(): JournalPublicationError {
  return new JournalPublicationError("The room's journal is closed: its handling stopped, so the publication is refused rather than delivered unrecorded", "closed");
}

/** The room's journal failed a write it owed, and admits nothing until it reopens. */
export function poisonedJournalError(): JournalPublicationError {
  return new JournalPublicationError(
    "The room's journal cannot record a publication outcome it owes, so it refuses new replies; restart the runtime so the journal reopens and reports what is unresolved",
    "poisoned",
  );
}

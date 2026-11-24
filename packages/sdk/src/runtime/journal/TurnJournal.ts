import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { BandSdkError, ValidationError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { KeyedSingleFlight } from "../../core/singleFlight";
import { isolateTeardown } from "../../core/teardown";

import { JournalFileError } from "./errors";
import { agentDirectoryComponent, identityDirectoryComponent } from "./records";
import { RoomJournal, roomFileName, type RoomJournalOptions } from "./RoomJournal";
import { JournalOwnership } from "./ownership";
import {
  assertMigrationStartIdentity,
  resumeInterruptedMigration,
  unboundLegacyFiles,
  migrationState,
  validateCommittedDestinations,
} from "./migration";

/** A journal operation (a write, a close) whose failure must not stop the runtime: it is logged where it happens. */
export async function bestEffort(operation: () => Promise<unknown>, logger: Logger, failure: string, context: Record<string, unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(failure, { ...context, error });
  }
}

/**
 * The directory of one agent's v2 journal under `journalDir`. The agent id is
 * hashed, never percent-encoded: a caller-controlled id must not reach the
 * file system as a path component it can steer. The full id stands in every
 * file's header, which is what is validated on open.
 */
export function agentJournalDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, agentDirectoryComponent(agentId));
}

/**
 * The directory a pre-v2 (legacy) process of `agentId` journaled under. Kept
 * verbatim — percent-encoded, as the legacy layout wrote it — because that
 * is where legacy files actually live and where the migration reads them.
 */
export function legacyAgentDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, encodeURIComponent(agentId));
}

/** The path of `roomId`'s journal file under `dir`, whichever directory holds the room's journals. */
export function roomJournalFile(dir: string, roomId: string): string {
  return path.join(dir, roomFileName(roomId));
}

/** The agent's exclusive ownership lock file under its journal directory. */
export const OWNERSHIP_FILE = ".ownership.sqlite";

/** A v2 journal the start generation opened: its rooms, and the ownership it holds for them. */
export interface JournalGeneration {
  /** The identity the generation's rooms' journals are bound to. */
  readonly identity: string;
  /** The room's journal, opened on first use and kept open until its handling stops. */
  room(roomId: string): Promise<RoomJournal>;
  /**
   * Holds `roomId`'s journal open for a turn: while any hold stands, a release
   * of the room defers its close until the last hold ends, so a turn never
   * loses the handle (or the poisoned state of it) it is still writing to.
   */
  holdRoom(roomId: string): void;
  /**
   * Ends a turn's hold on `roomId`; when the last hold ends, a close a
   * release deferred while it stood runs then.
   */
  endHoldRoom(roomId: string): Promise<void>;
  /**
   * Closes `roomId`'s journal once its handling stopped; it reopens on the room's
   * next turn. A turn's hold defers the close until it ends — except when `force`
   * says the room's handling stopped for good (the room was left, the runtime
   * stopped): a turn still settling there must not write to the released journal.
   */
  release(roomId: string, force?: boolean): Promise<void>;
  /** Tracks a publication the generation admitted, so its stop waits for the outcome. */
  trackInflight(promise: Promise<unknown>, roomId: string): void;
  /** Waits for publications the generation admitted, their outcomes durable. */
  drain(): Promise<void>;
  /** The path of `roomId`'s journal file under this generation's identity. */
  roomPath(roomId: string): string;
  /** Closes the generation's rooms, then releases its ownership; safe to call more than once. */
  close(): Promise<void>;
}

export interface TurnJournalOptions {
  /** The clock v2 records are stamped by; `Date.now` by default. */
  now?: () => number;
  logger?: Logger;
}

/**
 * One agent's v2 journal under the canonical journal root: identity-bound
 * room journals, one owner at a time, and the offline migration state that
 * bound its legacy files.
 *
 * Every start generation calls {@link TurnJournal.activate} with the platform
 * identity its link resolved to; the acquisition is the generation's, and the
 * generation's close — and only it — releases it. Rooms a generation opened
 * belong to it: a superseded start's cleanup closes its own rooms and
 * ownership, and never a successor's.
 */
export class TurnJournal {
  readonly dir: string;
  readonly agentId: string;
  readonly now: () => number;
  readonly logger: Logger;
  /** The configured journal root: the legacy (pre-v2) files live under it, not under `dir`. */
  private readonly root: string;
  /** Set by `prepare()` until a generation activates: rooms open under the generation, not here. */
  private prepared = false;

  public constructor(journalDir: string, agentId: string, options: TurnJournalOptions = {}) {
    this.root = journalDir;
    this.dir = agentJournalDir(journalDir, agentId);
    this.agentId = agentId;
    this.now = options.now ?? Date.now;
    this.logger = resolveLogger(options.logger);
  }

  /** Creates the agent's directory and checks it is usable, so a bad `journalDir` fails start, not a turn. */
  public async prepare(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await access(this.dir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (error) {
      throw new ValidationError("sessionConfig.journalDir is not a usable directory", error);
    }
    this.prepared = true;
  }

  /**
   * Opens the agent's journal under `identity` for one start generation:
   * acquires the agent's exclusive ownership, resumes a migration a crash
   * left mid-commit, and refuses to start over legacy files no migration
   * bound — they might belong to any deployment, and no legacy record says
   * which — or over a committed migration whose output is missing or untrust-
   * worthy: that journal's authority would otherwise open as an empty file
   * and settle no one. The generation owns what it returns and gives it all
   * back.
   */
  public async activate(identity: string): Promise<JournalGeneration> {
    if (!this.prepared) await this.prepare();
    const ownershipFile = path.join(this.dir, OWNERSHIP_FILE);
    const ownership = await JournalOwnership.acquire(ownershipFile);
    try {
      // A migration a crash left prepared is resumed under this ownership, or the start refuses:
      // it never initializes empty over a half-migrated journal.
      // A migration's attested identities are the only ones start may open under:
      // another identity would serve empty room journals beside settled ones.
      await assertMigrationStartIdentity(this.dir, identity);
      const state = await migrationState(this.dir);
      if (state === "prepared") {
        await resumeInterruptedMigration(this.dir, legacyAgentDir(this.root, this.agentId), this.agentId, identity, { now: this.now, logger: this.logger });
      }
      // A commit — resumed or already made — binds a set of files to their v2
      // destinations. Every destination it names must still stand and still
      // be a journal bound where it claims: one missing or unreadable is a
      // journal whose authority is lost, and an empty file must not open over
      // it and settle no one.
      if ((await migrationState(this.dir)) === "committed") {
        await validateCommittedDestinations(this.dir, this.agentId);
      }
      // Anything the agent's legacy directory holds beyond that commit might
      // belong to any deployment, and no record says which.
      const legacy = await unboundLegacyFiles(legacyAgentDir(this.root, this.agentId), this.dir);
      if (legacy.length > 0) {
        throw new JournalFileError(
          `This agent's journal holds legacy records (${legacy.join(", ")}) no offline migration has bound to a platform identity; ` +
            `they might belong to any deployment this agent ever pointed at. Run the exported migrateTurnJournals against them with their ` +
            `provenance before starting; it preserves what it binds and removes nothing. A file start will not run over until it is bound, ` +
            `or it is removed — removal discards whatever authority the file holds.`,
          "unbound-legacy",
          path.join(legacyAgentDir(this.root, this.agentId), legacy[0]),
        );
      }
      const identityDir = path.join(this.dir, identityDirectoryComponent(identity));
      await mkdir(identityDir, { recursive: true });
      return new Generation(this, identity, ownership);
    } catch (error) {
      await bestEffort(() => ownership.release(), this.logger, "Failed to release the journal's ownership after its activation failed", { agentId: this.agentId });
      throw error;
    }
  }
}

class Generation implements JournalGeneration {
  public readonly identity: string;
  /** Open handles; a release keeps the room's published while it drains the room's tracked work. */
  private readonly rooms = new Map<string, Promise<RoomJournal>>();
  /** In-flight opens, one per room and release epoch; published into `rooms` only once open. */
  private readonly opens = new KeyedSingleFlight<RoomJournal>();
  /**
   * Bumped by each forced release of the room: an open that began under an
   * older epoch closes the handle it opened instead of publishing it, so a
   * room whose handling stopped keeps no file open, whoever was opening it.
   */
  private readonly epochs = new Map<string, number>();
  /** Releases in progress (draining, then closing); a later release of the room joins it. */
  private readonly releasing = new Map<string, Promise<void>>();
  /** Handles being closed; reopening the room waits, so it reads every record the closing handle wrote. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly inflight: Set<Promise<unknown>> = new Set();
  /**
   * Publications in flight per room for this generation's lifetime. The set for
   * a room is never replaced or deleted on close: a concurrent track after a
   * snapshot would otherwise install a new set the closer never waits on.
   */
  private readonly roomInflight = new Map<string, Set<Promise<unknown>>>();
  /** A turn is still using the room: a close owed to it is deferred until the last hold ends. */
  private readonly turnHolds = new Map<string, number>();
  /** A release landed on a held room; its close runs when the last hold ends. */
  private readonly deferredCloses = new Set<string>();
  /** What this generation announced, per room: one announcement per publication, across the room's handles. */
  private readonly announced = new Map<string, Set<string>>();
  private closed = false;
  private ownershipReleased = false;

  constructor(
    private readonly journal: TurnJournal,
    identity: string,
    private readonly ownership: JournalOwnership,
  ) {
    this.identity = identity;
  }

  public room(roomId: string): Promise<RoomJournal> {
    if (this.closed) return Promise.reject(new GenerationClosedError());
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const epoch = this.epochOf(roomId);
    return this.opens.run(openKey(roomId, epoch), () => this.openRoom(roomId, epoch));
  }

  /** Opens `roomId` after any close of its handle, and publishes it into `rooms` unless a forced release overtook the open. */
  private async openRoom(roomId: string, epoch: number): Promise<RoomJournal> {
    await this.closing.get(roomId);
    this.assertOpenable(roomId, epoch);
    const journal = await RoomJournal.open(this.roomFile(roomId), this.roomOptions(roomId));
    try {
      this.assertOpenable(roomId, epoch);
    } catch (error) {
      await bestEffort(() => journal.close(), this.journal.logger, "Failed to close a room journal opened after its room was released", { roomId });
      throw error;
    }
    this.rooms.set(roomId, Promise.resolve(journal));
    return journal;
  }

  /** Throws when the generation closed, or a forced release of the room overtook an open begun under `epoch`. */
  private assertOpenable(roomId: string, epoch: number): void {
    if (this.closed) throw new GenerationClosedError();
    if (this.epochOf(roomId) !== epoch) {
      throw new GenerationClosedError("The room's journal was released while it opened; its handling stopped");
    }
  }

  private epochOf(roomId: string): number {
    return this.epochs.get(roomId) ?? 0;
  }

  public holdRoom(roomId: string): void {
    if (this.closed) return;
    const n = this.turnHolds.get(roomId) ?? 0;
    this.turnHolds.set(roomId, n + 1);
  }

  public async endHoldRoom(roomId: string): Promise<void> {
    const n = (this.turnHolds.get(roomId) ?? 0) - 1;
    if (n > 0) {
      this.turnHolds.set(roomId, n);
      return;
    }
    this.turnHolds.delete(roomId);
    if (this.deferredCloses.delete(roomId)) await this.release(roomId);
  }

  public async release(roomId: string, force = false): Promise<void> {
    if (force) {
      // The room's handling stopped for good: no close is owed to a later
      // endHold, and an open in flight closes what it opens. A later open
      // waits until it has.
      this.deferredCloses.delete(roomId);
      const opening = this.opens.current(openKey(roomId, this.epochOf(roomId)));
      this.epochs.set(roomId, this.epochOf(roomId) + 1);
      if (opening) {
        await this.whileClosing(roomId, opening.then(() => undefined, () => undefined));
        return;
      }
    }
    const inProgress = this.releasing.get(roomId);
    if (inProgress) return await inProgress;
    const room = this.rooms.get(roomId);
    if (!room) return await this.closing.get(roomId);
    const releasing = this.drainThenClose(roomId, room, force).finally(() => {
      if (this.releasing.get(roomId) === releasing) this.releasing.delete(roomId);
    });
    this.releasing.set(roomId, releasing);
    await releasing;
  }

  /**
   * Closes `roomId`'s handle once its tracked work stands on disk. The handle
   * stays published while the work drains, so work that opens the room gets
   * it rather than wait on this release; it is unpublished in the tick the
   * drain ends. A turn holding the room by then defers the close to its last
   * hold, unless the release is forced: by its caller, by a forced release
   * that joined it (the room's epoch moved), or by the generation's close.
   */
  private async drainThenClose(roomId: string, room: Promise<RoomJournal>, force: boolean): Promise<void> {
    const epoch = this.epochOf(roomId);
    await this.drainRoomInflight(roomId);
    const forced = force || this.closed || this.epochOf(roomId) !== epoch;
    if (!forced && (this.turnHolds.get(roomId) ?? 0) > 0) {
      this.deferredCloses.add(roomId);
      return;
    }
    this.deferredCloses.delete(roomId);
    this.rooms.delete(roomId);
    await this.whileClosing(roomId, closeRoom(room));
  }

  /** Stands `closing` as the room's handle close: opens of the room wait for it, whatever its outcome. */
  private whileClosing(roomId: string, closing: Promise<void>): Promise<void> {
    const standing: Promise<void> = closing.then(() => undefined, () => undefined).finally(() => {
      if (this.closing.get(roomId) === standing) this.closing.delete(roomId);
    });
    this.closing.set(roomId, standing);
    return closing;
  }

  /** Waits for every promise tracked against `roomId` until the set is empty. */
  private async drainRoomInflight(roomId: string): Promise<void> {
    const held = this.roomInflight.get(roomId);
    if (!held) return;
    while (held.size > 0) {
      await Promise.allSettled([...held]);
    }
  }

  public async drain(): Promise<void> {
    for (;;) {
      const batch = [...this.inflight];
      for (const rooms of this.roomInflight.values()) {
        for (const promise of rooms) batch.push(promise);
      }
      if (batch.length === 0) return;
      await Promise.allSettled(batch);
    }
  }

  /** Tracks a publication admitted by this generation until its outcome is durable. */
  public trackInflight(promise: Promise<unknown>, roomId: string): void {
    this.inflight.add(promise);
    this.roomInflightSet(roomId).add(promise);
    const forget = (): void => {
      this.inflight.delete(promise);
      this.roomInflight.get(roomId)?.delete(promise);
    };
    // `promise.finally` would derive a rejecting promise no one handles; settle both ways.
    void promise.then(forget, forget);
  }

  public roomPath(roomId: string): string {
    return this.roomFile(roomId);
  }

  /** The generation-stable inflight set for `roomId`; created once and never replaced. */
  private roomInflightSet(roomId: string): Set<Promise<unknown>> {
    let rooms = this.roomInflight.get(roomId);
    if (!rooms) {
      rooms = new Set();
      this.roomInflight.set(roomId, rooms);
    }
    return rooms;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    // Closed, every release is forced: the generation's close stands behind no turn.
    for (const roomId of new Set([...this.rooms.keys(), ...this.releasing.keys()])) {
      await isolateTeardown(errors, () => this.release(roomId));
    }
    // An open in flight may still rewrite its file: it ends, closing what it opened, before a successor may own the journal.
    await this.opens.settled();
    for (const closing of this.closing.values()) await closing;
    if (errors.length > 0) {
      this.journal.logger.warn("Failed to close some of the generation's room journals", { agentId: this.journal.agentId, errors });
    }
    await this.releaseOwnership();
  }

  private async releaseOwnership(): Promise<void> {
    if (this.ownershipReleased) return;
    this.ownershipReleased = true;
    await this.ownership.release();
  }

  private roomOptions(roomId: string): RoomJournalOptions {
    return {
      platformIdentity: this.identity,
      agentId: this.journal.agentId,
      roomId,
      now: this.journal.now,
      logger: this.journal.logger,
      hasAnnounced: (publicationId: string): boolean => (this.announced.get(roomId)?.has(publicationId) ?? false),
      markAnnounced: (publicationId: string): void => {
        let ids = this.announced.get(roomId);
        if (!ids) {
          ids = new Set<string>();
          this.announced.set(roomId, ids);
        }
        ids.add(publicationId);
      },
    };
  }

  private roomFile(roomId: string): string {
    return path.join(this.journal.dir, identityDirectoryComponent(this.identity), roomFileName(roomId));
  }
}

/** The room's handling stopped before its journal opened: the generation closed, or a forced release let the room go. */
export class GenerationClosedError extends BandSdkError {
  constructor(message = "The journal generation is closed; its start ended") {
    super(message);
    this.name = "GenerationClosedError";
  }
}

/** The single-flight key of `roomId`'s open under `epoch`: an open begun before a forced release is never joined after it. */
function openKey(roomId: string, epoch: number): string {
  return `${epoch}:${roomId}`;
}

async function closeRoom(room: Promise<RoomJournal>): Promise<void> {
  await (await room.catch(() => null))?.close();
}
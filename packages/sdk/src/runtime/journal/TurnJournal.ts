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
  /**
   * Runs `work` tracked against `roomId` once no release of the room is in
   * progress: a release waits on the room's tracked work, so work that opens
   * the room must not be tracked while a release it would wait on stands.
   */
  trackOnceReleased<T>(roomId: string, work: () => Promise<T>): Promise<T>;
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
    this.logger = options.logger ?? resolveLogger();
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
  private readonly rooms = new Map<string, Promise<RoomJournal>>();
  /** In-flight opens, one per room and release epoch; published into `rooms` only once open. */
  private readonly opens = new KeyedSingleFlight<RoomJournal>();
  /**
   * Bumped by each forced release of the room: an open that began under an
   * older epoch closes the handle it opened instead of publishing it, so a
   * room whose handling stopped keeps no file open, whoever was opening it.
   */
  private readonly epochs = new Map<string, number>();
  /** Rooms being released; reopening one waits, so it reads every record the closing handle wrote. */
  private readonly releasing = new Map<string, Promise<void>>();
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

  /** Opens `roomId` after any in-flight release, and publishes it into `rooms` unless a forced release overtook the open. */
  private async openRoom(roomId: string, epoch: number): Promise<RoomJournal> {
    await (this.releasing.get(roomId) ?? Promise.resolve()).catch(() => undefined);
    this.assertOpenable(roomId, epoch);
    const afterRelease = this.rooms.get(roomId);
    if (afterRelease) return afterRelease;

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
    if (!this.deferredCloses.delete(roomId)) return;
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      await this.closeRoomNow(roomId, room);
    }
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
        await this.whileReleasing(roomId, opening.then(() => undefined, () => undefined));
        return;
      }
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      // A held room's close is owed, but a turn still uses its handle; it runs
      // when the last hold ends. An already closed room stands behind its close.
      return (this.deferredCloses.has(roomId) ? Promise.resolve() : this.releasing.get(roomId) ?? Promise.resolve()).catch(() => undefined);
    }
    if (!force && (this.turnHolds.get(roomId) ?? 0) > 0) {
      // A turn is still writing to the room: its handle stays open, and the
      // close runs when the turn's hold ends.
      this.deferredCloses.add(roomId);
      return;
    }
    // Closing now: drop any deferred close so a later endHold does not close a reopened handle.
    this.deferredCloses.delete(roomId);
    this.rooms.delete(roomId);
    await this.closeRoomNow(roomId, room);
  }

  /**
   * Closes `roomId`'s handle once its publications stand on disk: one in
   * flight must never lose its outcome to the close racing its post. The
   * room's set lives for the generation and is drained in place, so a
   * concurrent track still lands in the set this close waits on.
   */
  private closeRoomNow(roomId: string, room: Promise<RoomJournal>): Promise<void> {
    return this.whileReleasing(roomId, (async () => {
      await this.drainRoomInflight(roomId);
      await closeRoom(room);
    })());
  }

  /** Stands `closing` as the room's release in progress: opens of the room wait for it. */
  private whileReleasing(roomId: string, closing: Promise<void>): Promise<void> {
    const releasing = closing.finally(() => {
      if (this.releasing.get(roomId) === releasing) this.releasing.delete(roomId);
    });
    this.releasing.set(roomId, releasing);
    return releasing;
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

  public async trackOnceReleased<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    for (let releasing = this.releasing.get(roomId); releasing; releasing = this.releasing.get(roomId)) {
      await releasing.catch(() => undefined);
    }
    // No release stands, and none can start before the work is tracked: both happen in this tick.
    const running = work();
    this.trackInflight(running, roomId);
    return await running;
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
    for (const roomId of [...this.rooms.keys()]) {
      await isolateTeardown(errors, () => this.release(roomId));
    }
    // A close a turn deferred: the generation's close stands behind no turn, so it runs now.
    for (const roomId of [...this.deferredCloses]) {
      this.deferredCloses.delete(roomId);
      const room = this.rooms.get(roomId);
      if (room) {
        this.rooms.delete(roomId);
        await isolateTeardown(errors, () => this.closeRoomNow(roomId, room));
      }
    }
    for (const closing of this.releasing.values()) {
      await isolateTeardown(errors, () => closing.catch(() => undefined));
    }
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
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { BandSdkError, ValidationError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";

import { assertMigrationStartable } from "./migration";
import { OWNERSHIP_FILE, agentJournalDir, identityDirectoryComponent, identityRoomFile, legacyAgentDir } from "./records";
import { RoomJournal, type RoomJournalOptions } from "./RoomJournal";
import { JournalOwnership } from "./ownership";

/** A journal operation (a write, a close) whose failure must not stop the runtime: it is logged where it happens. */
export async function bestEffort(operation: () => Promise<unknown>, logger: Logger, failure: string, context: Record<string, unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(failure, { ...context, error });
  }
}

/** A v2 journal the start generation opened: its rooms, and the ownership it holds for them. */
export interface JournalGeneration {
  /** The identity the generation's rooms' journals are bound to. */
  readonly identity: string;
  /** The room's journal, opened on first use and kept open until the room is released. */
  room(roomId: string): Promise<RoomJournal>;
  /**
   * A turn's hold on `roomId`'s journal: the handle stays open until the hold
   * ends, and the room counts as in use again. Only the generation's close
   * closes the handle under it: a stop never waits on a turn.
   */
  holdRoom(roomId: string): RoomHold;
  /**
   * Tracked work on `roomId`'s journal — a publication serving `messageId`, or
   * the room's recovery: the handle stays open, and the generation's close
   * waits, until the hold ends.
   */
  trackRoom(roomId: string, messageId?: string): RoomHold;
  /** The room's handling stopped: its handle closes once its last hold ends, and a later hold opens it afresh. */
  release(roomId: string): void;
  /** Settles once the tracked work serving `messageId` in `roomId` now has ended. */
  settled(roomId: string, messageId: string): Promise<void>;
  /** The path of `roomId`'s journal file under this generation's identity. */
  roomPath(roomId: string): string;
  /** Waits for tracked work and opens, closes every room, then releases ownership; safe to call more than once. */
  close(): Promise<void>;
}

/** One use of a room's journal handle; `end` is idempotent. */
export interface RoomHold {
  readonly journal: Promise<RoomJournal>;
  end(): void;
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
   * acquires the agent's exclusive ownership and, under it, refuses to start
   * where the migration's authority is unsettled ({@link assertMigrationStartable}).
   * The generation owns what it returns and gives it all back.
   */
  public async activate(identity: string): Promise<JournalGeneration> {
    if (!this.prepared) await this.prepare();
    const ownershipFile = path.join(this.dir, OWNERSHIP_FILE);
    const ownership = await JournalOwnership.acquire(ownershipFile);
    try {
      await assertMigrationStartable(this.dir, legacyAgentDir(this.root, this.agentId), this.agentId, identity, { now: this.now, logger: this.logger });
      const identityDir = path.join(this.dir, identityDirectoryComponent(identity));
      await mkdir(identityDir, { recursive: true });
      return new Generation(this, identity, ownership);
    } catch (error) {
      await bestEffort(() => ownership.release(), this.logger, "Failed to release the journal's ownership after its activation failed", { agentId: this.agentId });
      throw error;
    }
  }
}

/**
 * A room's journal handle and what uses it. The handle closes only once no
 * use stands — every use but a turn's, when the generation closes — and the
 * room is released, so no use ever loses the handle it is writing to.
 */
interface Slot {
  readonly journal: Promise<RoomJournal>;
  opened?: RoomJournal;
  readonly holds: Set<Hold>;
  closing: boolean;
  /** Settles once the handle closed (or never opened); the room's next handle opens after it. */
  readonly done: PromiseWithResolvers<void>;
}

interface Hold {
  /** Tracked work, which the generation's close waits for; a turn's hold is not. */
  readonly tracked: boolean;
  readonly messageId?: string;
  readonly ended: PromiseWithResolvers<void>;
}

class Generation implements JournalGeneration {
  public readonly identity: string;
  /** Each room's current handle; a hold joins it unless it is closing. */
  private readonly slots = new Map<string, Slot>();
  /** Rooms whose handling stopped: their handle closes once its last hold ends. */
  private readonly released = new Set<string>();
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

  public async room(roomId: string): Promise<RoomJournal> {
    const hold = this.holdRoom(roomId);
    try {
      return await hold.journal;
    } finally {
      hold.end();
    }
  }

  public holdRoom(roomId: string): RoomHold {
    if (!this.closed) this.released.delete(roomId);
    return this.hold(roomId, false);
  }

  public trackRoom(roomId: string, messageId?: string): RoomHold {
    return this.hold(roomId, true, messageId);
  }

  public release(roomId: string): void {
    this.released.add(roomId);
    const slot = this.slots.get(roomId);
    if (slot) this.closeIfIdle(roomId, slot);
  }

  public async settled(roomId: string, messageId: string): Promise<void> {
    const serving = [...(this.slots.get(roomId)?.holds ?? [])].filter((hold) => hold.messageId === messageId);
    await Promise.all(serving.map((hold) => hold.ended.promise));
  }

  public roomPath(roomId: string): string {
    return this.roomFile(roomId);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const slots = [...this.slots];
    for (const [roomId, slot] of slots) this.closeIfIdle(roomId, slot);
    // A room's next handle opens only after its previous one closed, so the current handles' closes cover every earlier one.
    await Promise.all(slots.map(([, slot]) => slot.done.promise));
    await this.releaseOwnership();
  }

  private hold(roomId: string, tracked: boolean, messageId?: string): RoomHold {
    if (this.closed) {
      return { journal: Promise.reject(new GenerationClosedError()), end: () => undefined };
    }
    const slot = this.currentSlot(roomId);
    const hold: Hold = { tracked, messageId, ended: Promise.withResolvers<void>() };
    slot.holds.add(hold);
    return {
      journal: slot.journal,
      end: () => {
        if (!slot.holds.delete(hold)) return;
        hold.ended.resolve();
        this.closeIfIdle(roomId, slot);
      },
    };
  }

  /** The room's handle to join; once it is closing, a fresh one that opens after it closed, with every record it wrote. */
  private currentSlot(roomId: string): Slot {
    const current = this.slots.get(roomId);
    if (current && !current.closing) return current;
    const slot: Slot = {
      // Referenced only once the previous handle closed, by when `slot` stands.
      journal: Promise.resolve(current?.done.promise).then(() => this.open(roomId, slot)),
      holds: new Set(),
      closing: false,
      done: Promise.withResolvers<void>(),
    };
    void slot.journal.catch(() => undefined);
    this.slots.set(roomId, slot);
    return slot;
  }

  private async open(roomId: string, slot: Slot): Promise<RoomJournal> {
    try {
      slot.opened = await RoomJournal.open(this.roomFile(roomId), this.roomOptions(roomId));
      return slot.opened;
    } catch (error) {
      // Nothing opened: the room's next hold tries again.
      slot.closing = true;
      if (this.slots.get(roomId) === slot) this.slots.delete(roomId);
      slot.done.resolve();
      throw error;
    }
  }

  /** Closes the room's handle when nothing holds it — no tracked work, once the generation closed — and the room is released. */
  private closeIfIdle(roomId: string, slot: Slot): void {
    if (slot.closing) return;
    const held = [...slot.holds].some((hold) => hold.tracked || !this.closed);
    if (held || !(this.closed || this.released.has(roomId))) return;
    slot.closing = true;
    // Closed in this tick when the handle is open, so no write can slip in after the last hold ended.
    const closing = slot.opened ? slot.opened.close() : slot.journal.then((journal) => journal.close(), () => undefined);
    void closing
      .catch((error: unknown) => this.journal.logger.warn("Failed to close a room's turn journal", { roomId, error }))
      .finally(() => {
        if (this.slots.get(roomId) === slot) this.slots.delete(roomId);
        slot.done.resolve();
      });
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
    return identityRoomFile(this.journal.dir, this.identity, roomId);
  }
}

/** The generation closed before the room's journal was held: its start ended. */
export class GenerationClosedError extends BandSdkError {
  constructor() {
    super("The journal generation is closed; its start ended");
    this.name = "GenerationClosedError";
  }
}

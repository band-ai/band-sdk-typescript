import type { DatabaseSync } from "node:sqlite";
import { BandSdkError } from "../../core/errors";

type SqliteModule = Pick<typeof import("node:sqlite"), "DatabaseSync">;

/** Why a journal's ownership could not be acquired; every kind fails closed. */
export type JournalOwnershipKind = "contention" | "unsupported" | "corrupt" | "io";

/** The journal lock could not be taken safely: the journal stays closed. */
export class JournalOwnershipError extends BandSdkError {
  public constructor(
    message: string,
    public readonly kind: JournalOwnershipKind,
    public readonly file: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "JournalOwnershipError";
  }
}

export interface JournalOwnershipOptions {
  /** Supplies the `node:sqlite` module instead of the lazy import; a test seam. */
  loadSqlite?: () => Promise<SqliteModule>;
}

/**
 * Exclusive ownership of one agent's journal: one process may write it.
 *
 * A `node:sqlite` connection on the lock file holds a `BEGIN EXCLUSIVE`
 * transaction for the whole ownership lifetime. `busy_timeout` is zero, so a
 * contender is refused at once rather than waiting behind the owner; the lock
 * is never stolen, unlinked, replaced or leased by time. Closing the lock
 * releases the transaction and the connection; killing the process releases
 * the file with it.
 */
export class JournalOwnership {
  private db?: DatabaseSync;
  private released = false;

  private constructor() {}

  /** Acquires the lock on `file`, refusing at once when another process holds it. */
  public static async acquire(file: string, options: JournalOwnershipOptions = {}): Promise<JournalOwnership> {
    let module: SqliteModule;
    try {
      // Lazy, like the Linear store: without a configured journal no SQLite is loaded, and
      // Node 22.12 only exposes node:sqlite behind --experimental-sqlite.
      module = await (options.loadSqlite ?? (() => import("node:sqlite")))();
    } catch (error) {
      throw new JournalOwnershipError(
        `The journal lock needs node:sqlite (Node.js 22.13+, or 22.12 with --experimental-sqlite); it is unavailable here. ` +
          `The journal stays closed. Original error: ${error instanceof Error ? error.message : String(error)}`,
        "unsupported",
        file,
        error,
      );
    }

    let db: DatabaseSync;
    try {
      db = new module.DatabaseSync(file);
    } catch (error) {
      throw classify(file, error);
    }
    try {
      db.exec("PRAGMA busy_timeout=0");
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      throw classify(file, error);
    }

    const ownership = new JournalOwnership();
    ownership.db = db;
    return ownership;
  }

  /** Releases the lock; safe to call more than once. */
  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const db = this.db;
    this.db = undefined;
    if (!db) return;
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

/** SQLite primary result codes the lock classifies; node:sqlite reports the result in `errcode`. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_NOTADB = 26;

/** The SQLite primary result code of `error`, or `undefined` for a failure SQLite did not report. */
function sqliteResultCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("errcode" in error) || typeof error.errcode !== "number") return undefined;
  // An extended result code keeps its primary code in the low byte.
  return error.errcode & 0xff;
}

/** The lock failure of `file`: contention, a corrupt file, or an I/O fault. */
function classify(file: string, error: unknown): JournalOwnershipError {
  const code = sqliteResultCode(error);
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
    return new JournalOwnershipError(
      `Another process owns the journal at ${file}. Stop that process (or the runtime that started it) and try again; ` +
        `the lock is never stolen, and the journal stays closed meanwhile.`,
      "contention",
      file,
      error,
    );
  }
  if (code === SQLITE_NOTADB) {
    return new JournalOwnershipError(
      `The journal lock file ${file} is corrupt (it is not a database). Restore it from backup or point the runtime at ` +
        `the journal directory this agent's earlier processes used; deleting it discards the journal's authority, so do not do that casually.`,
      "corrupt",
      file,
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new JournalOwnershipError(
    `The journal lock file ${file} could not be opened: ${message}. Check the path and the file system it is on; ` +
      `the journal stays closed until the lock file is usable.`,
    "io",
    file,
    error,
  );
}
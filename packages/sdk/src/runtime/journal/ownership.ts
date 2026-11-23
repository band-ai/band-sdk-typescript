import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BandSdkError } from "../../core/errors";

type SqliteModule = Pick<typeof import("node:sqlite"), "DatabaseSync">;

/**
 * Loads `node:sqlite` by its official name. Bundled CJS output rewrites a
 * dynamic `import("node:sqlite")` without the `node:` prefix, where it would
 * resolve as an (uninstalled) package; asking the process for the builtin
 * names it correctly in a child process and in the bundle alike.
 */
async function loadNodeSqlite(): Promise<SqliteModule> {
  const builtin =
    typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("node:sqlite") : undefined;
  if (builtin !== undefined) return builtin;
  return await import("node:sqlite");
}

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
      module = await (options.loadSqlite ?? loadNodeSqlite)();
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

  /** Whether `release()` has already given the lock back. */
  public get isReleased(): boolean {
    return this.released;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

/** The lock failure of `file`: contention, a corrupt file, or an I/O fault. */
function classify(file: string, error: unknown): JournalOwnershipError {
  const message = error instanceof Error ? error.message : String(error);
  // Strip the path (and its basename) before substring kind checks so a file
  // named e.g. `locked.sqlite` inside an EACCES message is not treated as
  // SQLite lock contention.
  const lowered = message.toLowerCase();
  const haystack = lowered.split(file.toLowerCase()).join("").split(path.basename(file).toLowerCase()).join("");
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code).toUpperCase() : "";
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    haystack.includes("busy") ||
    haystack.includes("locked")
  ) {
    return new JournalOwnershipError(
      `Another process owns the journal at ${file}. Stop that process (or the runtime that started it) and try again; ` +
        `the lock is never stolen, and the journal stays closed meanwhile.`,
      "contention",
      file,
      error,
    );
  }
  if (haystack.includes("not a database")) {
    return new JournalOwnershipError(
      `The journal lock file ${file} is corrupt (it is not a database). Restore it from backup or point the runtime at ` +
        `the journal directory this agent's earlier processes used; deleting it discards the journal's authority, so do not do that casually.`,
      "corrupt",
      file,
      error,
    );
  }
  return new JournalOwnershipError(
    `The journal lock file ${file} could not be opened: ${message}. Check the path and the file system it is on; ` +
      `the journal stays closed until the lock file is usable.`,
    "io",
    file,
    error,
  );
}
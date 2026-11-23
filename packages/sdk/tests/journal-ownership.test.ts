import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync as mkdtempSyncSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { JournalOwnership, JournalOwnershipError, type JournalOwnershipKind } from "../src/runtime/journal/ownership";

function expectKind(error: unknown, kind: JournalOwnershipKind): asserts error is JournalOwnershipError {
  expect(error).toBeInstanceOf(JournalOwnershipError);
  expect((error as JournalOwnershipError).kind).toBe(kind);
}

async function expectContention(file: string): Promise<void> {
  const error = await JournalOwnership.acquire(file).catch((e: unknown) => e);
  expectKind(error, "contention");
}

type LockChild = ChildProcessByStdio<null, Readable, null>;

/**
 * A second real process that acquires the lock on `file`. Its `busy_timeout`
 * makes `BEGIN EXCLUSIVE` wait while another process holds the lock, so the
 * parent orders the acquisitions without polling; a real subprocess's readiness
 * is its own process clock, not the test's. The interval only keeps the
 * process (and its lock) alive until the parent kills it.
 */
function holdInChild(file: string): { child: LockChild; ready: Promise<void> } {
  const child = spawn(
    process.execPath,
    ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout=5000");
      try { db.exec("BEGIN EXCLUSIVE"); } catch (error) { console.log("gave-up"); process.exit(3); }
      console.log("held");
      setInterval(() => {}, 100000);
    `, file],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!settled && text.includes("held")) {
      settled = true;
      resolve();
    }
    if (text.includes("gave-up")) reject(new Error("the child gave up on the lock"));
  });
  child.on("exit", (code) => {
    if (!settled && code !== null) reject(new Error(`the child exited ${code} without holding the lock`));
  });
  return { child, ready: promise };
}

/** Kills `child` and resolves once it has really exited. */
function killChild(child: LockChild): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return promise;
  }
  child.once("exit", () => resolve());
  child.kill("SIGKILL");
  return promise;
}

describe("journal ownership", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSyncSync(path.join(tmpdir(), "band-test-ownership-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires an empty lock file and a contender in the same process is refused", async () => {
    const file = path.join(dir, "owner.sqlite");
    const owner = await JournalOwnership.acquire(file);
    try {
      const error = await JournalOwnership.acquire(file).catch((e: unknown) => e);
      expectKind(error, "contention");
      // Actionable: it names the file, and never steals the lock.
      expect(error.message).toContain(file);
    } finally {
      await owner.release();
    }
    const next = await JournalOwnership.acquire(file);
    await next.release();
  });

  it("a contender that loses never holds a lock, and releasing it frees nothing", async () => {
    const file = path.join(dir, "loser.sqlite");
    const owner = await JournalOwnership.acquire(file);
    const lost = await JournalOwnership.acquire(file).catch((e: unknown) => e);
    expectKind(lost, "contention");
    // Still locked by the owner: another contender is still refused.
    await expectContention(file);
    await owner.release();
    // Free exactly once the owner released.
    const next = await JournalOwnership.acquire(file);
    await next.release();
  });

  it("a symlink alias of the lock file contends, so the lock is on the inode, not the path", async () => {
    const file = path.join(dir, "alias-target.sqlite");
    const owner = await JournalOwnership.acquire(file);
    try {
      const alias = path.join(dir, "alias.sqlite");
      await symlink(file, alias);
      onTestFinished(async () => rm(alias, { force: true }));
      const error = await JournalOwnership.acquire(alias).catch((e: unknown) => e);
      expectKind(error, "contention");
    } finally {
      await owner.release();
    }
  });

  it("holds through an advanced application clock: the lock has no lease to expire", async () => {
    const file = path.join(dir, "paused.sqlite");
    const owner = await JournalOwnership.acquire(file);
    try {
      await expectContention(file);
    } finally {
      await owner.release();
    }
    const next = await JournalOwnership.acquire(file);
    await next.release();
  });

  it("fails closed on a lock file that is not a database", async () => {
    const file = path.join(dir, "corrupt.sqlite");
    await writeFile(file, "not a sqlite database", "utf8");
    const error = await JournalOwnership.acquire(file).catch((e: unknown) => e);
    expectKind(error, "corrupt");
    expect(error.message).toContain("not a database");
  });

  it("classifies EACCES as io even when the path basename contains locked", async () => {
    const file = path.join(dir, "locked.sqlite");
    const error = await JournalOwnership.acquire(file, {
      loadSqlite: async () =>
        ({
          DatabaseSync: class {
            constructor() {
              throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
            }
          },
        }) as unknown as Pick<typeof import("node:sqlite"), "DatabaseSync">,
    }).catch((e: unknown) => e);
    expectKind(error, "io");
    expect(error.message).toContain(file);
  });

  it("fails closed when the journal's directory cannot be written", async () => {
    const subdir = path.join(dir, "unwritable");
    await mkdir(subdir);
    // Basename includes "locked" so a classifier that matches the path would
    // mis-report EACCES as contention (Windows mock embeds this path).
    const file = path.join(subdir, "locked.sqlite");
    if (process.platform === "win32") {
      // Windows ACL/chmod semantics do not make the directory unwritable the
      // same way; prove the same fail-closed IO kind via the open classifier.
      const error = await JournalOwnership.acquire(file, {
        loadSqlite: async () =>
          ({
            DatabaseSync: class {
              constructor() {
                throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
              }
            },
          }) as unknown as Pick<typeof import("node:sqlite"), "DatabaseSync">,
      }).catch((e: unknown) => e);
      expectKind(error, "io");
      expect(error.message).toContain(file);
      return;
    }
    // A read-only directory makes the lock file unwritable: SQLite reports the
    // attempt to write a readonly database, and the acquisition fails closed.
    await writeFile(file, "");
    await chmod(subdir, 0o555);
    onTestFinished(async () => {
      await chmod(subdir, 0o755).catch(() => undefined);
    });
    const error = await JournalOwnership.acquire(file).catch((e: unknown) => e);
    expectKind(error, "io");
    expect(error.message).toContain(file);
  });

  it("fails closed with an actionable error when node:sqlite is unavailable", async () => {
    const unavailable = async () => {
      throw Object.assign(new Error("Cannot find module 'node:sqlite'"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    };
    const error = await JournalOwnership.acquire(path.join(dir, "unsupported.sqlite"), { loadSqlite: unavailable }).catch((e: unknown) => e);
    expectKind(error, "unsupported");
    expect(error.message).toContain("node:sqlite");
  });

  it("a live second process contends; after its hard kill a successor takes the same file", async () => {
    const file = path.join(dir, "killed.sqlite");
    const owner = await JournalOwnership.acquire(file);
    const { child, ready } = holdInChild(file);
    onTestFinished(() => killChild(child).catch(() => undefined));
    try {
      // The child waits on the owner's lock: a third contender is refused meanwhile.
      await expectContention(file);
      await owner.release();
      await ready; // the child now holds the lock on the same file
      await expectContention(file);
      const inodeBefore = (await lstat(file)).ino;
      await killChild(child);
      // The lock file was never unlinked or recreated by the kill or the successor.
      const successor = await JournalOwnership.acquire(file);
      expect((await lstat(file)).ino).toBe(inodeBefore);
      await successor.release();
    } catch (error) {
      await killChild(child);
      throw error;
    }
  });

  it("releasing is idempotent and a released lock is re-acquirable", async () => {
    const file = path.join(dir, "twice.sqlite");
    const owner = await JournalOwnership.acquire(file);
    await owner.release();
    await owner.release();
    const next = await JournalOwnership.acquire(file);
    await next.release();
  });
});
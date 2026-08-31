/**
 * P-STO-01..06 and P-C4-2 proofs for the C4 room-metadata slice.
 *
 * The public Linear contracts expose `bandRoomId`; the physical SQLite schema
 * retains `thenvoi_room_id`, both `linear_thenvoi_*` table/index names, and any
 * unrelated objects/pragmas. These proofs open the store through the real
 * `createSqliteSessionRoomStore` entry point and compare `sqlite_master`,
 * `PRAGMA user_version`, and row values — not counts alone.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SKIP_WITHOUT_NODE_SQLITE } from "./support/nodeSqlite";

import { createSqliteSessionRoomStore } from "../src/linear";
import { COMPILE_PROOF_OPTS, compileConsumer, linkBuiltSdk } from "./support/compileProof";

const SDK_ROOT = resolve(__dirname, "..");
// node:sqlite is a runtime-selected native module (Node 22+); the store loads it
// via dynamic import, so the tests load it the same way to seed/inspect fixtures.
async function openRawDb(path: string) {
  const mod = await import("node:sqlite");
  return new mod.DatabaseSync(path);
}

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS linear_thenvoi_session_rooms (
    linear_session_id TEXT PRIMARY KEY,
    linear_issue_id TEXT,
    thenvoi_room_id TEXT NOT NULL,
    status TEXT NOT NULL,
    last_event_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_linear_activity_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_linear_thenvoi_session_rooms_issue_active
    ON linear_thenvoi_session_rooms (linear_issue_id, status, updated_at);
  CREATE TABLE IF NOT EXISTS linear_thenvoi_bootstrap_requests (
    event_key TEXT PRIMARY KEY,
    linear_session_id TEXT NOT NULL,
    thenvoi_room_id TEXT NOT NULL,
    expected_content TEXT NOT NULL,
    message_type TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_linear_thenvoi_bootstrap_requests_pending
    ON linear_thenvoi_bootstrap_requests (processed_at, expires_at, created_at);
`;

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function dumpSchema(path: string): Promise<{ objects: SchemaObject[]; userVersion: number }> {
  const db = await openRawDb(path);
  try {
    // Include `sql` so an added/renamed/retyped column is caught — selecting only
    // type/name/tbl_name is false-green against column-level changes.
    const objects = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
      .all() as unknown as SchemaObject[];
    const version = db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    return { objects, userVersion: version.user_version };
  } finally {
    db.close();
  }
}

interface ColumnInfo {
  name: string;
}

async function tableColumns(path: string, table: string): Promise<string[]> {
  const db = await openRawDb(path);
  try {
    const cols = db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table) as unknown as ColumnInfo[];
    return cols.map((c) => c.name);
  } finally {
    db.close();
  }
}

describe.skipIf(SKIP_WITHOUT_NODE_SQLITE)("P-STO: no-DDL storage compatibility matrix", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0, cleanups.length)) {
      await cleanup();
    }
    delete process.env.LINEAR_THENVOI_STATE_DB;
    delete process.env.LINEAR_BAND_STATE_DB;
    vi.restoreAllMocks();
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("P-STO-01: existing DB (session + bootstrap rows, unrelated objects, user_version=42) is preserved; Band fields round-trip", async () => {
    const dir = await tempDir("c4-sto01-");
    const dbPath = join(dir, "existing.sqlite");

    // Seed an existing database with the CURRENT legacy schema (includes
    // last_event_key, so the store's additive init is a no-op), representative
    // session + bootstrap rows, an unrelated object, and a user_version.
    const seed = await openRawDb(dbPath);
    seed.exec(LEGACY_SCHEMA);
    seed.exec("CREATE TABLE unrelated_widget (id INTEGER PRIMARY KEY, note TEXT);");
    seed.exec("CREATE INDEX idx_unrelated_widget_note ON unrelated_widget (note);");
    seed.exec("INSERT INTO unrelated_widget (id, note) VALUES (1, 'keep me');");
    seed.exec("PRAGMA user_version = 42;");
    seed
      .prepare(
        `INSERT INTO linear_thenvoi_session_rooms
         (linear_session_id, linear_issue_id, thenvoi_room_id, status, last_event_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("session-1", "issue-1", "room-existing", "active", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    seed
      .prepare(
        `INSERT INTO linear_thenvoi_bootstrap_requests
         (event_key, linear_session_id, thenvoi_room_id, expected_content, message_type, metadata_json, created_at, expires_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("evt-existing", "session-1", "room-existing", "bootstrap", "task", null, "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", null);
    seed.close();

    const before = await dumpSchema(dbPath);

    // Open through the real store and exercise reads + writes via Band public types.
    const store = createSqliteSessionRoomStore(dbPath);
    const loaded = await store.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-existing");

    // The seeded bootstrap row round-trips to the public bandRoomId field.
    const pendingBefore = await store.listPendingBootstrapRequests();
    expect(pendingBefore.find((p) => p.eventKey === "evt-existing")?.bandRoomId).toBe("room-existing");

    await store.upsert({
      linearSessionId: "session-2",
      linearIssueId: "issue-2",
      bandRoomId: "room-new",
      status: "active",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await store.enqueueBootstrapRequest({
      eventKey: "evt-new",
      linearSessionId: "session-2",
      bandRoomId: "room-new",
      expectedContent: "bootstrap",
      messageType: "task",
      createdAt: "2026-01-02T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.close?.();

    const after = await dumpSchema(dbPath);

    // Full schema (including each object's SQL), unrelated objects, and version
    // are all unchanged by opening/writing through the new code.
    expect(after.objects).toEqual(before.objects);
    expect(after.userVersion).toBe(42);
    expect(after.objects.map((o) => o.name)).toContain("unrelated_widget");

    // New public writes land in the retained physical thenvoi_room_id columns.
    const raw = await openRawDb(dbPath);
    try {
      const sessionRow = raw
        .prepare("SELECT thenvoi_room_id FROM linear_thenvoi_session_rooms WHERE linear_session_id = ?")
        .get("session-2") as unknown as { thenvoi_room_id: string };
      expect(sessionRow.thenvoi_room_id).toBe("room-new");
      const bootRow = raw
        .prepare("SELECT thenvoi_room_id FROM linear_thenvoi_bootstrap_requests WHERE event_key = ?")
        .get("evt-new") as unknown as { thenvoi_room_id: string };
      expect(bootRow.thenvoi_room_id).toBe("room-new");
      const unrelated = raw.prepare("SELECT note FROM unrelated_widget WHERE id = 1").get() as unknown as { note: string };
      expect(unrelated.note).toBe("keep me");
    } finally {
      raw.close();
    }
  });

  it("P-STO-02: fresh path creates the legacy physical schema and exposes Band fields; no Band physical identifiers", async () => {
    const dir = await tempDir("c4-sto02-");
    const dbPath = join(dir, "fresh.sqlite");

    const store = createSqliteSessionRoomStore(dbPath);
    await store.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      bandRoomId: "room-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const loaded = await store.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-1");
    await store.close?.();

    const { objects } = await dumpSchema(dbPath);
    const names = objects.map((o) => o.name);
    expect(names).toContain("linear_thenvoi_session_rooms");
    expect(names).toContain("linear_thenvoi_bootstrap_requests");
    expect(names).toContain("idx_linear_thenvoi_session_rooms_issue_active");
    expect(names).toContain("idx_linear_thenvoi_bootstrap_requests_pending");
    // No Band physical identifier leaked into the schema.
    const schemaText = JSON.stringify(objects);
    expect(schemaText).not.toMatch(/linear_band_/);
    expect(schemaText).not.toMatch(/band_room_id/);

    // Both physical tables use thenvoi_room_id, neither uses band_room_id.
    const sessionCols = await tableColumns(dbPath, "linear_thenvoi_session_rooms");
    expect(sessionCols).toContain("thenvoi_room_id");
    expect(sessionCols).not.toContain("band_room_id");
    const bootCols = await tableColumns(dbPath, "linear_thenvoi_bootstrap_requests");
    expect(bootCols).toContain("thenvoi_room_id");
    expect(bootCols).not.toContain("band_room_id");
  });

  it("P-STO-03: session bindings AND bootstrap records alternate old/new code on one file without duplication", async () => {
    const dir = await tempDir("c4-sto03-");
    const dbPath = join(dir, "alt.sqlite");

    // New code creates the schema, a session binding, and a bootstrap request.
    const store1 = createSqliteSessionRoomStore(dbPath);
    await store1.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      bandRoomId: "room-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store1.enqueueBootstrapRequest({
      eventKey: "evt-1",
      linearSessionId: "session-1",
      bandRoomId: "room-1",
      expectedContent: "bootstrap",
      messageType: "task",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store1.close?.();

    // Old code opens the same file and updates both the session binding and the
    // bootstrap request through the retained physical thenvoi_room_id column.
    const raw = await openRawDb(dbPath);
    raw
      .prepare(
        `INSERT INTO linear_thenvoi_session_rooms
         (linear_session_id, linear_issue_id, thenvoi_room_id, status, last_event_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linear_session_id) DO UPDATE SET thenvoi_room_id = excluded.thenvoi_room_id, updated_at = excluded.updated_at`,
      )
      .run("session-1", "issue-1", "room-1-updated", "active", null, "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    raw
      .prepare(
        `INSERT INTO linear_thenvoi_bootstrap_requests
         (event_key, linear_session_id, thenvoi_room_id, expected_content, message_type, metadata_json, created_at, expires_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET thenvoi_room_id = excluded.thenvoi_room_id`,
      )
      .run("evt-1", "session-1", "room-1-updated", "bootstrap", "task", null, "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", null);
    const sessionCount = raw.prepare("SELECT COUNT(*) AS n FROM linear_thenvoi_session_rooms").get() as unknown as { n: number };
    const bootCount = raw.prepare("SELECT COUNT(*) AS n FROM linear_thenvoi_bootstrap_requests").get() as unknown as { n: number };
    raw.close();
    expect(sessionCount.n).toBe(1); // session binding reused, not duplicated
    expect(bootCount.n).toBe(1); // bootstrap record reused, not duplicated

    // New code reopens and reads both old-code writes through Band public fields.
    const store2 = createSqliteSessionRoomStore(dbPath);
    const loaded = await store2.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-1-updated");
    const pending = await store2.listPendingBootstrapRequests();
    const boot = pending.find((p) => p.eventKey === "evt-1");
    expect(boot?.bandRoomId).toBe("room-1-updated");
    await store2.close?.();
  });

  it("P-STO-04: default `.linear-thenvoi-example.sqlite` is reused; no `.linear-band-example.sqlite` is created", async () => {
    const dir = await tempDir("c4-sto04-");
    const defaultPath = join(dir, ".linear-thenvoi-example.sqlite");
    const bandPath = join(dir, ".linear-band-example.sqlite");

    // Seed the compatibility default file with a binding.
    const seedStore = createSqliteSessionRoomStore(defaultPath);
    await seedStore.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      bandRoomId: "room-default",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedStore.close?.();

    // Reopen the same default path and confirm reuse; no Band-named file appears.
    const store = createSqliteSessionRoomStore(defaultPath);
    const loaded = await store.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-default");
    await store.close?.();

    expect(existsSync(defaultPath)).toBe(true);
    expect(existsSync(bandPath)).toBe(false);
  });

  it("P-STO-05: a custom path is reused exactly; no default DB is opened alongside it", async () => {
    const dir = await tempDir("c4-sto05-");
    const customPath = join(dir, "custom-state.sqlite");
    const defaultPath = join(dir, ".linear-thenvoi-example.sqlite");

    const seedStore = createSqliteSessionRoomStore(customPath);
    await seedStore.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      bandRoomId: "room-custom",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedStore.close?.();

    const store = createSqliteSessionRoomStore(customPath);
    const loaded = await store.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-custom");
    await store.close?.();

    expect(existsSync(customPath)).toBe(true);
    expect(existsSync(defaultPath)).toBe(false);
  });

  it("P-STO-06: the store source contains no schema-changing DDL and no Band physical identifiers", async () => {
    const source = await readFile(join(SDK_ROOT, "src/integrations/linear/store.ts"), "utf-8");
    // Retained physical vocabulary is present.
    expect(source).toMatch(/linear_thenvoi_session_rooms/);
    expect(source).toMatch(/thenvoi_room_id/);
    // No migration/rename/drop/version DDL, and no Band physical identifier.
    expect(source).not.toMatch(/PRAGMA\s+user_version\s*=/i);
    expect(source).not.toMatch(/ALTER\s+TABLE\s+\S+\s+RENAME/i);
    expect(source).not.toMatch(/DROP\s+(TABLE|INDEX)/i);
    expect(source).not.toMatch(/linear_band_/);
    expect(source).not.toMatch(/band_room_id/);
  });
});

// ── P-C4-2: public room-id field compile proof ───────────────────────────────

describe("P-C4-2: public room-id field compile proof", COMPILE_PROOF_OPTS, () => {
  let tmpDirPath: string;

  afterEach(() => {
    if (tmpDirPath) rm(tmpDirPath, { recursive: true, force: true });
  });

  function compile(filename: string, code: string): { status: number; output: string } {
    const base = mkdtempSync(join(tmpdir(), "c4-compile-"));
    tmpDirPath = base;
    linkBuiltSdk(base);
    return compileConsumer(base, filename, code);
  }

  const record = (roomField: string) => `
    import type { SessionRoomRecord } from "@band-ai/sdk/linear";
    const record: SessionRoomRecord = {
      linearSessionId: "s",
      linearIssueId: "i",
      ${roomField}: "room",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const _roomId: string = record.${roomField};
  `;

  it("ESM consumer: new bandRoomId field compiles via NodeNext package exports", () => {
    const result = compile("consumer.mts", record("bandRoomId"));
    expect(result.status).toBe(0);
  });

  it("ESM consumer: old thenvoiRoomId field fails to compile", () => {
    const result = compile("old.mts", record("thenvoiRoomId"));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/bandRoomId|thenvoiRoomId/);
  });

  it("CJS consumer: new bandRoomId field compiles via NodeNext package exports", () => {
    const result = compile("consumer.cts", record("bandRoomId"));
    expect(result.status).toBe(0);
  });

  it("CJS consumer: old thenvoiRoomId field fails to compile", () => {
    const result = compile("old.cts", record("thenvoiRoomId"));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/bandRoomId|thenvoiRoomId/);
  });
});

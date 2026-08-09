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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, cpSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteSessionRoomStore } from "../src/linear";

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
    updated_at TEXT NOT NULL
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
}

async function dumpSchema(path: string): Promise<{ objects: SchemaObject[]; userVersion: number }> {
  const db = await openRawDb(path);
  try {
    const objects = db
      .prepare("SELECT type, name, tbl_name FROM sqlite_master ORDER BY name")
      .all() as unknown as SchemaObject[];
    const version = db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    return { objects, userVersion: version.user_version };
  } finally {
    db.close();
  }
}

describe("P-STO: no-DDL storage compatibility matrix", () => {
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

  it("P-STO-01: existing DB with rows, unrelated objects, and user_version=42 is preserved; Band fields round-trip", async () => {
    const dir = await tempDir("c4-sto01-");
    const dbPath = join(dir, "existing.sqlite");

    // Seed an existing database: legacy schema + rows + unrelated object + version.
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
    seed.close();

    const before = await dumpSchema(dbPath);

    // Open through the real store and exercise read + write via Band public types.
    const store = createSqliteSessionRoomStore(dbPath);
    const loaded = await store.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-existing");

    await store.upsert({
      linearSessionId: "session-2",
      linearIssueId: "issue-2",
      bandRoomId: "room-new",
      status: "active",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await store.close?.();

    const after = await dumpSchema(dbPath);

    // Physical schema, unrelated objects, and version are all unchanged.
    expect(after.objects).toEqual(before.objects);
    expect(after.userVersion).toBe(42);
    expect(after.objects.map((o) => o.name)).toContain("unrelated_widget");
    expect(after.objects.map((o) => o.name)).toContain("linear_thenvoi_session_rooms");
    expect(after.objects.map((o) => o.name)).toContain("linear_thenvoi_bootstrap_requests");

    // The new record is stored in the retained physical column.
    const raw = await openRawDb(dbPath);
    try {
      const row = raw
        .prepare("SELECT thenvoi_room_id FROM linear_thenvoi_session_rooms WHERE linear_session_id = ?")
        .get("session-2") as unknown as { thenvoi_room_id: string };
      expect(row.thenvoi_room_id).toBe("room-new");
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

    // The physical column is thenvoi_room_id, not band_room_id.
    const raw = await openRawDb(dbPath);
    try {
      const cols = raw
        .prepare("SELECT name FROM pragma_table_info('linear_thenvoi_session_rooms')")
        .all() as unknown as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("thenvoi_room_id");
      expect(colNames).not.toContain("band_room_id");
    } finally {
      raw.close();
    }
  });

  it("P-STO-03: old-code (raw SQL) and new-code (store) operations alternate on one file without duplication", async () => {
    const dir = await tempDir("c4-sto03-");
    const dbPath = join(dir, "alt.sqlite");

    // New code creates the schema and a binding.
    const store1 = createSqliteSessionRoomStore(dbPath);
    await store1.upsert({
      linearSessionId: "session-1",
      linearIssueId: "issue-1",
      bandRoomId: "room-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store1.close?.();

    // Old code opens the same file and upserts through the physical column.
    const raw = await openRawDb(dbPath);
    raw
      .prepare(
        `INSERT INTO linear_thenvoi_session_rooms
         (linear_session_id, linear_issue_id, thenvoi_room_id, status, last_event_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linear_session_id) DO UPDATE SET thenvoi_room_id = excluded.thenvoi_room_id, updated_at = excluded.updated_at`,
      )
      .run("session-1", "issue-1", "room-1-updated", "active", null, "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const count = raw.prepare("SELECT COUNT(*) AS n FROM linear_thenvoi_session_rooms").get() as unknown as { n: number };
    raw.close();
    expect(count.n).toBe(1); // reused, not duplicated

    // New code reopens and reads the old-code write through the Band field.
    const store2 = createSqliteSessionRoomStore(dbPath);
    const loaded = await store2.getBySessionId("session-1");
    expect(loaded?.bandRoomId).toBe("room-1-updated");
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

describe("P-C4-2: public room-id field compile proof", () => {
  let tmpDirPath: string;

  afterEach(() => {
    if (tmpDirPath) rm(tmpDirPath, { recursive: true, force: true });
  });

  function compileConsumer(filename: string, code: string): { status: number; output: string } {
    const base = join(tmpdir(), `c4-compile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    tmpDirPath = base;
    const nmDir = join(base, "node_modules/@thenvoi/sdk");
    mkdirSync(nmDir, { recursive: true });
    cpSync(join(SDK_ROOT, "dist"), join(nmDir, "dist"), { recursive: true });
    cpSync(join(SDK_ROOT, "package.json"), join(nmDir, "package.json"));
    writeFileSync(join(base, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        noEmit: true,
        skipLibCheck: true,
        typeRoots: [join(SDK_ROOT, "node_modules/@types")],
      },
      include: [filename],
    }));
    writeFileSync(join(base, filename), code);
    const result = spawnSync(join(SDK_ROOT, "node_modules/.bin/tsc"), ["-p", join(base, "tsconfig.json")], {
      encoding: "utf8",
    });
    return { status: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }

  const record = (roomField: string) => `
    import type { SessionRoomRecord } from "@thenvoi/sdk/linear";
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
    const result = compileConsumer("consumer.mts", record("bandRoomId"));
    expect(result.status).toBe(0);
  });

  it("ESM consumer: old thenvoiRoomId field fails to compile", () => {
    const result = compileConsumer("old.mts", record("thenvoiRoomId"));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/bandRoomId|thenvoiRoomId/);
  });

  it("CJS consumer: new bandRoomId field compiles via NodeNext package exports", () => {
    const result = compileConsumer("consumer.cts", record("bandRoomId"));
    expect(result.status).toBe(0);
  });

  it("CJS consumer: old thenvoiRoomId field fails to compile", () => {
    const result = compileConsumer("old.cts", record("thenvoiRoomId"));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/bandRoomId|thenvoiRoomId/);
  });
});

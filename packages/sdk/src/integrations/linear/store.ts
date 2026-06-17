import { UnsupportedFeatureError } from "../../core/errors";
import type { PendingBootstrapRequest, SessionRoomRecord, SessionRoomStore } from "./types";

type DatabaseSync = import("node:sqlite").DatabaseSync;

interface SessionRoomRow {
  linear_session_id: string;
  linear_issue_id: string | null;
  thenvoi_room_id: string;
  status: SessionRoomRecord["status"];
  last_event_key: string | null;
  last_linear_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BootstrapRequestRow {
  event_key: string;
  linear_session_id: string;
  thenvoi_room_id: string;
  expected_content: string;
  message_type: string;
  metadata_json: string | null;
  created_at: string;
  expires_at: string;
  processed_at: string | null;
}

const SESSION_STATUSES = new Set<SessionRoomRecord["status"]>([
  "active",
  "waiting",
  "completed",
  "canceled",
  "errored",
]);

/** SQLite-backed session room store. Uses `node:sqlite` (lazily imported). */
class SqliteSessionRoomStore implements SessionRoomStore {
  private readonly dbPath: string;
  private dbPromise: Promise<DatabaseSync> | null = null;

  public constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  public async getBySessionId(sessionId: string): Promise<SessionRoomRecord | null> {
    const db = await this.getDb();
    const rawRow = db
      .prepare(
        `
        SELECT
          linear_session_id,
          linear_issue_id,
          thenvoi_room_id,
          status,
          last_event_key,
          last_linear_activity_at,
          created_at,
          updated_at
        FROM linear_thenvoi_session_rooms
        WHERE linear_session_id = ?
        LIMIT 1
        `,
      )
      .get(sessionId);
    const row = parseSessionRoomRow(rawRow);

    return row ? this.toRecord(row) : null;
  }

  public async getByIssueId(issueId: string): Promise<SessionRoomRecord | null> {
    const db = await this.getDb();
    const rawRow = db
      .prepare(
        `
        SELECT
          linear_session_id,
          linear_issue_id,
          thenvoi_room_id,
          status,
          last_event_key,
          last_linear_activity_at,
          created_at,
          updated_at
        FROM linear_thenvoi_session_rooms
        WHERE linear_issue_id = ? AND status != 'canceled'
        ORDER BY updated_at DESC
        LIMIT 1
        `,
      )
      .get(issueId);
    const row = parseSessionRoomRow(rawRow);

    return row ? this.toRecord(row) : null;
  }

  public async upsert(record: SessionRoomRecord): Promise<void> {
    const db = await this.getDb();
    db
      .prepare(
        `
        INSERT INTO linear_thenvoi_session_rooms (
          linear_session_id,
          linear_issue_id,
          thenvoi_room_id,
          status,
          last_event_key,
          last_linear_activity_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(linear_session_id)
        DO UPDATE SET
          linear_issue_id = excluded.linear_issue_id,
          thenvoi_room_id = excluded.thenvoi_room_id,
          status = excluded.status,
          last_event_key = excluded.last_event_key,
          last_linear_activity_at = excluded.last_linear_activity_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        record.linearSessionId,
        record.linearIssueId,
        record.thenvoiRoomId,
        record.status,
        record.lastEventKey ?? null,
        record.lastLinearActivityAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async markCanceled(sessionId: string): Promise<void> {
    const db = await this.getDb();
    db
      .prepare(
        `
        UPDATE linear_thenvoi_session_rooms
        SET status = 'canceled', updated_at = ?
        WHERE linear_session_id = ?
        `,
      )
      .run(new Date().toISOString(), sessionId);
  }

  public async enqueueBootstrapRequest(request: PendingBootstrapRequest): Promise<void> {
    const db = await this.getDb();
    db
      .prepare(
        `
        INSERT INTO linear_thenvoi_bootstrap_requests (
          event_key,
          linear_session_id,
          thenvoi_room_id,
          expected_content,
          message_type,
          metadata_json,
          created_at,
          expires_at,
          processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(event_key)
        DO UPDATE SET
          linear_session_id = excluded.linear_session_id,
          thenvoi_room_id = excluded.thenvoi_room_id,
          expected_content = excluded.expected_content,
          message_type = excluded.message_type,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          processed_at = NULL
        `,
      )
      .run(
        request.eventKey,
        request.linearSessionId,
        request.thenvoiRoomId,
        request.expectedContent,
        request.messageType,
        request.metadata ? JSON.stringify(request.metadata) : null,
        request.createdAt,
        request.expiresAt,
      );
  }

  public async listPendingBootstrapRequests(limit = 20): Promise<PendingBootstrapRequest[]> {
    const db = await this.getDb();
    const rawRows = db
      .prepare(
        `
        SELECT
          event_key,
          linear_session_id,
          thenvoi_room_id,
          expected_content,
          message_type,
          metadata_json,
          created_at,
          expires_at,
          processed_at
        FROM linear_thenvoi_bootstrap_requests
        WHERE processed_at IS NULL AND expires_at > ?
        ORDER BY created_at ASC
        LIMIT ?
        `,
      )
      .all(new Date().toISOString(), limit);
    const rows = parseBootstrapRequestRows(rawRows);

    return rows.map((row) => ({
      eventKey: row.event_key,
      linearSessionId: row.linear_session_id,
      thenvoiRoomId: row.thenvoi_room_id,
      expectedContent: row.expected_content,
      messageType: row.message_type,
      metadata: this.parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  public async markBootstrapRequestProcessed(eventKey: string): Promise<void> {
    const db = await this.getDb();
    db
      .prepare(
        `
        UPDATE linear_thenvoi_bootstrap_requests
        SET processed_at = ?
        WHERE event_key = ? AND processed_at IS NULL
        `,
      )
      .run(new Date().toISOString(), eventKey);
  }

  public async listActiveSessions(): Promise<SessionRoomRecord[]> {
    const db = await this.getDb();
    const rawRows = db
      .prepare(
        `
        SELECT
          linear_session_id,
          linear_issue_id,
          thenvoi_room_id,
          status,
          last_event_key,
          last_linear_activity_at,
          created_at,
          updated_at
        FROM linear_thenvoi_session_rooms
        WHERE status IN ('active', 'waiting')
        ORDER BY updated_at DESC
        `,
      )
      .all();

    if (!Array.isArray(rawRows)) {
      return [];
    }

    return rawRows
      .map((raw) => parseSessionRoomRow(raw))
      .filter((row): row is SessionRoomRow => row !== null)
      .map((row) => this.toRecord(row));
  }

  public async close(): Promise<void> {
    if (!this.dbPromise) {
      return;
    }

    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }

  private async getDb(): Promise<DatabaseSync> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = this.initialize();
    return this.dbPromise;
  }

  private async initialize(): Promise<DatabaseSync> {
    const module = await import("node:sqlite").catch((error: unknown) => {
      throw new UnsupportedFeatureError(
        `SQLite store requires node:sqlite (Node.js 22+). Original error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    const db = new module.DatabaseSync(this.dbPath);
    db.exec(`
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
    `);

    try {
      db.exec(`
        ALTER TABLE linear_thenvoi_session_rooms
        ADD COLUMN last_event_key TEXT
      `);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }

    try {
      db.exec(`
        ALTER TABLE linear_thenvoi_bootstrap_requests
        ADD COLUMN message_type TEXT NOT NULL DEFAULT 'task'
      `);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }

    try {
      db.exec(`
        ALTER TABLE linear_thenvoi_bootstrap_requests
        ADD COLUMN metadata_json TEXT
      `);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }

    try {
      db.exec(`
        ALTER TABLE linear_thenvoi_session_rooms
        ADD COLUMN last_linear_activity_at TEXT
      `);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }

    return db;
  }

  private toRecord(row: SessionRoomRow): SessionRoomRecord {
    return {
      linearSessionId: row.linear_session_id,
      linearIssueId: row.linear_issue_id,
      thenvoiRoomId: row.thenvoi_room_id,
      status: row.status,
      lastEventKey: row.last_event_key,
      lastLinearActivityAt: row.last_linear_activity_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseMetadata(metadataJson: string | null): Record<string, unknown> | undefined {
    if (!metadataJson) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      return asRecord(parsed) ?? undefined;
    } catch (error) {
      // Log but don't throw — corrupted metadata shouldn't block the row
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`SqliteSessionRoomStore: failed to parse metadata_json: ${msg}`);
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /duplicate column name/i.test(error.message);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  return asString(value);
}

function isSessionStatus(value: string): value is SessionRoomRecord["status"] {
  return SESSION_STATUSES.has(value as SessionRoomRecord["status"]);
}

function parseSessionRoomRow(value: unknown): SessionRoomRow | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const linearSessionId = asString(row.linear_session_id);
  const linearIssueId = asNullableString(row.linear_issue_id);
  const thenvoiRoomId = asString(row.thenvoi_room_id);
  const status = asString(row.status);
  const lastEventKey = asNullableString(row.last_event_key);
  const lastLinearActivityAt = asNullableString(row.last_linear_activity_at);
  const createdAt = asString(row.created_at);
  const updatedAt = asString(row.updated_at);

  if (
    !linearSessionId
    || linearIssueId === undefined
    || !thenvoiRoomId
    || !status
    || !isSessionStatus(status)
    || lastEventKey === undefined
    || lastLinearActivityAt === undefined
    || !createdAt
    || !updatedAt
  ) {
    return null;
  }

  return {
    linear_session_id: linearSessionId,
    linear_issue_id: linearIssueId,
    thenvoi_room_id: thenvoiRoomId,
    status,
    last_event_key: lastEventKey,
    last_linear_activity_at: lastLinearActivityAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseBootstrapRequestRows(value: unknown): BootstrapRequestRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => parseBootstrapRequestRow(entry))
    .filter((entry): entry is BootstrapRequestRow => entry !== null);
}

function parseBootstrapRequestRow(value: unknown): BootstrapRequestRow | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const eventKey = asString(row.event_key);
  const linearSessionId = asString(row.linear_session_id);
  const thenvoiRoomId = asString(row.thenvoi_room_id);
  const expectedContent = asString(row.expected_content);
  const messageType = asString(row.message_type);
  const metadataJson = asNullableString(row.metadata_json);
  const createdAt = asString(row.created_at);
  const expiresAt = asString(row.expires_at);
  const processedAt = asNullableString(row.processed_at);

  if (
    !eventKey
    || !linearSessionId
    || !thenvoiRoomId
    || !expectedContent
    || !messageType
    || metadataJson === undefined
    || !createdAt
    || !expiresAt
    || processedAt === undefined
  ) {
    return null;
  }

  return {
    event_key: eventKey,
    linear_session_id: linearSessionId,
    thenvoi_room_id: thenvoiRoomId,
    expected_content: expectedContent,
    message_type: messageType,
    metadata_json: metadataJson,
    created_at: createdAt,
    expires_at: expiresAt,
    processed_at: processedAt,
  };
}

export function createSqliteSessionRoomStore(dbPath: string): SessionRoomStore {
  return new SqliteSessionRoomStore(dbPath);
}

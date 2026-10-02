import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

const SESSION_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const AGENT_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
export const AGENT_LEASE_TTL_MS = 5_000;
export const AGENT_LEASE_HEARTBEAT_MS = 2_000;

export interface ClaudeSessionContext {
  sessionId: string;
  projectRoot: string;
}

export interface StoredAgent {
  agentId: string;
  name: string;
}

interface BindingRow {
  agent_id: string;
}

interface AgentRow {
  agent_id: string;
  name: string;
}

interface LeaseRow {
  session_id: string;
  instance_id: string;
  expires_at_ms: number;
}

export interface CommandAuthorizationProfile {
  scope: string;
  projectRoot: string;
  agentId: string;
}

export interface MessageDelivery {
  scope: string;
  agentId: string;
  sessionId: string;
  messageId: string;
}

export type StoredCommandAccess =
  | { kind: "allow_all" }
  | { kind: "allow_command" }
  | { kind: "denied"; note: string | null; expiresAtMs: number }
  | { kind: "prompt" };

interface CommandDenialRow {
  expires_at_ms: number;
  note: string | null;
}

export function pluginDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Band", "claude-code");
  }
  if (process.platform === "win32") {
    return path.join(env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Band", "claude-code");
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "band", "claude-code");
}

export async function resolveClaudeSessionContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeSessionContext> {
  const session = SESSION_ID_SCHEMA.safeParse(env.CLAUDE_CODE_SESSION_ID);
  if (!session.success) {
    throw new Error("CLAUDE_CODE_SESSION_ID is missing or invalid");
  }
  const project = env.CLAUDE_PROJECT_DIR;
  if (project === undefined || !path.isAbsolute(project)) {
    throw new Error("CLAUDE_PROJECT_DIR is missing or invalid");
  }
  const projectRoot = await realpath(project);
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("CLAUDE_PROJECT_DIR did not resolve to an absolute path");
  }
  return { sessionId: session.data, projectRoot };
}

export function humanScope(platformOrigin: string, profileId: string): string {
  return JSON.stringify({ platformOrigin, profileId });
}

export function agentCredentialKey(scope: string, agentId: string): string {
  const canonicalAgentId = AGENT_ID_SCHEMA.parse(agentId);
  const digest = createHash("sha256").update(scope).digest("hex");
  return `agent-${digest}-${canonicalAgentId}`;
}

export class PluginStateStore {
  public readonly instanceId = randomUUID();
  private readonly db: DatabaseSync;

  public constructor(root: string, private readonly now: () => number = () => Date.now()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "session-state.sqlite"), { timeout: 5_000 });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        scope TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (scope, agent_id)
      );
      CREATE TABLE IF NOT EXISTS session_bindings (
        scope TEXT NOT NULL,
        project_root TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, project_root, session_id)
      );
      CREATE TABLE IF NOT EXISTS agent_leases (
        scope TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, agent_id)
      );
      CREATE TABLE IF NOT EXISTS command_allowlist (
        scope TEXT NOT NULL,
        project_root TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        command TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, project_root, agent_id, sender_id, command)
      );
      CREATE TABLE IF NOT EXISTS command_denials (
        scope TEXT NOT NULL,
        project_root TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        note TEXT,
        PRIMARY KEY (scope, project_root, agent_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS delivered_messages (
        scope TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        delivered_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, agent_id, session_id, message_id)
      );
    `);
  }

  public saveAgent(scope: string, agent: StoredAgent): void {
    const agentId = AGENT_ID_SCHEMA.parse(agent.agentId);
    if (agent.name.length < 1 || agent.name.length > 100) throw new Error("Agent name is invalid");
    this.db.prepare(
      `INSERT INTO agents (scope, agent_id, name) VALUES (?, ?, ?)
       ON CONFLICT(scope, agent_id) DO UPDATE SET name = excluded.name`,
    ).run(scope, agentId, agent.name);
  }

  public listAgents(scope: string): StoredAgent[] {
    const rows = this.db.prepare(
      "SELECT agent_id, name FROM agents WHERE scope = ? ORDER BY name, agent_id",
    ).all(scope) as unknown as AgentRow[];
    return rows.map((row) => ({ agentId: row.agent_id, name: row.name }));
  }

  public getBinding(scope: string, context: ClaudeSessionContext): string | null {
    const row = this.db.prepare(
      `SELECT agent_id FROM session_bindings
       WHERE scope = ? AND project_root = ? AND session_id = ?`,
    ).get(scope, context.projectRoot, context.sessionId) as BindingRow | undefined;
    return row?.agent_id ?? null;
  }

  public bind(scope: string, context: ClaudeSessionContext, agentId: string): void {
    const canonicalAgentId = AGENT_ID_SCHEMA.parse(agentId);
    const existing = this.getBinding(scope, context);
    if (existing !== null && existing !== canonicalAgentId) {
      throw new Error("This Claude session is already bound to another Band agent");
    }
    const timestamp = this.now();
    this.db.prepare(
      `INSERT INTO session_bindings (
         scope, project_root, session_id, agent_id, created_at_ms, last_used_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, project_root, session_id) DO UPDATE SET
         last_used_at_ms = excluded.last_used_at_ms`,
    ).run(scope, context.projectRoot, context.sessionId, canonicalAgentId, timestamp, timestamp);
  }

  public acquireLease(scope: string, context: ClaudeSessionContext, agentId: string): boolean {
    const canonicalAgentId = AGENT_ID_SCHEMA.parse(agentId);
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `SELECT session_id, instance_id, expires_at_ms FROM agent_leases
         WHERE scope = ? AND agent_id = ?`,
      ).get(scope, canonicalAgentId) as LeaseRow | undefined;
      if (
        row !== undefined &&
        row.expires_at_ms > timestamp &&
        (row.session_id !== context.sessionId || row.instance_id !== this.instanceId)
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(
        `INSERT INTO agent_leases (scope, agent_id, session_id, instance_id, expires_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, agent_id) DO UPDATE SET
           session_id = excluded.session_id,
           instance_id = excluded.instance_id,
           expires_at_ms = excluded.expires_at_ms`,
      ).run(
        scope,
        canonicalAgentId,
        context.sessionId,
        this.instanceId,
        timestamp + AGENT_LEASE_TTL_MS,
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public heartbeatLease(scope: string, context: ClaudeSessionContext, agentId: string): boolean {
    const changed = this.db.prepare(
      `UPDATE agent_leases SET expires_at_ms = ?
       WHERE scope = ? AND agent_id = ? AND session_id = ? AND instance_id = ?`,
    ).run(
      this.now() + AGENT_LEASE_TTL_MS,
      scope,
      AGENT_ID_SCHEMA.parse(agentId),
      context.sessionId,
      this.instanceId,
    );
    return Number(changed.changes) === 1;
  }

  public leasedByAnotherSession(
    scope: string,
    context: ClaudeSessionContext,
    agentId: string,
  ): boolean {
    const row = this.db.prepare(
      `SELECT session_id, instance_id, expires_at_ms FROM agent_leases
       WHERE scope = ? AND agent_id = ?`,
    ).get(scope, AGENT_ID_SCHEMA.parse(agentId)) as LeaseRow | undefined;
    return row !== undefined &&
      row.expires_at_ms > this.now() &&
      (row.session_id !== context.sessionId || row.instance_id !== this.instanceId);
  }

  public releaseLease(scope: string, context: ClaudeSessionContext, agentId: string): void {
    this.db.prepare(
      `DELETE FROM agent_leases
       WHERE scope = ? AND agent_id = ? AND session_id = ? AND instance_id = ?`,
    ).run(scope, AGENT_ID_SCHEMA.parse(agentId), context.sessionId, this.instanceId);
  }

  public getCommandAccess(
    profile: CommandAuthorizationProfile,
    senderId: string,
    command: string,
  ): StoredCommandAccess {
    const agentId = AGENT_ID_SCHEMA.parse(profile.agentId);
    const denial = this.db.prepare(
      `SELECT expires_at_ms, note FROM command_denials
       WHERE scope = ? AND project_root = ? AND agent_id = ? AND sender_id = ?`,
    ).get(profile.scope, profile.projectRoot, agentId, senderId) as CommandDenialRow | undefined;
    if (denial !== undefined) {
      if (denial.expires_at_ms > this.now()) {
        return { kind: "denied", note: denial.note, expiresAtMs: denial.expires_at_ms };
      }
      this.db.prepare(
        `DELETE FROM command_denials
         WHERE scope = ? AND project_root = ? AND agent_id = ? AND sender_id = ?`,
      ).run(profile.scope, profile.projectRoot, agentId, senderId);
    }

    const rows = this.db.prepare(
      `SELECT command FROM command_allowlist
       WHERE scope = ? AND project_root = ? AND agent_id = ? AND sender_id = ?
         AND command IN ('*', ?)
       ORDER BY command`,
    ).all(profile.scope, profile.projectRoot, agentId, senderId, command) as unknown as Array<{
      command: string;
    }>;
    if (rows.some((row) => row.command === "*")) return { kind: "allow_all" };
    if (rows.length > 0) return { kind: "allow_command" };
    return { kind: "prompt" };
  }

  public allowCommand(
    profile: CommandAuthorizationProfile,
    senderId: string,
    command: string,
  ): void {
    this.storeCommandAllowance(profile, senderId, command);
  }

  public allowAllCommands(profile: CommandAuthorizationProfile, senderId: string): void {
    this.storeCommandAllowance(profile, senderId, "*");
  }

  public denyCommandsUntil(
    profile: CommandAuthorizationProfile,
    senderId: string,
    expiresAtMs: number,
    note: string | null,
  ): void {
    this.db.prepare(
      `INSERT INTO command_denials (
         scope, project_root, agent_id, sender_id, expires_at_ms, note
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, project_root, agent_id, sender_id) DO UPDATE SET
         expires_at_ms = excluded.expires_at_ms,
         note = excluded.note`,
    ).run(
      profile.scope,
      profile.projectRoot,
      AGENT_ID_SCHEMA.parse(profile.agentId),
      senderId,
      expiresAtMs,
      note,
    );
  }

  /** Whether `messageId` was already pushed into this exact Claude transcript. */
  public wasDelivered(delivery: MessageDelivery): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM delivered_messages
       WHERE scope = ? AND agent_id = ? AND session_id = ? AND message_id = ?`,
    ).get(
      delivery.scope,
      AGENT_ID_SCHEMA.parse(delivery.agentId),
      delivery.sessionId,
      delivery.messageId,
    );
    return row !== undefined;
  }

  public recordDelivered(delivery: MessageDelivery): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO delivered_messages (
         scope, agent_id, session_id, message_id, delivered_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      delivery.scope,
      AGENT_ID_SCHEMA.parse(delivery.agentId),
      delivery.sessionId,
      delivery.messageId,
      this.now(),
    );
  }

  private storeCommandAllowance(
    profile: CommandAuthorizationProfile,
    senderId: string,
    command: string,
  ): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO command_allowlist (
         scope, project_root, agent_id, sender_id, command, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      profile.scope,
      profile.projectRoot,
      AGENT_ID_SCHEMA.parse(profile.agentId),
      senderId,
      command,
      this.now(),
    );
  }

  public close(): void {
    this.db.close();
  }
}

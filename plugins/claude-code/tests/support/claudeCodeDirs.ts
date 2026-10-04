/**
 * The directories Claude Code gives the plugin, fresh for each test: its data
 * directory and the project a session runs in.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentsCommand } from "../../src/agentCommands";
import { AGENT_SELECT_ENV, CLAUDE_ENV, PROJECT_SETTINGS_FILE } from "../../src/config";
import { liveSessions, type SessionStatus } from "../../src/sessions";

export class ClaudeCodeDirs implements Disposable {
  public readonly dataDir = mkdtempSync(join(tmpdir(), "band-plugin-data-"));
  public readonly projectDir = mkdtempSync(join(tmpdir(), "band-project-"));

  /** The environment Claude Code gives the plugin's server in session `sessionId`, connecting as `agent` when named. */
  public env(sessionId: string, agent?: string): Record<string, string> {
    return {
      [CLAUDE_ENV.pluginData]: this.dataDir,
      [CLAUDE_ENV.projectDir]: this.projectDir,
      [CLAUDE_ENV.sessionId]: sessionId,
      ...(agent ? { [AGENT_SELECT_ENV]: agent } : {}),
    };
  }

  /** The arguments the skill passes before a command. */
  public get cliContext(): string[] {
    return ["--data-dir", this.dataDir, "--project-dir", this.projectDir];
  }

  /** Runs a `/band:agents` command as the skill does. */
  public agents(...args: string[]): Promise<string> {
    return runAgentsCommand([...this.cliContext, ...args]);
  }

  public session(sessionId: string): SessionStatus | undefined {
    return liveSessions(this.dataDir).get(sessionId);
  }

  public projectSettings(): unknown {
    return JSON.parse(readFileSync(join(this.projectDir, PROJECT_SETTINGS_FILE), "utf8"));
  }

  public [Symbol.dispose](): void {
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.projectDir, { recursive: true, force: true });
  }
}

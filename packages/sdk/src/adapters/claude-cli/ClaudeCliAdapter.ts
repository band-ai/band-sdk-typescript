import { ClaudeCliHistoryConverter, type ClaudeCliSessionState } from "../../converters/claude-cli";
import { ValidationError } from "../../core/errors";
import type { TurnTools } from "../../core/turn";
import { RoomScopedAdapter } from "../shared/roomScopedAdapter";
import {
  ClaudeCliRoomAgent,
  validateClaudeArgs,
  type ClaudeCliAdapterOptions,
  type ClaudeRoomAgentOptions,
  type ClaudeTurnUsage,
} from "./ClaudeRoomAgent";

/**
 * Runs the user's installed Claude Code CLI, one process per turn, resumed with
 * `--resume` so a room keeps one session across turns. Each room's process runs
 * in that room's own workspace and reaches Band only through that turn's MCP
 * generation, so rooms share no process, transcript, approval or tool access, and
 * a room's start, stop and failure are its own.
 *
 * The CLI is an external program: nothing here imports an Anthropic package, and
 * the protocol it speaks is the one recorded under `tests/fixtures/claude-cli/`.
 */
export class ClaudeCliAdapter extends RoomScopedAdapter<ClaudeCliSessionState, TurnTools, ClaudeCliRoomAgent> {
  protected readonly provider = "claude-cli";
  private readonly roomOptions: Omit<ClaudeRoomAgentOptions, "cwd" | "roomId">;

  public constructor(options: ClaudeCliAdapterOptions = {}) {
    const { cwd, workspaceForRoom, ...roomOptions } = options;
    super({ historyConverter: new ClaudeCliHistoryConverter(), cwd, workspaceForRoom, logger: options.logger });
    this.roomOptions = { ...roomOptions, command: validateClaudeCliOptions(options) };
  }

  /** Cancels the room's running turn; see {@link ClaudeCliRoomAgent.cancelTurn}. */
  public async cancelTurn(roomId: string): Promise<boolean> {
    return (await this.roomEngine(roomId)?.cancelTurn(roomId)) ?? false;
  }

  /**
   * What the room's last completed turn spent, from the CLI's latest-turn fields.
   * A room with no finished turn, or one the CLI gave no usage for, reports
   * `available: false` with the reason rather than a zero.
   */
  public turnUsage(roomId: string): ClaudeTurnUsage | null {
    return this.roomEngine(roomId)?.usage ?? null;
  }

  /** The session this room's engine is continuing, or null before the CLI names one. */
  public sessionId(roomId: string): string | null {
    return this.roomEngine(roomId)?.session ?? null;
  }

  protected createRoom(roomId: string, workspace: string): ClaudeCliRoomAgent {
    // Forwarded per call, so an engine sees whichever sink is attached when it reports.
    return new ClaudeCliRoomAgent({ ...this.roomOptions, roomId, cwd: workspace, observer: (event) => this.observer(event) });
  }
}

/**
 * Rejects a configuration no room could run with, so a bad option fails when the
 * adapter is built rather than on a room's first message. Returns the command as
 * an argv array, with any custom arguments kept clear of the reserved flags.
 */
export function validateClaudeCliOptions(options: ClaudeCliAdapterOptions): string[] {
  const command = options.command ?? ["claude"];
  const argv = Array.isArray(command) ? [...command] : [command];
  if (argv.length === 0 || !argv[0]) {
    throw new ValidationError("the Claude CLI command must name an executable");
  }
  const extra = validateClaudeArgs(argv.slice(1));
  return extra.length > 0 ? [argv[0], ...extra] : argv;
}

export {
  AUTHORIZED_SERVERS_TIMEOUT_MS,
  CLAUDE_PERMISSION_TOOL,
  DEFAULT_CLAUDE_CLI_COMMAND,
  DENIED_CLAUDE_CLI_TOOLS,
  RESERVED_CLAUDE_FLAGS,
  ClaudeCliRoomAgent,
  validateClaudeArgs,
} from "./ClaudeRoomAgent";
export type {
  ClaudeAuthorizedServersResolver,
  ClaudeCliAdapterOptions,
  ClaudePermissionEndReason,
  ClaudePermissionPrompt,
  ClaudeTurnUsage,
} from "./ClaudeRoomAgent";

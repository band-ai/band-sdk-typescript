import { ACPClientAdapter } from "../acp";
import { CursorRoomAgent, DEFAULT_CURSOR_ACP_COMMAND, type CursorACPAdapterOptions } from "./CursorRoomAgent";

/**
 * Runs Cursor's ACP agent, one process per room. Approvals, questions and
 * plans are answered in the room that asked, with `/cursor` commands.
 */
export class CursorACPAdapter extends ACPClientAdapter {
  protected readonly provider = "cursor-acp";
  private readonly settings: CursorACPAdapterOptions;

  public constructor(options: CursorACPAdapterOptions = {}) {
    validateOptions(options);
    super({
      ...options,
      env: cursorEnv(options),
      command: options.command ?? [...DEFAULT_CURSOR_ACP_COMMAND],
      authMethod: "cursor_login",
    });
    this.settings = options;
  }

  protected override createRoom(roomId: string, workspace: string): CursorRoomAgent {
    return new CursorRoomAgent({ ...this.roomOptions, roomId, cwd: workspace, provider: this.provider }, this.settings);
  }
}

function cursorEnv(options: CursorACPAdapterOptions): Record<string, string> | undefined {
  const env = { ...options.env };
  if (options.apiKey) env.CURSOR_API_KEY ??= options.apiKey;
  if (options.authToken) env.CURSOR_AUTH_TOKEN ??= options.authToken;
  return Object.keys(env).length > 0 ? env : undefined;
}

function validateOptions(options: CursorACPAdapterOptions): void {
  if (options.apiKey && options.authToken) throw new Error("set either apiKey or authToken, not both");
  if (Array.isArray(options.command) && options.command.length === 0) throw new Error("Cursor ACP command must not be empty");
  if (options.decisionTimeoutMs !== undefined && (!Number.isFinite(options.decisionTimeoutMs) || options.decisionTimeoutMs <= 0)) throw new Error("decisionTimeoutMs must be a positive finite number");
  if (options.maxPendingDecisions !== undefined && (!Number.isInteger(options.maxPendingDecisions) || options.maxPendingDecisions <= 0)) throw new Error("maxPendingDecisions must be a positive integer");
}

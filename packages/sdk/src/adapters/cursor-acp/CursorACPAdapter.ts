import { ACPClientAdapter } from "../acp";
import { assertPermissionTimeoutMs } from "../acp/ACPRoomAgent";
import { CursorRoomAgent, DEFAULT_CURSOR_ACP_COMMAND, type CursorACPAdapterOptions, type CursorDecisionSettings } from "./CursorRoomAgent";

/**
 * Runs Cursor's ACP agent, one process per room. Approvals, questions and
 * plans are answered in the room that asked, with `/cursor` commands.
 */
export class CursorACPAdapter extends ACPClientAdapter {
  protected readonly provider = "cursor-acp";
  private readonly settings: CursorDecisionSettings;

  public constructor(options: CursorACPAdapterOptions = {}) {
    validateOptions(options);
    const env = cursorEnv(options);
    super({
      ...options,
      env,
      command: options.command ?? [...DEFAULT_CURSOR_ACP_COMMAND],
      // A key or token already authenticates the CLI; ACP `cursor_login` is the interactive
      // login, which never answers on a headless runner (https://cursor.com/docs/cli/acp).
      authMethod: hasCredential(env) ? null : CURSOR_LOGIN,
    });
    this.settings = options;
  }

  protected override createRoom(roomId: string, workspace: string): CursorRoomAgent {
    return new CursorRoomAgent(this.roomAgentOptions(roomId, workspace), this.settings);
  }
}

const CURSOR_LOGIN = "cursor_login";
const CREDENTIAL_ENV = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const;

/** Whether the agent process, which inherits `process.env`, starts with a credential. */
function hasCredential(env: Record<string, string> | undefined): boolean {
  const effective = { ...process.env, ...env };
  return CREDENTIAL_ENV.some((name) => Boolean(effective[name]));
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
  // Every Cursor room resolves permissions, but per room, so the ACP check cannot see it.
  assertPermissionTimeoutMs(options.permissionTimeoutMs);
}

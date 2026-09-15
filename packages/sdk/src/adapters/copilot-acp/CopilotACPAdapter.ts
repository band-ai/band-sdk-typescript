import { resolveLogger } from "../../core/logger";
import {
  ACPClientAdapter,
  type ACPClientAdapterOptions,
} from "../acp";

export const DEFAULT_COPILOT_ACP_COMMAND = ["copilot", "--acp", "--stdio"] as const;

type CopilotACPBaseOptions = Omit<
  ACPClientAdapterOptions,
  "command" | "host" | "port"
>;

export interface CopilotACPStdioOptions extends CopilotACPBaseOptions {
  command?: string | string[];
  host?: never;
  port?: never;
}

export interface CopilotACPTcpOptions extends CopilotACPBaseOptions {
  command?: never;
  host: string;
  port: number;
}

export type CopilotACPAdapterOptions = CopilotACPStdioOptions | CopilotACPTcpOptions;

export class CopilotACPAdapter extends ACPClientAdapter {
  protected readonly provider = "copilot-acp";

  public constructor(options: CopilotACPAdapterOptions = {}) {
    const isTcp = "host" in options || "port" in options
    if (isTcp && options.env) {
      resolveLogger(options.logger).warn(
        "CopilotACPAdapter ignores env for a TCP connection because the remote server owns its environment",
      )
    }

    super(isTcp
      ? { ...options, env: undefined }
      : { ...options, command: options.command ?? [...DEFAULT_COPILOT_ACP_COMMAND] })
  }
}

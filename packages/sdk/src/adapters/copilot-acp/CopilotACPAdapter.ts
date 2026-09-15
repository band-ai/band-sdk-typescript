import { resolveLogger } from "../../core/logger";
import {
  ACPClientAdapter,
  type ACPClientStdioOptions,
  type ACPClientTcpOptions,
} from "../acp";

export const DEFAULT_COPILOT_ACP_COMMAND = ["copilot", "--acp", "--stdio"] as const;

export interface CopilotACPStdioOptions extends Omit<ACPClientStdioOptions, "command"> {
  command?: string | string[];
}

export interface CopilotACPTcpOptions extends ACPClientTcpOptions {}

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

    if (isTcp) {
      const tcpOptions = options as CopilotACPTcpOptions
      super({ ...tcpOptions, env: undefined })
      return
    }

    const stdioOptions = options as CopilotACPStdioOptions
    super({
      ...stdioOptions,
      command: stdioOptions.command ?? [...DEFAULT_COPILOT_ACP_COMMAND],
    })
  }
}

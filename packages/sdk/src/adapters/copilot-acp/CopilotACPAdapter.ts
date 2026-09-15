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

export type CopilotACPTcpOptions = ACPClientTcpOptions;

export type CopilotACPAdapterOptions = CopilotACPStdioOptions | CopilotACPTcpOptions;

function isTcpOptions(options: CopilotACPAdapterOptions): options is CopilotACPTcpOptions {
  return "host" in options || "port" in options
}

export class CopilotACPAdapter extends ACPClientAdapter {
  protected readonly provider = "copilot-acp";

  public constructor(options: CopilotACPAdapterOptions = {}) {
    if (isTcpOptions(options)) {
      if (options.env) {
        resolveLogger(options.logger).warn(
          "CopilotACPAdapter ignores env for a TCP connection because the remote server owns its environment",
        )
      }
      super({ ...options, env: undefined })
      return
    }

    super({
      ...options,
      command: options.command ?? [...DEFAULT_COPILOT_ACP_COMMAND],
    })
  }
}

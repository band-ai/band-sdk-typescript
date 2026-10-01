import { ACPClientAdapter, type ACPClientStdioOptions } from "../acp";

export const DEFAULT_COPILOT_ACP_COMMAND = ["copilot", "--acp", "--stdio"] as const;

export interface CopilotACPStdioOptions extends Omit<ACPClientStdioOptions, "command"> {
  command?: string | string[];
}

export type CopilotACPAdapterOptions = CopilotACPStdioOptions;

export class CopilotACPAdapter extends ACPClientAdapter {
  protected readonly provider = "copilot-acp";

  public constructor(options: CopilotACPAdapterOptions = {}) {
    super({
      ...options,
      command: options.command ?? [...DEFAULT_COPILOT_ACP_COMMAND],
    });
  }
}

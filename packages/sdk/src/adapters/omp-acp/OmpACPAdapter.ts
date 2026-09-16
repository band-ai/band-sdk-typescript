import { ACPClientAdapter, type ACPClientStdioOptions } from "../acp";

export const DEFAULT_OMP_ACP_COMMAND = ["omp", "acp"] as const;

export interface OmpACPAdapterOptions extends Omit<ACPClientStdioOptions, "command"> {
  command?: string | string[];
}

export class OmpACPAdapter extends ACPClientAdapter {
  protected readonly provider = "omp-acp";

  public constructor(options: OmpACPAdapterOptions = {}) {
    const { command, ...rest } = options;
    super({
      ...rest,
      command: command ?? [...DEFAULT_OMP_ACP_COMMAND],
    });
  }
}

export interface AgentRouterOptions {
  modeToPeer?: Record<string, string>;
  slashCommands?: Record<string, string>;
}

/**
 * Resolves which Band peer an ACP prompt is addressed to, from the editor's current mode
 * or a leading slash command, and strips the command from the text.
 */
export class AgentRouter {
  private readonly modeToPeer: Record<string, string>
  private readonly slashCommands: Record<string, string>

  public constructor(options?: AgentRouterOptions) {
    this.modeToPeer = { ...(options?.modeToPeer ?? {}) }
    this.slashCommands = Object.fromEntries(
      Object.entries(options?.slashCommands ?? {}).map(([command, peer]) => [command.toLowerCase(), peer]),
    )
  }

  public resolve(
    text: string,
    currentMode?: string | null,
  ): { text: string; targetPeer: string | null } {
    if (text.startsWith("/")) {
      const [command, ...rest] = text.slice(1).split(/\s+/)
      const peer = this.slashCommands[command?.toLowerCase() ?? ""]
      if (peer) {
        return {
          text: rest.join(" ").trim(),
          targetPeer: peer,
        }
      }
    }

    if (currentMode && this.modeToPeer[currentMode]) {
      return {
        text,
        targetPeer: this.modeToPeer[currentMode],
      }
    }

    return {
      text,
      targetPeer: null,
    }
  }
}

import { resolveLogger, type Logger } from "../../core/logger";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { PlatformMessage } from "../../runtime/types";
import {
  ACPClientAdapter,
  type ACPClientExtensionContext,
  type ACPClientExtensionHandler,
  type ACPClientStdioOptions,
} from "../acp";
import type { CollectedChunk } from "../acp/types";

export const DEFAULT_KIRO_ACP_COMMAND = ["kiro-cli", "acp"] as const;

// Kiro's experimental extension methods (kiro.dev/docs/cli/acp), namespaced
// like every ACP vendor extension. One source of truth for the two this
// adapter currently handles — never re-typed at a second call site.
const KIRO_EXTENSION_PREFIX = "_kiro.dev/";
export const KIRO_MCP_OAUTH_REQUEST_METHOD = `${KIRO_EXTENSION_PREFIX}mcp/oauth_request`;
export const KIRO_METADATA_METHOD = `${KIRO_EXTENSION_PREFIX}metadata`;

export interface KiroACPAdapterOptions extends Omit<ACPClientStdioOptions, "command"> {
  command?: string | string[];
}

// No OAuth UI is wired up yet, and `_kiro.dev/metadata`'s real payload shape
// is unconfirmed against a live `kiro-cli acp` session — both are declared
// in the parent ticket's own source links, not observed firsthand. Declines
// rather than hangs the agent on an unanswerable request; the metadata
// parser is a no-op for any shape it doesn't recognize. Revisit both once
// this ticket's own gap-analysis phase runs against a real Kiro CLI.
class KiroExtensions implements ACPClientExtensionHandler {
  private readonly logger: Logger;
  private sessionId: string | null = null;

  public constructor(logger: Logger) {
    this.logger = logger;
  }

  public extensionSessionId(): string | null {
    return this.sessionId;
  }

  // Kiro's real payloads for these two methods are unconfirmed, so this
  // also tracks the session the adapter itself just made ready
  // (`KiroACPAdapter.onAcpSessionReady`) — the reliable fallback for a
  // vendor payload that turns out to carry no session id of its own.
  public setActiveSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  public async extMethod(
    method: string,
    _params: Record<string, unknown>,
    context: ACPClientExtensionContext,
  ): Promise<Record<string, unknown> | null> {
    this.sessionId = context.sessionId ?? this.sessionId;
    if (method !== KIRO_MCP_OAUTH_REQUEST_METHOD) {
      return null;
    }
    this.logger.warn("kiro_acp.oauth_request_declined", { method });
    return { outcome: "declined" };
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
    context: ACPClientExtensionContext,
  ): Promise<readonly CollectedChunk[] | void> {
    this.sessionId = context.sessionId ?? this.sessionId;
    if (method !== KIRO_METADATA_METHOD) {
      return;
    }
    const summary = describeKiroMetadata(params);
    if (!summary) {
      return;
    }
    return [{ chunkType: "plan", content: summary, metadata: { kiro_metadata: true }, streamed: false }];
  }
}

export class KiroACPAdapter extends ACPClientAdapter {
  protected readonly provider = "kiro-acp";
  private readonly extensions: KiroExtensions;

  public constructor(options: KiroACPAdapterOptions = {}) {
    const extensions = new KiroExtensions(resolveLogger(options.logger));
    const { command, ...rest } = options;
    super({
      ...rest,
      command: command ?? [...DEFAULT_KIRO_ACP_COMMAND],
      extensionHandler: extensions,
    });
    this.extensions = extensions;
  }

  protected override async onAcpSessionReady(
    _message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    _context: { isSessionBootstrap: boolean; roomId: string },
    sessionId: string,
  ): Promise<void> {
    this.extensions.setActiveSessionId(sessionId);
  }
}

function describeKiroMetadata(params: Record<string, unknown>): string | undefined {
  const used = numberValue(params.contextWindowUsed) ?? numberValue(params.tokensUsed);
  const total = numberValue(params.contextWindowSize) ?? numberValue(params.contextWindowTotal);
  if (used === undefined || total === undefined || total <= 0) {
    return undefined;
  }
  const percent = Math.round((used / total) * 100);
  return `[Kiro context window] ${used}/${total} tokens (${percent}%)`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

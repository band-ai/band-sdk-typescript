import { resolveLogger, type Logger } from "../../core/logger";
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

export interface KiroACPAdapterOptions extends Omit<ACPClientStdioOptions, "command" | "extensionHandler"> {
  command?: string | string[];
}

// No OAuth UI is wired up, and the metadata payload shape is unconfirmed
// against a live `kiro-cli acp` session. Decline the OAuth request on this
// turn so the agent is not left waiting. A metadata payload with no session,
// or without two finite integer usage numbers forming a sane (non-negative,
// used <= total) and positive total, is ignored.
class KiroExtensions implements ACPClientExtensionHandler {
  private readonly logger: Logger;

  public constructor(logger: Logger) {
    this.logger = logger;
  }

  public async extMethod(
    method: string,
    _params: Record<string, unknown>,
    _context: ACPClientExtensionContext,
  ): Promise<Record<string, unknown> | null> {
    if (method !== KIRO_MCP_OAUTH_REQUEST_METHOD) {
      this.logger.warn("kiro_acp.ext_method_unhandled", { method });
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
    if (method !== KIRO_METADATA_METHOD) {
      this.logger.warn("kiro_acp.ext_notification_unhandled", { method });
      return;
    }
    if (!context.sessionId) {
      this.logger.warn("kiro_acp.metadata_unattributed", { method, keys: Object.keys(params) });
      return;
    }
    const summary = describeKiroMetadata(params);
    if (!summary) {
      this.logger.warn("kiro_acp.metadata_unrecognized", { method, keys: Object.keys(params) });
      return;
    }
    return [{ chunkType: "plan", content: summary, metadata: { kiro_metadata: true }, streamed: false }];
  }
}

export class KiroACPAdapter extends ACPClientAdapter {
  protected readonly provider = "kiro-acp";

  public constructor(options: KiroACPAdapterOptions = {}) {
    const { command, ...rest } = options;
    super({
      ...rest,
      command: command ?? [...DEFAULT_KIRO_ACP_COMMAND],
      extensionHandler: new KiroExtensions(resolveLogger(options.logger)),
    });
  }
}

function describeKiroMetadata(params: Record<string, unknown>): string | undefined {
  const used = numberValue(params.contextWindowUsed) ?? numberValue(params.tokensUsed);
  const total = numberValue(params.contextWindowSize) ?? numberValue(params.contextWindowTotal);
  if (
    used === undefined || total === undefined || total <= 0 || used < 0 || used > total
    || !Number.isInteger(used) || !Number.isInteger(total)
  ) {
    return undefined;
  }
  const percent = Math.round((used / total) * 100);
  return `[Kiro context window] ${used}/${total} tokens (${percent}%)`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

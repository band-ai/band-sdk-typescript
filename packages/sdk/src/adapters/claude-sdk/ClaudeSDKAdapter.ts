import { SimpleAdapter } from "../../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { UnsupportedFeatureError } from "../../core/errors";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { renderSystemPrompt } from "../../runtime/prompts";
import { mcpToolNames, MCP_SERVER_NAME } from "../../runtime/tools/schemas";
import { agentFailure, reportProviderTurnFailure, reportTurnFailure, safeSendFailure } from "../../core/providerFailure";
import { deliverReply } from "../../core/deliveryFailedError";
import { buildConversationPrompt } from "../shared/conversationPrompt";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { extractClaudeSessionId } from "../../converters/claude-sdk";
import {
  buildRoomScopedRegistrations,
  type McpToolRegistration,
} from "../../mcp/registrations";
import { buildZodShape } from "../../mcp/zod";
import { z } from "zod";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

interface ClaudeAssistantTextBlock {
  type?: string;
  text?: string;
}

interface ClaudeAssistantMessage {
  content: ClaudeAssistantTextBlock[];
}

interface ClaudeSDKMessageLike {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  summary?: string;
  message?: ClaudeAssistantMessage;
  [key: string]: unknown;
}

interface ClaudeQueryOptions {
  model?: string;
  permissionMode?: ClaudePermissionMode;
  systemPrompt?: string;
  allowDangerouslySkipPermissions?: boolean;
  maxThinkingTokens?: number;
  cwd?: string;
  resume?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
}

export interface ClaudeSDKQueryParams {
  prompt: string;
  options?: ClaudeQueryOptions;
}

export type ClaudeSDKQuery = (params: ClaudeSDKQueryParams) => AsyncIterable<ClaudeSDKMessageLike>;

export interface ClaudeSDKAdapterOptions {
  model?: string;
  customSection?: string;
  includeBaseInstructions?: boolean;
  maxThinkingTokens?: number;
  permissionMode?: ClaudePermissionMode;
  enableExecutionReporting?: boolean;
  enableMemoryTools?: boolean;
  enableMcpTools?: boolean;
  additionalMcpTools?: McpToolRegistration[];
  cwd?: string;
  queryFn?: ClaudeSDKQuery;
  logger?: Logger;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

interface BandMcpBridge {
  serverConfig: Record<string, unknown>;
  allowedTools: string[];
}

type ClaudeSdkToolFactory = (
  name: string,
  description: string,
  shape: Record<string, z.ZodType>,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
) => unknown;

type BandMcpBridgeFactory = (input: {
  enableMemoryTools: boolean;
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
}) => BandMcpBridge;

const bandMcpBridgeFactory = new LazyAsyncValue<BandMcpBridgeFactory>({
  load: async () => {
    const module = await import("@anthropic-ai/claude-agent-sdk").catch((error: unknown) => {
      throw new UnsupportedFeatureError(
        `ClaudeSDKAdapter requires optional dependency "@anthropic-ai/claude-agent-sdk" when MCP tools are enabled. Install it with "pnpm add @anthropic-ai/claude-agent-sdk". (${error instanceof Error ? error.message : String(error)})`,
      )
    })

    if (
      typeof module.createSdkMcpServer !== "function"
      || typeof module.tool !== "function"
    ) {
      throw new UnsupportedFeatureError(
        'ClaudeSDKAdapter requires optional dependency "@anthropic-ai/claude-agent-sdk" when MCP tools are enabled. Install it with "pnpm add @anthropic-ai/claude-agent-sdk".',
      )
    }

    const createSdkMcpServer = module.createSdkMcpServer as (input: {
      name: string;
      tools: unknown[];
    }) => Record<string, unknown>
    const defineTool = module.tool as ClaudeSdkToolFactory

    return (input) => {
      const registrations = buildRoomScopedRegistrations(
        input.getToolsForRoom,
        {
          enableMemoryTools: input.enableMemoryTools,
          enableContactTools: true,
          additionalTools: input.additionalTools,
        },
      )

      const toolDefinitions = registrations.map((registration) => {
        const shape = buildZodShape(
          z,
          registration.inputSchema.properties,
          new Set(registration.inputSchema.required),
        )

        return defineTool(
          registration.name,
          registration.description,
          shape,
          async (args: Record<string, unknown>) => registration.execute(args),
        )
      })

      return {
        serverConfig: createSdkMcpServer({
          name: MCP_SERVER_NAME,
          tools: toolDefinitions,
        }),
        allowedTools: mcpToolNames(new Set(registrations.map((registration) => registration.name))),
      }
    }
  },
})

export class ClaudeSDKAdapter extends SimpleAdapter<HistoryProvider, AdapterToolsProtocol> {
  protected readonly provider = "claude-sdk";

  private readonly model: string;
  private readonly customSection?: string;
  private readonly includeBaseInstructions: boolean;
  private readonly maxThinkingTokens?: number;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly enableExecutionReporting: boolean;
  private readonly enableMemoryTools: boolean;
  private readonly enableMcpTools: boolean;
  private readonly additionalMcpTools: McpToolRegistration[];
  private readonly cwd?: string;
  private readonly queryFnOverride?: ClaudeSDKQuery;
  private readonly logger: Logger;
  private readonly sessionIds = new Map<string, string>();
  private readonly sessionInitLocks = new Map<string, Promise<void>>();
  private readonly roomTools = new Map<string, AdapterToolsProtocol>();
  private mcpBridge: BandMcpBridge | null = null;
  private systemPrompt = "";

  public constructor(options?: ClaudeSDKAdapterOptions) {
    super();
    this.model = options?.model ?? DEFAULT_MODEL;
    this.customSection = options?.customSection;
    this.includeBaseInstructions = options?.includeBaseInstructions ?? true;
    this.maxThinkingTokens = options?.maxThinkingTokens;
    this.permissionMode = options?.permissionMode ?? "acceptEdits";
    this.enableExecutionReporting = options?.enableExecutionReporting ?? false;
    this.enableMemoryTools = options?.enableMemoryTools ?? false;
    this.enableMcpTools = options?.enableMcpTools ?? true;
    this.additionalMcpTools = options?.additionalMcpTools ?? [];
    this.cwd = options?.cwd;
    this.queryFnOverride = options?.queryFn;
    this.logger = resolveLogger(options?.logger);
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.systemPrompt = renderSystemPrompt({
      agentName,
      agentDescription,
      customSection: this.customSection,
      includeBaseInstructions: this.includeBaseInstructions,
      capabilities: { memory: this.enableMemoryTools },
    });

    if (this.enableMcpTools) {
      const createBandMcpBridge = await bandMcpBridgeFactory.get()
      this.mcpBridge = createBandMcpBridge({
        enableMemoryTools: this.enableMemoryTools,
        getToolsForRoom: (roomId) => this.roomTools.get(roomId),
        additionalTools: this.additionalMcpTools.length > 0 ? this.additionalMcpTools : undefined,
      });
    }
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    // Serialize per-room to prevent concurrent bootstrap from creating duplicate sessions.
    const existing = this.sessionInitLocks.get(context.roomId);
    if (existing) {
      await existing;
    }

    let unlock!: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.sessionInitLocks.set(context.roomId, lock);

    try {
      await this.doMessage(message, tools, history, participantsMessage, contactsMessage, context);
    } finally {
      unlock();
      if (this.sessionInitLocks.get(context.roomId) === lock) {
        this.sessionInitLocks.delete(context.roomId);
      }
    }
  }

  private async doMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    let finalText = "";
    let resultFailure: ClaudeResultFailure | null = null;
    try {
      const query = await this.startQuery(message, history, participantsMessage, contactsMessage, context, tools);
      const consumed = await this.consumeQueryEvents(query, tools, context.roomId);
      finalText = consumed.finalText;
      resultFailure = consumed.resultFailure;
    } catch (error) {
      await reportProviderTurnFailure(tools, this.logger, this.provider, "Claude SDK adapter request failed", error, { roomId: context.roomId });
    }

    const mention = [{ id: message.senderId, handle: message.senderName ?? message.senderType }];
    const replyText = finalText.trim();
    if (resultFailure) {
      const failure = agentFailure(this.provider, resultFailure.message, resultFailure.code, resultFailure.detail);
      // Preceding assistant text is already decided output; posting it must
      // not flip a non-success result into a successful turn.
      if (replyText) {
        try {
          await deliverReply(tools, replyText, mention);
        } catch (error) {
          await safeSendFailure(tools, failure, this.logger, { roomId: context.roomId });
          throw error;
        }
      }
      await reportTurnFailure(tools, failure, this.logger, { roomId: context.roomId });
    }

    if (replyText) {
      await deliverReply(tools, replyText, mention);
    }
  }

  private async startQuery(
    message: PlatformMessage,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
    tools: AdapterToolsProtocol,
  ): Promise<AsyncIterable<ClaudeSDKMessageLike>> {
    const queryFn = this.queryFnOverride ?? (await loadClaudeQuery());

    const options: ClaudeQueryOptions = {
      model: this.model,
      permissionMode: this.permissionMode,
      systemPrompt: this.systemPrompt,
    };
    if (this.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }
    if (this.maxThinkingTokens !== undefined) {
      options.maxThinkingTokens = this.maxThinkingTokens;
    }
    if (this.cwd) {
      options.cwd = this.cwd;
    }
    const existingSession = this.sessionIds.get(context.roomId)
      ?? (context.isSessionBootstrap ? extractClaudeSessionId(history.raw) : null);
    if (existingSession) {
      options.resume = existingSession;
    }

    if (this.mcpBridge && this.enableMcpTools) {
      options.mcpServers = {
        [MCP_SERVER_NAME]: this.mcpBridge.serverConfig,
      };
      options.allowedTools = this.mcpBridge.allowedTools;
      this.roomTools.set(context.roomId, tools);
    }

    const roomToolHint = this.enableMcpTools
      ? `\n\n[Tooling note]: For any mcp__band__* tool call, pass room_id="${context.roomId}".`
      : "";

    return queryFn({
      prompt: buildConversationPrompt({
        history,
        isSessionBootstrap: context.isSessionBootstrap,
        participantsMessage,
        contactsMessage,
        historyHeader: "[Previous conversation context]",
        currentMessage: message.content,
        maxHistoryMessages: 50,
      }) + roomToolHint,
      options,
    });
  }

  private async consumeQueryEvents(
    query: AsyncIterable<ClaudeSDKMessageLike>,
    tools: AdapterToolsProtocol,
    roomId: string,
  ): Promise<{ finalText: string; resultFailure: ClaudeResultFailure | null }> {
    let finalText = "";
    let resultFailure: ClaudeResultFailure | null = null;
    for await (const event of query) {
      const type = event.type;
      const sessionId = event.session_id;
      if (typeof sessionId === "string" && sessionId) {
        const previousSessionId = this.sessionIds.get(roomId) ?? null;
        this.sessionIds.set(roomId, sessionId);
        if (sessionId !== previousSessionId) {
          await this.reportSessionId(tools, roomId, sessionId);
        }
      }

      if (type === "assistant") {
        const text = extractAssistantText(event);
        if (text) {
          finalText = text;
        }
      }

      if (type === "result") {
        resultFailure = claudeNonSuccessResult(event);
        if (!resultFailure && typeof event.result === "string") {
          finalText = event.result;
        }
      }

      if (this.enableExecutionReporting && type === "tool_use_summary") {
        try {
          await tools.sendEvent(JSON.stringify(event), "tool_call");
        } catch (error) {
          this.logger.warn("Claude SDK execution reporting failed", {
            roomId,
            sessionId: this.sessionIds.get(roomId) ?? null,
            error,
          });
        }
      }
    }
    return { finalText, resultFailure };
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.sessionIds.delete(roomId);
    this.sessionInitLocks.delete(roomId);
    this.roomTools.delete(roomId);
  }

  private async reportSessionId(
    tools: AdapterToolsProtocol,
    roomId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await tools.sendEvent("Claude SDK session", "task", {
        claude_sdk_session_id: sessionId,
      });
    } catch (error) {
      this.logger.warn("Claude SDK session marker event failed", {
        roomId,
        sessionId,
        error,
      });
    }
  }
}

async function loadClaudeQuery(): Promise<ClaudeSDKQuery> {
  const module = await import("@anthropic-ai/claude-agent-sdk").catch((error: unknown) => {
    throw new UnsupportedFeatureError(
      `ClaudeSDKAdapter requires optional dependency "@anthropic-ai/claude-agent-sdk". Install it with "pnpm add @anthropic-ai/claude-agent-sdk". (${error instanceof Error ? error.message : String(error)})`,
    );
  }) as {
    query?: ClaudeSDKQuery;
  };

  if (!module.query) {
    throw new UnsupportedFeatureError("@anthropic-ai/claude-agent-sdk did not export query()");
  }

  return module.query;
}


interface ClaudeResultFailure {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

function claudeNonSuccessResult(event: ClaudeSDKMessageLike): ClaudeResultFailure | null {
  const flaggedError = event.is_error === true;
  if (!flaggedError && event.subtype === "success") {
    return null;
  }
  const subtype = typeof event.subtype === "string" ? event.subtype.trim() : "";
  // `subtype: "success"` with `is_error: true` is still terminal; never use code "success".
  const code = subtype.length === 0 || subtype === "success" ? "error" : subtype;
  const resultText = typeof event.result === "string" ? event.result.trim() : "";
  const summaryText = typeof event.summary === "string" ? event.summary.trim() : "";
  const message = resultText || summaryText || `Claude Agent SDK result: ${code}`;
  return {
    code,
    message,
    detail: {
      subtype: event.subtype ?? null,
      is_error: event.is_error ?? null,
      result: event.result ?? null,
      session_id: event.session_id ?? null,
    },
  };
}
function extractAssistantText(event: ClaudeSDKMessageLike): string {
  if (event.type !== "assistant") {
    return "";
  }

  const blocks = event.message?.content ?? [];
  return blocks
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
    .filter((text: string) => text.length > 0)
    .join("\n");
}

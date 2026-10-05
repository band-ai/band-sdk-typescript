import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SettingSource,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";

import { SimpleAdapter } from "../../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { renderSystemPrompt } from "../../runtime/prompts";
import { MCP_SERVER_NAME } from "../../contracts/toolSchemas";
import { agentFailure, reportProviderTurnFailure, reportTurnFailure, safeSendFailure } from "../../core/providerFailure";
import { relayReply, type TurnTools } from "../../core/turn";
import { createRoomTurnLock } from "../shared/roomTurnLock";
import { buildConversationPrompt } from "../shared/conversationPrompt";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { extractClaudeSessionId } from "../../converters/claude-sdk";
import {
  buildRoomScopedRegistrations,
  type McpToolRegistration,
} from "../../mcp/registrations";
import { buildCustomMcpRegistrations } from "../../mcp/customTools";
import { assertCustomToolNamesAvailable, buildCustomToolIndex, type CustomToolDef } from "../../runtime/tools/customTools";

export type ClaudePermissionMode = NonNullable<Options["permissionMode"]>;

/** The SDK options the adapter sets; picked from the SDK so a renamed or retyped option fails to compile. */
type ClaudeQueryOptions = Pick<
  Options,
  | "model"
  | "permissionMode"
  | "systemPrompt"
  | "allowDangerouslySkipPermissions"
  | "maxThinkingTokens"
  | "cwd"
  | "resume"
  | "mcpServers"
  | "allowedTools"
  | "disallowedTools"
  | "settingSources"
  | "settings"
>;

export interface ClaudeSDKQueryParams {
  prompt: string;
  options?: ClaudeQueryOptions;
}

/** The SDK's `query`, narrowed to what the adapter calls it with; the real `query` satisfies it as-is. */
export type ClaudeSDKQuery = (params: ClaudeSDKQueryParams) => AsyncIterable<SDKMessage>;

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
  customTools?: CustomToolDef[];
  cwd?: string;
  /** Host Claude Code settings to load; `[]` (the default) loads none, e.g. `["user", "project"]` opts back in. */
  settingSources?: SettingSource[];
  queryFn?: ClaudeSDKQuery;
  logger?: Logger;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** They list, prompt, or send files to the OS user's other Claude Code sessions; a Band agent talks only through Band tools. */
export const DENIED_CLAUDE_CODE_TOOLS = ["ListAgents", "SendMessage", "SendFile"] as const;

/** Excluding it runs the session without tool search, so the first turn waits for the Band server and nothing is deferred. */
export const TOOL_SEARCH = "ToolSearch";

/** Every tool a Band agent's Claude Code session is started without. */
export const DISALLOWED_CLAUDE_CODE_TOOLS = [...DENIED_CLAUDE_CODE_TOOLS, TOOL_SEARCH] as const;

/** Flag settings that keep the host's other sessions from prompting the agent and its claude.ai connectors (auth-based, not settings-file-based) from loading. */
export const ISOLATION_SETTINGS = {
  crossSessionInbound: "refuse",
  disableClaudeAiConnectors: true,
} as const satisfies Settings;

interface BandMcpBridge {
  serverConfig: McpSdkServerConfigWithInstance;
  allowedTools: string[];
}

const sdkMcpBridgeLoader = new LazyAsyncValue({
  load: async () => {
    const module = await import("../../mcp/sdkTools").catch((error: unknown) => {
      throw new UnsupportedFeatureError(
        `ClaudeSDKAdapter requires optional dependency "@anthropic-ai/claude-agent-sdk" when MCP tools are enabled. Install it with "pnpm add @anthropic-ai/claude-agent-sdk". (${error instanceof Error ? error.message : String(error)})`,
      );
    });

    return module.createSdkMcpBridge;
  },
});

export class ClaudeSDKAdapter extends SimpleAdapter<HistoryProvider, TurnTools> {
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
  private readonly customToolRegistrations: McpToolRegistration[];
  private readonly cwd?: string;
  private readonly settingSources: SettingSource[];
  private readonly queryFnOverride?: ClaudeSDKQuery;
  private readonly logger: Logger;
  private readonly sessionIds = new Map<string, string>();
  // One turn per room: its MCP calls resolve the room's tools, so a second turn would take over the first's.
  private readonly roomTurns = createRoomTurnLock();
  private readonly roomTools = new Map<string, TurnTools>();
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
    const customTools = [...buildCustomToolIndex(options?.customTools ?? []).values()];
    if (customTools.length > 0 && !this.enableMcpTools) {
      throw new ValidationError("ClaudeSDK customTools require `enableMcpTools: true`.");
    }
    this.customToolRegistrations = buildCustomMcpRegistrations(customTools, (roomId) => this.roomTools.get(roomId));
    this.cwd = options?.cwd;
    this.settingSources = options?.settingSources ?? [];
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
      const createSdkMcpBridge = await sdkMcpBridgeLoader.get();
      const registrations = buildRoomScopedRegistrations((roomId) => this.roomTools.get(roomId), {
        enableMemoryTools: this.enableMemoryTools,
        enableContactTools: true,
        additionalTools: this.additionalMcpTools,
      });
      assertCustomToolNamesAvailable(
        this.customToolRegistrations.map((registration) => registration.name),
        registrations.map((registration) => registration.name),
      );
      this.mcpBridge = createSdkMcpBridge(registrations, this.customToolRegistrations);
    }
  }

  public async onMessage(
    message: PlatformMessage,
    tools: TurnTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    await this.roomTurns.run(context.roomId, () =>
      this.doMessage(message, tools, history, participantsMessage, contactsMessage, context));
  }

  private async doMessage(
    message: PlatformMessage,
    tools: TurnTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    this.roomTools.set(context.roomId, tools);
    try {
      let finalText = "";
      let resultFailure: ClaudeResultFailure | null = null;
      try {
        const query = await this.startQuery(message, history, participantsMessage, contactsMessage, context);
        const consumed = await this.consumeQueryEvents(query, tools, context.roomId);
        finalText = consumed.finalText;
        resultFailure = consumed.resultFailure;
      } catch (error) {
        await reportProviderTurnFailure(tools, this.logger, this.provider, "Claude SDK adapter request failed", error, { roomId: context.roomId });
      }

      const mention = [{ id: message.senderId, handle: message.senderName ?? message.senderType }];
      const replyText = finalText.trim();
      const failure = resultFailure
        ? agentFailure(this.provider, resultFailure.message, resultFailure.code, resultFailure.detail)
        : null;
      try {
        await relayReply(tools, replyText, mention);
      } catch (error) {
        if (failure) await safeSendFailure(tools, failure, this.logger, { roomId: context.roomId });
        throw error;
      }
      // Posting preceding text must not turn a failed provider result into success.
      if (failure) await reportTurnFailure(tools, failure, this.logger, { roomId: context.roomId });
    } finally {
      if (this.roomTools.get(context.roomId) === tools) {
        this.roomTools.delete(context.roomId);
      }
    }
  }

  private async startQuery(
    message: PlatformMessage,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<AsyncIterable<SDKMessage>> {
    const queryFn = this.queryFnOverride ?? (await loadClaudeQuery());

    const options: ClaudeQueryOptions = {
      model: this.model,
      permissionMode: this.permissionMode,
      systemPrompt: this.systemPrompt,
      settingSources: this.settingSources,
      disallowedTools: [...DISALLOWED_CLAUDE_CODE_TOOLS],
      settings: { ...ISOLATION_SETTINGS },
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
    query: AsyncIterable<SDKMessage>,
    tools: AdapterToolsProtocol,
    roomId: string,
  ): Promise<{ finalText: string; resultFailure: ClaudeResultFailure | null }> {
    let finalText = "";
    let resultFailure: ClaudeResultFailure | null = null;
    for await (const event of query) {
      const sessionId = event.session_id;
      if (sessionId) {
        const previousSessionId = this.sessionIds.get(roomId) ?? null;
        this.sessionIds.set(roomId, sessionId);
        if (sessionId !== previousSessionId) {
          await this.reportSessionId(tools, roomId, sessionId);
        }
      }

      if (event.type === "assistant") {
        const text = extractAssistantText(event);
        if (text) {
          finalText = text;
        }
      }

      if (event.type === "result") {
        resultFailure = claudeNonSuccessResult(event);
        if (!resultFailure && event.subtype === "success") {
          finalText = event.result;
        }
      }

      if (this.enableExecutionReporting && event.type === "tool_use_summary") {
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
    this.roomTurns.release(roomId);
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
  });

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

function claudeNonSuccessResult(event: SDKResultMessage): ClaudeResultFailure | null {
  if (event.subtype === "success") {
    // `is_error` on a success result is still terminal, under code "error" rather than "success".
    return event.is_error ? claudeResultFailure(event, "error", event.result) : null;
  }
  return claudeResultFailure(event, event.subtype, event.errors.join("\n"));
}

function claudeResultFailure(event: SDKResultMessage, code: string, text: string): ClaudeResultFailure {
  return {
    code,
    message: text.trim() || `Claude Agent SDK result: ${code}`,
    detail: {
      subtype: event.subtype,
      is_error: event.is_error,
      session_id: event.session_id,
      ...(event.subtype === "success" ? { result: event.result } : { errors: event.errors }),
    },
  };
}

function extractAssistantText(event: SDKAssistantMessage): string {
  return event.message.content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n");
}

import type { ModelReasoningEffort, WebSearchMode } from "@openai/codex-sdk";

import { SimpleAdapter } from "../../core/simpleAdapter";
import {
  type AgentToolsProtocol,
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../../contracts/protocols";
import type { MentionInput } from "../../contracts/dtos";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { renderSystemPrompt } from "../../runtime/prompts";
import {
  CustomToolExecutionError,
  CustomToolValidationError,
  type CustomToolDef,
  buildCustomToolIndex,
  customToolToOpenAISchema,
  executeCustomTool,
  findCustomToolInIndex,
} from "../../runtime/tools/customTools";
import { asErrorMessage, asNonEmptyString, asOptionalRecord, asRecord, toWireString } from "../shared/coercion";
import { findLatestTaskMetadata } from "../shared/history";
import {
  CodexAppServerStdioClient,
  type CodexClientLike,
  type CodexRpcEvent,
} from "./appServerClient";
import type {
  CodexApprovalPolicy,
  CodexReasoningSummary,
  CodexSandboxMode,
  CommandExecutionItem,
  ContextCompactionItem,
  FileChangeItem,
  ImageViewItem,
  McpToolCallItem,
  ModelListResponse,
  PlanItem,
  ReasoningItem,
  ReviewModeItem,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnErrorInfo,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnStatus,
  WebSearchItem,
} from "./appServerProtocol";

export type {
  CodexApprovalPolicy,
  CodexReasoningSummary,
  CodexSandboxMode,
} from "./appServerProtocol";

export const CODEX_WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const satisfies readonly WebSearchMode[];
export type CodexWebSearchMode = (typeof CODEX_WEB_SEARCH_MODES)[number];
export const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"] as const satisfies readonly CodexReasoningSummary[];
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const satisfies readonly Exclude<ModelReasoningEffort, "minimal">[];
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export interface CodexAdapterConfig {
  model?: string;
  cwd?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  skipGitRepoCheck?: boolean;
  enableExecutionReporting?: boolean;
  emitThoughtEvents?: boolean;
  maxHistoryMessages?: number;
  enableLocalCommands?: boolean;
  includeBaseInstructions?: boolean;
  debug?: boolean;
  customSection?: string;
  /**
   * Full system prompt override.
   * When set, this bypasses the default Band prompt template + customSection.
   */
  systemPrompt?: string;
  experimentalApi?: boolean;
  fallbackSendAgentText?: boolean;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  turnTimeoutMs?: number;
  codexCommand?: readonly string[];
  codexEnv?: Record<string, string>;
}

interface CodexFactory {
  (): Promise<CodexClientLike>;
}

interface CodexAdapterOptions {
  config?: CodexAdapterConfig;
  customTools?: CustomToolDef[];
  includeMemoryTools?: boolean;
  factory?: CodexFactory;
  logger?: Logger;
}

type ToolLikeItem =
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | ImageViewItem
  | { type: "collabAgentToolCall"; tool: string; prompt: string | null; agents?: unknown; result?: unknown };

type ThoughtLikeItem =
  | ReasoningItem
  | PlanItem
  | ContextCompactionItem
  | ReviewModeItem;

const SILENT_REPORTING_TOOLS = new Set([
  "thenvoi_send_message",
  "thenvoi_send_event",
]);

export class CodexAdapter extends SimpleAdapter<HistoryProvider, AgentToolsProtocol> {
  private readonly baseConfig: CodexAdapterConfig;
  private readonly roomConfigOverrides = new Map<string, Partial<CodexAdapterConfig>>();
  private readonly customTools: CustomToolDef[];
  private readonly customToolIndex: Map<string, CustomToolDef>;
  private readonly includeMemoryTools: boolean;
  private readonly factoryOverride?: CodexFactory;
  private readonly logger: Logger;
  private readonly debugEnabled: boolean;
  private client: CodexClientLike | null = null;
  private clientPromise: Promise<CodexClientLike> | null = null;
  private lastInitFailure = 0;
  private readonly roomThreadIds = new Map<string, string>();
  private readonly roomThreadInitPromises = new Map<string, Promise<string>>();
  private readonly needsHistoryInjection = new Set<string>();
  private systemPrompt: string | null = null;

  public constructor(options?: CodexAdapterOptions) {
    super();
    this.baseConfig = {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      maxHistoryMessages: 50,
      enableLocalCommands: true,
      includeBaseInstructions: true,
      experimentalApi: true,
      fallbackSendAgentText: true,
      clientName: "thenvoi_codex_adapter",
      clientTitle: "Band Codex Adapter",
      clientVersion: "0.1.0",
      turnTimeoutMs: 180_000,
      ...options?.config,
    };
    this.customTools = options?.customTools ?? [];
    this.customToolIndex = buildCustomToolIndex(this.customTools);
    this.includeMemoryTools = options?.includeMemoryTools ?? false;
    this.factoryOverride = options?.factory;
    this.logger = options?.logger ?? new NoopLogger();
    this.debugEnabled = options?.config?.debug ?? false;
  }

  public override async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.ensureSystemPrompt();
    await this.ensureClient();
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AgentToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    this.debug("codex_adapter.on_message.start", {
      roomId: context.roomId,
      isSessionBootstrap: context.isSessionBootstrap,
      metadataSessionId: message.metadata?.linear_session_id ?? null,
      metadataIssueId: message.metadata?.linear_issue_id ?? null,
    });
    this.ensureSystemPrompt();

    const config = this.getConfig(context.roomId);
    if (config.enableLocalCommands) {
      const command = extractLocalCommand(message.content);
      if (command) {
        const handled = await this.handleLocalCommand({
          tools,
          message,
          roomId: context.roomId,
          history,
          command: command.command,
          args: command.args,
        });
        if (handled) {
          return;
        }
      }
    }

    this.debug("codex_adapter.client.ensure.start", { roomId: context.roomId });
    const client = await this.ensureClient();
    this.debug("codex_adapter.client.ensure.done", { roomId: context.roomId });
    const threadId = await this.getOrCreateThread(
      context.roomId,
      tools,
      history,
      context.isSessionBootstrap,
      message.metadata?.linear_reset_room_session !== true,
      config,
    );
    this.debug("codex_adapter.thread.ready", {
      roomId: context.roomId,
      threadId,
    });

    const input = this.buildTurnInput({
      message,
      participantsMessage,
      contactsMessage,
      history,
      roomId: context.roomId,
      maxHistoryMessages: config.maxHistoryMessages ?? 50,
    });

    const turnParams: TurnStartParams = {
      threadId,
      input,
      model: config.model ?? null,
      approvalPolicy: config.approvalPolicy ?? null,
      cwd: config.cwd ?? null,
      effort: config.reasoningEffort ?? null,
      summary: config.reasoningSummary ?? null,
    };
    const toolNames = this.buildDynamicTools(tools).map((tool) => tool.name);

    this.debug("codex_adapter.turn.start", {
      roomId: context.roomId,
      threadId,
      toolNames,
    });
    const turnStarted = parseTurnStartResponse(await client.request<unknown>(
      "turn/start",
      toRpcParams(turnParams),
    ));
    if (!turnStarted) {
      throw new Error("Codex returned an invalid turn/start payload");
    }
    this.debug("codex_adapter.turn.started", {
      roomId: context.roomId,
      threadId,
      turnId: turnStarted.turn.id,
    });

    const turnId = turnStarted.turn.id;
    let finalText = "";
    let sawSendMessageTool = false;
    let turnStatus: TurnStatus = "failed";
    let turnError = "";

    while (true) {
      let event: CodexRpcEvent;
      try {
        event = await client.recvEvent(config.turnTimeoutMs);
      } catch {
        if (turnId) {
          try {
            const interrupt: TurnInterruptParams = { threadId, turnId };
            await client.request("turn/interrupt", toRpcParams(interrupt));
          } catch (interruptError) {
            this.logger.warn("codex_adapter.turn_interrupt_failed", {
              threadId,
              turnId,
              error: interruptError,
            });
          }
        }
        turnStatus = "interrupted";
        turnError = "Turn timed out";
        break;
      }

      if (event.kind === "request") {
        const usedSendMessage = await this.handleServerRequest({
          client,
          tools,
          roomId: context.roomId,
          event,
          enableExecutionReporting: config.enableExecutionReporting ?? false,
        });
        sawSendMessageTool = sawSendMessageTool || usedSendMessage;
        continue;
      }

      if (event.method === "transport/closed") {
        turnStatus = "failed";
        turnError = "Codex transport closed unexpectedly";
        await this.resetClient();
        break;
      }

      const params = asOptionalRecord(event.params) ?? {};

      if (event.method === "error") {
        const error = asOptionalRecord(params.error) ?? {};
        const errorMessage = asNonEmptyString(error.message) ?? "Unknown Codex error";
        if (params.willRetry === true) {
          this.logger.warn("codex_adapter.retryable_error", { error: errorMessage, roomId: context.roomId });
        } else {
          await this.safeSendEvent(tools, `Codex error: ${errorMessage}`, "error", {
            codex_room_id: context.roomId,
            codex_thread_id: threadId,
            codex_turn_id: turnId,
          });
        }
        continue;
      }

      if (event.method === "item/agentMessage/delta") {
        const delta = asNonEmptyString(params.delta);
        if (delta) {
          finalText += delta;
        }
        continue;
      }

      if (event.method === "item/completed") {
        const item = parseThreadItem(params.item);
        if (!item) {
          continue;
        }

        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          finalText = item.text;
          continue;
        }

        await this.emitItemCompletedEvents(tools, item, {
          roomId: context.roomId,
          threadId,
          turnId,
          enableExecutionReporting: config.enableExecutionReporting ?? false,
          emitThoughtEvents: config.emitThoughtEvents ?? false,
        });
        continue;
      }

      if (event.method === "turn/completed") {
        const turn = parseTurnRef(params.turn);
        if (!turn) {
          this.logger.warn("codex_adapter.invalid_turn_completed_payload", {
            roomId: context.roomId,
            threadId,
            turnId,
          });
          continue;
        }
        const eventTurnId = asNonEmptyString(turn.id);
        if (eventTurnId && eventTurnId !== turnId) {
          continue;
        }

        turnStatus = turn.status;
        turnError = this.extractTurnError(turn.error);
        break;
      }
    }

    await this.emitTurnOutcome({
      tools,
      message,
      roomId: context.roomId,
      threadId,
      turnId,
      turnStatus,
      turnError,
      finalText,
      sawSendMessageTool,
      fallbackSendAgentText: config.fallbackSendAgentText ?? true,
    });
    this.debug("codex_adapter.turn.completed", {
      roomId: context.roomId,
      threadId,
      turnId,
      turnStatus,
      turnError,
    });
  }

  public override async onCleanup(roomId: string): Promise<void> {
    this.roomThreadIds.delete(roomId);
    this.roomThreadInitPromises.delete(roomId);
    this.roomConfigOverrides.delete(roomId);
    this.needsHistoryInjection.delete(roomId);
  }

  public async onRuntimeStop(): Promise<void> {
    await this.resetClient();
  }

  private getConfig(roomId: string): CodexAdapterConfig {
    const overrides = this.roomConfigOverrides.get(roomId);
    return overrides ? { ...this.baseConfig, ...overrides } : this.baseConfig;
  }

  private ensureSystemPrompt(): void {
    if (this.systemPrompt !== null) {
      return;
    }

    const systemPromptOverride = this.baseConfig.systemPrompt?.trim() ?? "";
    if (systemPromptOverride.length > 0) {
      this.systemPrompt = systemPromptOverride;
      return;
    }

    const customSection = this.baseConfig.customSection?.trim() ?? "";
    const prompt = renderSystemPrompt({
      agentName: this.agentName,
      agentDescription: this.agentDescription,
      customSection,
      includeBaseInstructions: this.baseConfig.includeBaseInstructions ?? true,
    }).trim();

    this.systemPrompt = prompt.length > 0 ? prompt : null;
  }

  private async ensureClient(): Promise<CodexClientLike> {
    if (this.client) {
      return this.client;
    }

    if (this.clientPromise) {
      return await this.clientPromise;
    }

    const cooldownMs = 2_000;
    const elapsed = Date.now() - this.lastInitFailure;
    if (this.lastInitFailure > 0 && elapsed < cooldownMs) {
      throw new Error(
        `Codex client init failed recently (${elapsed}ms ago). Retrying after ${cooldownMs}ms cooldown.`,
      );
    }

    this.clientPromise = (async (): Promise<CodexClientLike> => {
      try {
        const client = await (this.factoryOverride ?? loadCodexFactory(this.baseConfig, this.logger))();
        await client.connect();
        await client.initialize({
          clientInfo: {
            name: this.baseConfig.clientName ?? "thenvoi_codex_adapter",
            title: this.baseConfig.clientTitle ?? "Band Codex Adapter",
            version: this.baseConfig.clientVersion ?? "0.1.0",
          },
          capabilities: {
            experimentalApi: this.baseConfig.experimentalApi ?? true,
          },
        });
        this.client = client;
        return client;
      } catch (error) {
        this.lastInitFailure = Date.now();
        this.client = null;
        this.logger.error("Codex client initialization failed", {
          error,
        });
        throw error;
      } finally {
        this.clientPromise = null;
      }
    })();

    return await this.clientPromise;
  }

  private async resetClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientPromise = null;

    if (client) {
      try {
        await client.close();
      } catch (error) {
        this.logger.warn("codex_adapter.client_close_failed", {
          error,
        });
      }
    }
  }

  private debug(message: string, context: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info(message, context);
  }

  private async getOrCreateThread(
    roomId: string,
    tools: AgentToolsProtocol,
    history: HistoryProvider,
    isSessionBootstrap: boolean,
    allowHistoryThreadResume: boolean,
    config: CodexAdapterConfig,
  ): Promise<string> {
    const existing = this.roomThreadIds.get(roomId);
    if (existing) {
      return existing;
    }

    const pending = this.roomThreadInitPromises.get(roomId);
    if (pending) {
      return await pending;
    }

    const initPromise = (async (): Promise<string> => {
      const client = await this.ensureClient();
      const resumeThreadId = isSessionBootstrap && allowHistoryThreadResume
        ? extractThreadIdFromHistory(history.raw)
        : null;

      if (resumeThreadId) {
        try {
          const resumed = parseThreadResponse(await client.request<unknown>(
            "thread/resume",
            toRpcParams(this.buildThreadResumeParams(resumeThreadId, config)),
          ));
          if (!resumed) {
            throw new Error("Codex returned an invalid thread/resume payload");
          }
          const threadId = resumed.thread.id;
          this.roomThreadIds.set(roomId, threadId);
          await this.sendThreadMappingEvent(tools, roomId, threadId, "resumed");
          return threadId;
        } catch (error) {
          this.logger.warn("codex_adapter.thread_resume_failed", {
            roomId,
            threadId: resumeThreadId,
            error,
          });
          this.needsHistoryInjection.add(roomId);
        }
      }

      if (isSessionBootstrap && allowHistoryThreadResume && !resumeThreadId) {
        this.needsHistoryInjection.add(roomId);
      }

      const started = parseThreadResponse(await client.request<unknown>(
        "thread/start",
        toRpcParams(this.buildThreadStartParams(tools, config)),
      ));
      if (!started) {
        throw new Error("Codex returned an invalid thread/start payload");
      }
      const threadId = started.thread.id;
      this.roomThreadIds.set(roomId, threadId);
      await this.sendThreadMappingEvent(tools, roomId, threadId, "mapped");
      return threadId;
    })();

    this.roomThreadInitPromises.set(roomId, initPromise);
    try {
      return await initPromise;
    } finally {
      if (this.roomThreadInitPromises.get(roomId) === initPromise) {
        this.roomThreadInitPromises.delete(roomId);
      }
    }
  }

  private buildThreadStartParams(
    tools: AgentToolsProtocol,
    config: CodexAdapterConfig,
  ) {
    return {
      model: config.model ?? null,
      cwd: config.cwd ?? null,
      approvalPolicy: config.approvalPolicy ?? null,
      sandbox: config.sandboxMode ?? null,
      config: this.buildThreadConfigOverrides(config),
      developerInstructions: this.systemPrompt,
      dynamicTools: this.buildDynamicTools(tools),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
  }

  private buildThreadResumeParams(
    threadId: string,
    config: CodexAdapterConfig,
  ) {
    return {
      threadId,
      model: config.model ?? null,
      cwd: config.cwd ?? null,
      approvalPolicy: config.approvalPolicy ?? null,
      sandbox: config.sandboxMode ?? null,
      config: this.buildThreadConfigOverrides(config),
      developerInstructions: this.systemPrompt,
      persistExtendedHistory: true,
    };
  }

  private buildThreadConfigOverrides(config: CodexAdapterConfig): Record<string, unknown> | null {
    const overrides: Record<string, unknown> = {};

    if (config.skipGitRepoCheck !== undefined) {
      overrides.skip_git_repo_check = config.skipGitRepoCheck;
    }

    if (config.webSearchMode) {
      overrides.web_search = config.webSearchMode;
    }

    if (config.networkAccessEnabled !== undefined && config.sandboxMode === "workspace-write") {
      overrides.sandbox_workspace_write = {
        network_access: config.networkAccessEnabled,
      };
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
  }

  private buildDynamicTools(tools: AgentToolsProtocol): Array<{ name: string; description: string; inputSchema: unknown }> {
    const specs: Array<{ name: string; description: string; inputSchema: unknown }> = [];
    const seen = new Set<string>();
    const schemas = [
      ...tools.getOpenAIToolSchemas({ includeMemory: this.includeMemoryTools }),
      ...this.customTools.map((tool) => customToolToOpenAISchema(tool)),
    ];

    for (const schema of schemas) {
      const record = asRecord(schema);
      const functionSchema = asRecord(record.function);
      const name = asNonEmptyString(functionSchema.name);
      if (!name || seen.has(name)) {
        continue;
      }

      specs.push({
        name,
        description: asNonEmptyString(functionSchema.description) ?? "",
        inputSchema: functionSchema.parameters ?? {
          type: "object",
          properties: {},
        },
      });
      seen.add(name);
    }

    return specs;
  }

  private buildTurnInput(input: {
    message: PlatformMessage;
    participantsMessage: string | null;
    contactsMessage: string | null;
    history: HistoryProvider;
    roomId: string;
    maxHistoryMessages: number;
  }): Array<{ type: "text"; text: string }> {
    const items: Array<{ type: "text"; text: string }> = [];

    if (this.needsHistoryInjection.has(input.roomId)) {
      this.needsHistoryInjection.delete(input.roomId);
      const context = this.formatHistoryContext(input.history.raw, input.maxHistoryMessages);
      if (context) {
        items.push({ type: "text", text: context });
      }
    }

    if (input.participantsMessage) {
      items.push({ type: "text", text: `[System]: ${input.participantsMessage}` });
    }

    if (input.contactsMessage) {
      items.push({ type: "text", text: `[System]: ${input.contactsMessage}` });
    }

    items.push({
      type: "text",
      text: `[${input.message.senderName ?? input.message.senderType}]: ${input.message.content}`,
    });

    return items;
  }

  private formatHistoryContext(
    raw: Array<Record<string, unknown>>,
    maxHistoryMessages: number,
  ): string | null {
    const lines: string[] = [];
    for (const entry of raw) {
      const messageType = String(entry.message_type ?? "");
      if (!["text", "message"].includes(messageType)) {
        continue;
      }

      const content = asNonEmptyString(entry.content);
      if (!content) {
        continue;
      }

      const sender = asNonEmptyString(entry.sender_name)
        ?? asNonEmptyString(entry.sender_type)
        ?? "Unknown";
      lines.push(`[${sender}]: ${content}`);
    }

    if (lines.length === 0) {
      return null;
    }

    const truncated = lines.slice(-maxHistoryMessages);
    return [
      "[Conversation History]",
      "The following is the conversation history from a previous session. Use it to maintain continuity.",
      ...truncated,
    ].join("\n");
  }

  private async sendThreadMappingEvent(
    tools: AgentToolsProtocol,
    roomId: string,
    threadId: string,
    status: "mapped" | "resumed",
  ): Promise<void> {
    await this.safeSendEvent(
      tools,
      `Codex thread status: ${status}`,
      "task",
      {
        codex_room_id: roomId,
        codex_thread_id: threadId,
        codex_created_at: new Date().toISOString(),
        codex_status: status,
      },
    );
  }

  private async handleServerRequest(input: {
    client: CodexClientLike;
    tools: AgentToolsProtocol;
    roomId: string;
    event: CodexRpcEvent & { kind: "request" };
    enableExecutionReporting: boolean;
  }): Promise<boolean> {
    const { client, tools, event } = input;

    if (event.method === "item/tool/call") {
      const params = parseDynamicToolCallParams(event.params);
      if (!params) {
        await client.respondError(event.id, -32602, "Invalid params for item/tool/call");
        return false;
      }
      const toolName = params.tool;
      const callId = params.callId;
      const arguments_ = params.arguments;
      const shouldReport = input.enableExecutionReporting && !SILENT_REPORTING_TOOLS.has(toolName);

      if (shouldReport) {
        await this.safeSendEvent(tools, JSON.stringify({
          name: toolName,
          args: arguments_,
          tool_call_id: callId,
        }), "tool_call");
      }

      try {
        const customTool = findCustomToolInIndex(this.customToolIndex, toolName);
        let output: unknown;
        if (customTool) {
          try {
            output = await executeCustomTool(customTool, arguments_);
          } catch (error) {
            output = normalizeCustomToolError(toolName, error);
          }
        } else {
          output = await tools.executeToolCall(toolName, arguments_);
        }

        const isError = isCodexToolOutputError(output);
        const responseText = renderCodexToolOutput(output);

        await client.respond(event.id, {
          contentItems: [
            {
              type: "inputText",
              text: responseText,
            },
          ],
          success: !isError,
        });

        if (shouldReport) {
          await this.safeSendEvent(tools, JSON.stringify({
            name: toolName,
            output,
            tool_call_id: callId,
          }), "tool_result");
        }

        return !isError && toolName === "thenvoi_send_message";
      } catch (error) {
        const output = {
          ok: false,
          errorType: "ToolExecutionUnhandledError",
          message: asErrorMessage(error),
          toolName,
        };
        const errorText = renderCodexToolOutput(output);
        await client.respond(event.id, {
          contentItems: [
            {
              type: "inputText",
              text: errorText,
            },
          ],
          success: false,
        });

        if (shouldReport) {
          await this.safeSendEvent(tools, JSON.stringify({
            name: toolName,
            output,
            tool_call_id: callId,
          }), "tool_result");
        }

        return false;
      }
    }

    if (event.method === "item/commandExecution/requestApproval") {
      await client.respond(event.id, { decision: "decline" });
      return false;
    }

    if (event.method === "item/fileChange/requestApproval") {
      await client.respond(event.id, { decision: "decline" });
      return false;
    }

    await client.respondError(event.id, -32601, `Unhandled server request: ${event.method}`);
    return false;
  }

  private async emitItemCompletedEvents(
    tools: AgentToolsProtocol,
    item: ThreadItem,
    options: {
      roomId: string;
      threadId: string;
      turnId: string;
      enableExecutionReporting: boolean;
      emitThoughtEvents: boolean;
    },
  ): Promise<void> {
    const metadata = {
      codex_room_id: options.roomId,
      codex_thread_id: options.threadId,
      codex_turn_id: options.turnId,
    };

    if (options.enableExecutionReporting && isToolLikeItem(item)) {
      const [name, args, output] = this.extractToolItem(item);
      await this.safeSendEvent(tools, JSON.stringify({
        name,
        args,
        tool_call_id: item.id ?? null,
      }), "tool_call", metadata);
      await this.safeSendEvent(tools, JSON.stringify({
        name,
        output,
        tool_call_id: item.id ?? null,
      }), "tool_result", metadata);
      return;
    }

    if (options.emitThoughtEvents && isThoughtLikeItem(item)) {
      const thoughtText = this.extractThoughtText(item);
      if (thoughtText) {
        await this.safeSendEvent(tools, thoughtText, "thought", metadata);
      }
    }
  }

  private extractToolItem(item: ToolLikeItem): [string, Record<string, unknown>, string] {
    if (item.type === "commandExecution") {
      const args = {
        command: item.command,
        cwd: item.cwd,
      };
      const outputParts: string[] = [];
      if (item.aggregatedOutput) {
        outputParts.push(item.aggregatedOutput);
      }
      if (item.exitCode !== null) {
        outputParts.push(`exit_code=${item.exitCode}`);
      }
      return ["exec", args, outputParts.join("\n") || item.status];
    }

    if (item.type === "fileChange") {
      return [
        "file_edit",
        { files: item.changes.map((change) => change.path) },
        item.status,
      ];
    }

    if (item.type === "mcpToolCall") {
      const args = asOptionalRecord(item.arguments) ?? {};
      const output = item.result ?? item.error ?? "completed";
      return [`mcp:${item.server}/${item.tool}`, args, toWireString(output)];
    }

    if (item.type === "webSearch") {
      return ["web_search", { query: item.query }, toWireString(item.action ?? "completed")];
    }

    if (item.type === "imageView") {
      return ["view_image", { path: item.path }, "viewed"];
    }

    return [
      `collab:${item.tool}`,
      {
        ...(item.prompt ? { prompt: item.prompt } : {}),
        ...(item.agents ? { agents: item.agents } : {}),
      },
      toWireString(item.result ?? "completed"),
    ];
  }

  private extractThoughtText(item: ThoughtLikeItem): string | null {
    if (item.type === "reasoning") {
      const summary = item.summary
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .join("\n");
      if (summary) {
        return summary;
      }

      const content = item.content
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .join("\n");
      return content || null;
    }

    if (item.type === "plan") {
      return item.text || "(plan)";
    }

    if (item.type === "contextCompaction") {
      return "Context compaction performed";
    }

    return item.text ?? item.review ?? `Review mode: ${item.type}`;
  }

  private async emitTurnOutcome(input: {
    tools: AgentToolsProtocol;
    message: PlatformMessage;
    roomId: string;
    threadId: string;
    turnId: string;
    turnStatus: TurnStatus;
    turnError: string;
    finalText: string;
    sawSendMessageTool: boolean;
    fallbackSendAgentText: boolean;
  }): Promise<void> {
    const mention = this.currentMention(input.message);

    if (input.turnStatus === "completed") {
      if (input.fallbackSendAgentText && input.finalText.trim() && !input.sawSendMessageTool) {
        await input.tools.sendMessage(input.finalText.trim(), mention);
      }
      return;
    }

    if (input.turnStatus === "interrupted") {
      await input.tools.sendMessage("I stopped before completing this request.", mention);
      return;
    }

    const errorText = input.turnError
      ? `I couldn't complete this request (${input.turnStatus}): ${input.turnError}`
      : `I couldn't complete this request (${input.turnStatus}).`;
    await input.tools.sendMessage(errorText, mention);
  }

  private extractTurnError(error: TurnErrorInfo | null | undefined): string {
    if (!error) {
      return "";
    }

    if (typeof error.additionalDetails === "string" && error.additionalDetails.trim()) {
      return `${error.message}: ${error.additionalDetails}`;
    }

    return error.message;
  }

  private currentMention(message: PlatformMessage): MentionInput {
    return [{ id: message.senderId, handle: message.senderName ?? undefined }];
  }

  private async handleLocalCommand(input: {
    tools: AgentToolsProtocol;
    message: PlatformMessage;
    history: HistoryProvider;
    roomId: string;
    command: string;
    args: string;
  }): Promise<boolean> {
    const mention = this.currentMention(input.message);
    const mappedThreadId = this.roomThreadIds.get(input.roomId) ?? extractThreadIdFromHistory(input.history.raw);

    if (input.command === "help") {
      await input.tools.sendMessage(
        "Codex commands: `/status`, `/model`, `/models`, `/model list`, `/models list`, `/model <id>`, `/reasoning [low|medium|high|xhigh]`, `/help`.",
        mention,
      );
      return true;
    }

    if (input.command === "status") {
      const roomConfig = this.getConfig(input.roomId);
      await input.tools.sendMessage(
        [
          "Codex status:",
          `- selected_model: ${roomConfig.model ?? "default"}`,
          `- room_id: ${input.roomId}`,
          `- thread_id: ${mappedThreadId ?? "not mapped"}`,
          `- approval_policy: ${String(roomConfig.approvalPolicy ?? "never")}`,
          `- sandbox_mode: ${roomConfig.sandboxMode ?? "workspace-write"}`,
          `- reasoning_effort: ${roomConfig.reasoningEffort ?? "default"}`,
        ].join("\n"),
        mention,
      );
      return true;
    }

    if (input.command === "model" || input.command === "models") {
      const arg = input.args.trim();
      if (!arg) {
        const roomConfig = this.getConfig(input.roomId);
        await input.tools.sendMessage(
          `Current model: \`${roomConfig.model ?? "default"}\`. Use \`/model list\` or \`/model <id>\`.`,
          mention,
        );
        return true;
      }

      if (arg === "list" || arg === "ls") {
        const client = await this.ensureClient();
        const result = parseModelListResponse(await client.request<unknown>("model/list", {}));
        if (!result) {
          await input.tools.sendMessage("Received an invalid model list from Codex.", mention);
          return true;
        }
        const visible = result.data.filter((entry) => !entry.hidden);
        if (visible.length === 0) {
          await input.tools.sendMessage("No visible models returned by Codex.", mention);
          return true;
        }

        await input.tools.sendMessage(
          [
            "Available models:",
            ...visible.map((entry) => `- \`${entry.id}\`${entry.isDefault ? " (default)" : ""}`),
          ].join("\n"),
          mention,
        );
        return true;
      }

      const overrides = this.roomConfigOverrides.get(input.roomId) ?? {};
      overrides.model = arg;
      this.roomConfigOverrides.set(input.roomId, overrides);
      await input.tools.sendMessage(
        `Model override set to \`${arg}\` for subsequent turns.`,
        mention,
      );
      return true;
    }

    if (input.command === "reasoning") {
      const effort = input.args.trim().toLowerCase();
      if (!effort) {
        const roomConfig = this.getConfig(input.roomId);
        await input.tools.sendMessage(
          `Current reasoning effort: \`${roomConfig.reasoningEffort ?? "default"}\`. Use \`/reasoning ${CODEX_REASONING_EFFORTS.join("|")}\`.`,
          mention,
        );
        return true;
      }

      if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(effort)) {
        await input.tools.sendMessage(
          `Invalid reasoning effort \`${effort}\`. Valid values: ${CODEX_REASONING_EFFORTS.join(", ")}.`,
          mention,
        );
        return true;
      }

      const overrides = this.roomConfigOverrides.get(input.roomId) ?? {};
      overrides.reasoningEffort = effort as CodexReasoningEffort;
      this.roomConfigOverrides.set(input.roomId, overrides);
      await input.tools.sendMessage(
        `Reasoning effort set to \`${effort}\` for subsequent turns.`,
        mention,
      );
      return true;
    }

    return false;
  }

  private async safeSendEvent(
    tools: AgentToolsProtocol,
    content: string,
    messageType: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await tools.sendEvent(content, messageType, metadata);
    } catch (error) {
      this.logger.warn("codex_adapter.event_emit_failed", {
        messageType,
        content,
        metadata,
        error,
      });
    }
  }
}

function isToolLikeItem(item: ThreadItem): item is ToolLikeItem {
  return [
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "webSearch",
    "imageView",
    "collabAgentToolCall",
  ].includes(item.type);
}

function isThoughtLikeItem(item: ThreadItem): item is ThoughtLikeItem {
  return [
    "reasoning",
    "plan",
    "contextCompaction",
    "enteredReviewMode",
    "exitedReviewMode",
  ].includes(item.type);
}

function extractLocalCommand(
  content: string,
): { command: string; args: string } | null {
  const tokens = content.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const commands = new Set([
    "help",
    "status",
    "model",
    "models",
    "reasoning",
  ]);

  const searchLimit = Math.min(tokens.length, 5);
  for (let index = 0; index < searchLimit; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith("/") || token.length === 1) {
      continue;
    }

    const command = token.slice(1).toLowerCase();
    if (!commands.has(command)) {
      continue;
    }

    return {
      command,
      args: tokens.slice(index + 1).join(" ").trim(),
    };
  }

  return null;
}

function extractThreadIdFromHistory(
  raw: Array<Record<string, unknown>>,
): string | null {
  const metadata = findLatestTaskMetadata(
    raw,
    (entry) => typeof entry.codex_thread_id === "string" && entry.codex_thread_id.length > 0,
  );
  const threadId = metadata?.codex_thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

function loadCodexFactory(
  config: CodexAdapterConfig,
  logger: Logger,
): CodexFactory {
  return async () => {
    if (config.codexCommand && config.codexCommand.length === 0) {
      throw new Error("Codex app-server command is empty");
    }

    return new CodexAppServerStdioClient({
      command: config.codexCommand,
      cwd: config.cwd,
      env: config.codexEnv,
      logger,
    });
  };
}

const TURN_STATUS_VALUES = new Set<TurnStatus>([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

function isStructuredToolFailure(value: unknown): value is { ok: false; message: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return payload.ok === false && typeof payload.message === "string";
}

function isCodexToolOutputError(value: unknown): boolean {
  return isToolExecutorError(value) || isStructuredToolFailure(value);
}

function renderCodexToolOutput(value: unknown): string {
  if (isToolExecutorError(value)) {
    return toLegacyToolExecutorErrorMessage(value) ?? value.message;
  }

  if (isStructuredToolFailure(value)) {
    return `Error: ${value.message}`;
  }

  return toWireString(value);
}

function normalizeCustomToolError(
  toolName: string,
  error: unknown,
): {
  ok: false;
  errorType: string;
  message: string;
  toolName: string;
} {
  if (error instanceof CustomToolValidationError || error instanceof CustomToolExecutionError) {
    return {
      ok: false,
      errorType: error.name,
      message: error.message,
      toolName: error.toolName,
    };
  }

  return {
    ok: false,
    errorType: "CustomToolUnknownError",
    message: asErrorMessage(error),
    toolName,
  };
}

function toRpcParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex RPC params must be an object");
  }
  return value as Record<string, unknown>;
}

function parseDynamicToolCallParams(
  value: unknown,
): {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
} | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const threadId = asNonEmptyString(record.threadId);
  const turnId = asNonEmptyString(record.turnId);
  const callId = asNonEmptyString(record.callId);
  const tool = asNonEmptyString(record.tool);
  if (!threadId || !turnId || !callId || !tool) {
    return null;
  }

  return {
    threadId,
    turnId,
    callId,
    tool,
    arguments: asOptionalRecord(record.arguments) ?? {},
  };
}

function parseThreadItem(value: unknown): ThreadItem | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const type = asNonEmptyString(record.type);
  if (!type) {
    return null;
  }
  const id = asNonEmptyString(record.id);
  return {
    ...record,
    type,
    ...(id ? { id } : {}),
  };
}

function parseTurnErrorInfo(value: unknown): TurnErrorInfo | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const message = value.trim();
    if (!message) {
      return null;
    }
    return { message, additionalDetails: null };
  }

  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const message = asNonEmptyString(record.message);
  if (!message) {
    return null;
  }

  return {
    message,
    additionalDetails: asNonEmptyString(record.additionalDetails) ?? null,
  };
}

function parseTurnStatus(value: unknown): TurnStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  return TURN_STATUS_VALUES.has(value as TurnStatus)
    ? (value as TurnStatus)
    : null;
}

function parseTurnRef(value: unknown): {
  id: string;
  status: TurnStatus;
  error: TurnErrorInfo | null;
} | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const id = asNonEmptyString(record.id);
  const status = parseTurnStatus(record.status);
  if (!id || !status) {
    return null;
  }

  return {
    id,
    status,
    error: parseTurnErrorInfo(record.error),
  };
}

function parseTurnStartResponse(value: unknown): TurnStartResponse | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const turn = parseTurnRef(record.turn);
  if (!turn) {
    return null;
  }
  return { turn };
}

function parseThreadResponse(value: unknown): ThreadStartResponse | ThreadResumeResponse | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const thread = asOptionalRecord(record.thread);
  if (!thread) {
    return null;
  }
  const threadId = asNonEmptyString(thread.id);
  const model = asNonEmptyString(record.model);
  if (!threadId || !model) {
    return null;
  }

  return {
    thread: { id: threadId },
    model,
  };
}

function parseModelListResponse(value: unknown): ModelListResponse | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  if (!Array.isArray(record.data)) {
    return null;
  }

  const data = record.data
    .map((entry) => {
      const item = asOptionalRecord(entry);
      if (!item) {
        return null;
      }
      const id = asNonEmptyString(item.id);
      if (!id) {
        return null;
      }
      return {
        id,
        displayName: asNonEmptyString(item.displayName) ?? id,
        description: asNonEmptyString(item.description) ?? "",
        hidden: item.hidden === true,
        isDefault: item.isDefault === true,
      };
    })
    .filter((entry): entry is ModelListResponse["data"][number] => entry !== null);

  return { data };
}

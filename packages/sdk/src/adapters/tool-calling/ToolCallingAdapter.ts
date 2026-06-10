import { SimpleAdapter } from "../../core/simpleAdapter";
import {
  isToolExecutorError,
  type MessagingTools,
  type ToolExecutor,
  type ToolSchemaProvider,
} from "../../contracts/protocols";
import type { ToolModelMessage } from "../../contracts/dtos";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { formatHistoryForLlm } from "../../runtime/formatters";
import { renderSystemPrompt } from "../../runtime/prompts";
import {
  CustomToolExecutionError,
  CustomToolValidationError,
  type CustomToolDef,
  buildCustomToolIndex,
  customToolsToSchemas,
  executeCustomTool,
  findCustomToolInIndex,
} from "../../runtime/tools/customTools";
import type {
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
  ToolResult,
  ToolRound,
} from "./types";

export interface ToolCallingAdapterOptions {
  model: ToolCallingModel;
  toolFormat: "openai" | "anthropic";
  systemPrompt?: string;
  customSection?: string;
  includeMemoryTools?: boolean;
  maxToolRounds?: number;
  enableExecutionReporting?: boolean;
  customTools?: CustomToolDef[];
  logger?: Logger;
}

type ToolCallingTools = MessagingTools & ToolExecutor & ToolSchemaProvider;

export class ToolCallingAdapter extends SimpleAdapter<HistoryProvider, ToolCallingTools> {
  private readonly model: ToolCallingModel;
  private readonly toolFormat: "openai" | "anthropic";
  private readonly systemPromptOverride?: string;
  private readonly customSection: string;
  private readonly includeMemoryTools: boolean;
  private readonly maxToolRounds: number;
  private readonly enableExecutionReporting: boolean;
  private readonly customTools: CustomToolDef[];
  private readonly customToolIndex: Map<string, CustomToolDef>;
  private readonly logger: Logger;

  public constructor(options: ToolCallingAdapterOptions) {
    super();
    this.model = options.model;
    this.toolFormat = options.toolFormat;
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection ?? "";
    this.includeMemoryTools = options.includeMemoryTools ?? false;
    this.maxToolRounds = options.maxToolRounds ?? 8;
    this.enableExecutionReporting = options.enableExecutionReporting ?? false;
    this.customTools = options.customTools ?? [];
    this.customToolIndex = buildCustomToolIndex(this.customTools);
    this.logger = options.logger ?? new NoopLogger();
  }

  public async onMessage(
    message: PlatformMessage,
    tools: ToolCallingTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    _context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const platformSchemas = tools.getToolSchemas(this.toolFormat, {
      includeMemory: this.includeMemoryTools,
    });
    const customSchemas = customToolsToSchemas(this.customTools, this.toolFormat);
    const schemas = [...platformSchemas, ...customSchemas];

    const messages = this.buildMessages(history, message, participantsMessage, contactsMessage);
    const systemPrompt = this.resolveSystemPrompt();

    const toolRounds: ToolRound[] = [];

    let response = await this.model.complete({
      systemPrompt,
      messages,
      tools: schemas,
    });

    let roundCount = 0;
    while ((response.toolCalls?.length ?? 0) > 0) {
      roundCount += 1;
      if (roundCount > this.maxToolRounds) {
        const maxRoundsError = new Error(
          `Stopped tool loop after ${this.maxToolRounds} rounds to prevent infinite recursion.`,
        );
        await tools.sendEvent(
          maxRoundsError.message,
          "error",
        );
        throw maxRoundsError;
      }

      const roundToolCalls = response.toolCalls ?? [];

      const roundToolResults: ToolResult[] = [];
      for (const call of roundToolCalls) {
        if (this.enableExecutionReporting) {
          await this.reportExecutionEvent(
            tools,
            {
              name: call.name,
              args: call.input,
              tool_call_id: call.id,
            },
            "tool_call",
          );
        }

        let output: unknown;
        if (call.inputParseError) {
          output = {
            ok: false,
            errorType: "ToolCallArgumentsParseError",
            message: call.inputParseError,
            toolName: call.name,
            toolCallId: call.id,
          };
        } else {
          const customTool = findCustomToolInIndex(this.customToolIndex, call.name);
          if (customTool) {
            try {
              output = await executeCustomTool(customTool, call.input);
            } catch (error) {
              if (error instanceof CustomToolValidationError || error instanceof CustomToolExecutionError) {
                output = {
                  ok: false,
                  errorType: error.name,
                  message: error.message,
                  toolName: error.toolName,
                };
              } else {
                output = {
                  ok: false,
                  errorType: "CustomToolUnknownError",
                  message: error instanceof Error ? error.message : String(error),
                  toolName: call.name,
                };
              }
            }
          } else {
            output = await tools.executeToolCall(call.name, call.input);
          }
        }
        const isError = isToolOutputError(output);
        roundToolResults.push({
          toolCallId: call.id,
          name: call.name,
          output,
          isError,
        });

        if (this.enableExecutionReporting) {
          await this.reportExecutionEvent(
            tools,
            {
              name: call.name,
              output,
              tool_call_id: call.id,
            },
            "tool_result",
          );
        }
      }

      toolRounds.push({ toolCalls: roundToolCalls, toolResults: roundToolResults });

      response = await this.model.complete({
        systemPrompt,
        messages,
        tools: schemas,
        toolRounds,
      });
    }

    const text = response.text?.trim();
    if (text) {
      await tools.sendMessage(text, [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
    } else if ((response.toolCalls?.length ?? 0) === 0) {
      this.logger.warn("Model returned empty response with no tool calls", {
        messageId: message.id,
      });
    }
  }

  private buildMessages(
    history: HistoryProvider,
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
  ): ToolModelMessage[] {
    const base = formatHistoryForLlm(history.raw);
    const historyAlreadyContainsMessage = history.raw.some((entry) => entry.id === message.id);
    if (!historyAlreadyContainsMessage) {
      base.push({
        role: message.senderType === "Agent" ? "assistant" : "user",
        content: message.content,
        sender_name: message.senderName,
        sender_type: message.senderType,
        message_type: message.messageType,
        metadata: message.metadata,
      });
    }

    if (participantsMessage) {
      base.push({ role: "system", content: participantsMessage });
    }

    if (contactsMessage) {
      base.push({ role: "system", content: contactsMessage });
    }

    return base;
  }

  private resolveSystemPrompt(): string {
    if (this.systemPromptOverride !== undefined) {
      return this.systemPromptOverride;
    }

    return renderSystemPrompt({
      agentName: this.agentName || undefined,
      agentDescription: this.agentDescription || undefined,
      customSection: this.customSection,
      capabilities: { memory: this.includeMemoryTools },
    });
  }

  private async reportExecutionEvent(
    tools: ToolCallingTools,
    payload: Record<string, unknown>,
    messageType: "tool_call" | "tool_result",
  ): Promise<void> {
    try {
      await tools.sendEvent(JSON.stringify(payload), messageType);
    } catch (error) {
      this.logger.error("Tool execution reporting failed", {
        messageType,
        payload,
        error,
      });
    }
  }
}

function isToolOutputError(output: unknown): boolean {
  if (isToolExecutorError(output)) {
    return true;
  }

  if (typeof output === "string") {
    const lower = output.toLowerCase();
    return lower.startsWith("error:") || lower.startsWith("error executing ");
  }

  if (output && typeof output === "object" && "ok" in output) {
    return (output as Record<string, unknown>).ok === false;
  }

  return false;
}

export function runSingleToolRound(
  model: ToolCallingModel,
  request: ToolCallingModelRequest,
): Promise<ToolCallingResponse> {
  return model.complete(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool round failed: ${message}`, { cause: error });
  });
}

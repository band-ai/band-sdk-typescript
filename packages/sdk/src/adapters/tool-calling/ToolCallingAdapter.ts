import { SimpleAdapter } from "../../core/simpleAdapter";
import {
  isToolExecutorError,
  type MessagingTools,
  type ToolExecutor,
  type ToolSchemaProvider,
} from "../../contracts/protocols";
import type { ToolModelMessage } from "../../contracts/dtos";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { formatHistoryForLlm } from "../../runtime/formatters";
import { SEND_MESSAGE_TOOL_NAME } from "../../runtime/tools/schemas";
import { asErrorMessage } from "../shared/coercion";
import { reportProviderTurnFailure } from "../../core/providerFailure";
import { deliverReply } from "../../core/deliveryFailedError";
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

/** `AgentFailure.provider` for a subclass that does not name itself. */
const DEFAULT_PROVIDER = "tool-calling";

export interface ToolCallingAdapterOptions {
  model: ToolCallingModel;
  toolFormat: "openai" | "anthropic";
  /** Passed through as `AgentFailure.provider` on a provider failure. Defaults to `DEFAULT_PROVIDER` when omitted. */
  provider?: string;
  systemPrompt?: string;
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
  protected readonly provider: string;
  private readonly systemPrompt?: string;
  private readonly includeMemoryTools: boolean;
  private readonly maxToolRounds: number;
  private readonly enableExecutionReporting: boolean;
  private readonly customTools: CustomToolDef[];
  private readonly customToolIndex: Map<string, CustomToolDef>;
  private readonly logger: Logger;
  /** Each room's conversation, carried across turns; platform history seeds it only at session bootstrap. */
  private readonly conversations = new Map<string, ToolModelMessage[]>();

  public constructor(options: ToolCallingAdapterOptions) {
    super();
    this.model = options.model;
    this.toolFormat = options.toolFormat;
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.systemPrompt = options.systemPrompt;
    this.includeMemoryTools = options.includeMemoryTools ?? false;
    this.maxToolRounds = options.maxToolRounds ?? 8;
    this.enableExecutionReporting = options.enableExecutionReporting ?? false;
    this.customTools = options.customTools ?? [];
    this.customToolIndex = buildCustomToolIndex(this.customTools);
    this.logger = resolveLogger(options.logger);
  }

  public async onMessage(
    message: PlatformMessage,
    tools: ToolCallingTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const conversation = this.conversationFor(context, history, message);
    conversation.push(...this.turnInput(message, participantsMessage, contactsMessage));
    const toolRounds: ToolRound[] = [];
    let text: string | undefined;
    try {
      const platformSchemas = tools.getToolSchemas(this.toolFormat, {
        includeMemory: this.includeMemoryTools,
      });
      const customSchemas = customToolsToSchemas(this.customTools, this.toolFormat);
      const schemas = [...platformSchemas, ...customSchemas];

      const messages = [...conversation];

      let response = await this.model.complete({
        systemPrompt: this.systemPrompt,
        messages,
        tools: schemas,
      });

      let roundCount = 0;
      while ((response.toolCalls?.length ?? 0) > 0) {
        roundCount += 1;
        if (roundCount > this.maxToolRounds) {
          throw new Error(
            `Stopped tool loop after ${this.maxToolRounds} rounds to prevent infinite recursion.`,
          );
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
                    message: asErrorMessage(error),
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
          systemPrompt: this.systemPrompt,
          messages,
          tools: schemas,
          toolRounds,
        });
      }

      text = response.text?.trim();
      if (!text && (response.toolCalls?.length ?? 0) === 0) {
        this.logger.warn("Model returned empty response with no tool calls", {
          messageId: message.id,
        });
      }
    } catch (error) {
      await reportProviderTurnFailure(tools, this.logger, this.provider, "Tool-calling adapter request failed", error, { messageId: message.id });
    }

    conversation.push(...answersOf(toolRounds, text));

    if (text) {
      await deliverReply(tools, text, [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
    }
  }

  public override async onCleanup(roomId: string): Promise<void> {
    this.conversations.delete(roomId);
  }

  /** The room's conversation so far, seeded from platform history at session bootstrap (without the current message). */
  private conversationFor(
    context: { isSessionBootstrap: boolean; roomId: string },
    history: HistoryProvider,
    message: PlatformMessage,
  ): ToolModelMessage[] {
    const existing = this.conversations.get(context.roomId);
    if (existing && !context.isSessionBootstrap) {
      return existing;
    }
    const seeded = context.isSessionBootstrap
      ? formatHistoryForLlm(history.raw, { excludeId: message.id }).map((entry) => this.asConversationTurn(entry))
      : [];
    this.conversations.set(context.roomId, seeded);
    return seeded;
  }

  private turnInput(
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
  ): ToolModelMessage[] {
    const turn: ToolModelMessage[] = [this.asConversationTurn({
      role: "user",
      content: message.content,
      sender_name: message.senderName,
      sender_type: message.senderType,
      message_type: message.messageType,
      metadata: message.metadata,
    })];
    if (participantsMessage) {
      turn.push({ role: "system", content: participantsMessage });
    }
    if (contactsMessage) {
      turn.push({ role: "system", content: contactsMessage });
    }
    return turn;
  }

  /**
   * Only this agent's own messages are its turns. Everyone else's — users and
   * other agents alike — is a user turn attributed to its sender; otherwise
   * the model reads another agent's request as something it said itself.
   */
  private asConversationTurn(entry: ToolModelMessage): ToolModelMessage {
    if (entry.sender_type === "Agent" && entry.sender_name === this.agentName) {
      return { ...entry, role: "assistant" };
    }
    const sender = entry.sender_name;
    return { ...entry, role: "user", content: sender ? `[${sender}]: ${String(entry.content)}` : entry.content };
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

/**
 * What the agent said in the room this turn, as its own turns: every message it
 * posted through the send tool, then its final text. Without these the next
 * turn sees this turn's request as still unanswered.
 */
function answersOf(toolRounds: ToolRound[], text: string | undefined): ToolModelMessage[] {
  const sent = toolRounds.flatMap(({ toolCalls, toolResults }) =>
    toolCalls
      .filter((call) => call.name === SEND_MESSAGE_TOOL_NAME)
      .filter((call) => !toolResults.find((result) => result.toolCallId === call.id)?.isError)
      .map((call) => call.input.content),
  );
  return [...sent, text]
    .filter((content): content is string => typeof content === "string" && content.length > 0)
    .map((content) => ({ role: "assistant", content }));
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

import { SimpleAdapter } from "../../core/simpleAdapter";
import {
  isFailedToolOutput,
  type MessagingTools,
  type ToolExecutor,
  type ToolSchemaProvider,
} from "../../contracts/protocols";
import type { ToolModelMessage } from "../../contracts/dtos";
import { Deadline } from "../../core/deadline";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { formatHistoryForLlm } from "../../runtime/formatters";
import { withMemoryGuidance } from "../../runtime/prompts";
import { deliverFallbackReply, trackPostedReply } from "../../runtime/tools/postedReply";
import { asErrorMessage } from "../shared/coercion";
import { createRoomTurnLock } from "../shared/roomTurnLock";
import { assertTurnTimeoutMs } from "../shared/turnTimeout";
import {
  FAILURE_CODE_TIMEOUT,
  agentFailure,
  reportProviderTurnFailure,
  reportTurnFailure,
} from "../../core/providerFailure";
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

/** Caps a whole turn across its tool rounds, at its next model or tool call; matches the OpenCode adapter's cap. */
const DEFAULT_TURN_TIMEOUT_MS = 300_000;

class TurnTimedOutError extends Error {
  public constructor() {
    super("Tool-calling turn timed out");
    this.name = "TurnTimedOutError";
  }
}

/**
 * One turn's time budget, enforced from inside the turn. Racing the whole turn
 * from outside would free the room's turn lock while its tool loop kept
 * running, overlapping the next turn on the same conversation.
 */
class TurnBudget implements Disposable {
  private readonly deadline: Deadline;
  private readonly controller = new AbortController();
  private expired = false;

  public constructor(timeoutMs: number) {
    this.deadline = new Deadline(timeoutMs);
    // The flag goes up before the abort: a model that rejects the moment it is
    // aborted must still be classed as a timeout, not as its own abort error.
    void this.deadline.expired.then(() => {
      this.expired = true;
      this.controller.abort();
    });
  }

  public get hasExpired(): boolean {
    return this.expired;
  }

  public throwIfExpired(): void {
    if (this.expired) {
      throw new TurnTimedOutError();
    }
  }

  /** Runs `call` with the turn's abort signal, and stops waiting on it at the deadline even if it ignores the signal. */
  public async run<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.throwIfExpired();
    return Promise.race([
      call(this.controller.signal),
      this.deadline.expired.then((): never => {
        throw new TurnTimedOutError();
      }),
    ]);
  }

  public [Symbol.dispose](): void {
    this.deadline[Symbol.dispose]();
  }
}

export interface ToolCallingAdapterOptions {
  model: ToolCallingModel;
  toolFormat: "openai" | "anthropic";
  /** Passed through as `AgentFailure.provider` on a provider failure. Defaults to `DEFAULT_PROVIDER` when omitted. */
  provider?: string;
  systemPrompt?: string;
  includeMemoryTools?: boolean;
  maxToolRounds?: number;
  /**
   * Caps one whole turn across its tool rounds at this many milliseconds; `Infinity` removes the cap. Defaults to
   * five minutes. The turn ends at its next model call or tool call: a tool already running is not interrupted.
   */
  turnTimeoutMs?: number;
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
  private readonly turnTimeoutMs: number;
  private readonly enableExecutionReporting: boolean;
  private readonly customTools: CustomToolDef[];
  private readonly customToolIndex: Map<string, CustomToolDef>;
  private readonly logger: Logger;
  /** Each room's conversation, carried across turns; platform history seeds it only at session bootstrap. */
  private readonly conversations = new Map<string, ToolModelMessage[]>();
  private readonly roomTurns = createRoomTurnLock();

  public constructor(options: ToolCallingAdapterOptions) {
    super();
    this.model = options.model;
    this.toolFormat = options.toolFormat;
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.includeMemoryTools = options.includeMemoryTools ?? false;
    this.systemPrompt =
      options.systemPrompt === undefined && !this.includeMemoryTools
        ? undefined
        : withMemoryGuidance(options.systemPrompt ?? "", this.includeMemoryTools);
    this.maxToolRounds = options.maxToolRounds ?? 8;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    assertTurnTimeoutMs(this.turnTimeoutMs);
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
    await this.roomTurns.run(context.roomId, () => this.handleTurn(
      message,
      tools,
      history,
      participantsMessage,
      contactsMessage,
      context,
    ));
  }

  private async handleTurn(
    message: PlatformMessage,
    tools: ToolCallingTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    using turn = new TurnBudget(this.turnTimeoutMs);
    const conversation = this.conversationFor(context, history, message);
    conversation.push(this.userTurn(message));
    const toolRounds: ToolRound[] = [];
    // A later provider failure throws out of this turn. Remember a post as it lands, or the next turn answers it again.
    const reply = trackPostedReply(tools, (content) => conversation.push({ role: "assistant", content }));
    let text: string | undefined;
    try {
      const platformSchemas = tools.getToolSchemas(this.toolFormat, {
        includeMemory: this.includeMemoryTools,
      });
      const customSchemas = customToolsToSchemas(this.customTools, this.toolFormat);
      const schemas = [...platformSchemas, ...customSchemas];

      // Notices are for this turn only. The durable conversation keeps what was said in the room.
      const messages = [...conversation, ...this.turnNotices(participantsMessage, contactsMessage)];

      let response = await turn.run((signal) => this.model.complete({
        systemPrompt: this.systemPrompt,
        messages,
        tools: schemas,
      }, { signal }));

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
          // Before the call is reported, so no tool_call is left without its tool_result.
          turn.throwIfExpired();
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
              output = await reply.tools.executeToolCall(call.name, call.input);
            }
          }
          const isError = isFailedToolOutput(output);
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

        response = await turn.run((signal) => this.model.complete({
          systemPrompt: this.systemPrompt,
          messages,
          tools: schemas,
          toolRounds,
        }, { signal }));
      }

      text = response.text?.trim();
      if (!text && (response.toolCalls?.length ?? 0) === 0) {
        this.logger.warn("Model returned empty response with no tool calls", {
          messageId: message.id,
        });
      }
    } catch (error) {
      if (turn.hasExpired) {
        const timedOut = agentFailure(this.provider, `${this.provider} turn timed out.`, FAILURE_CODE_TIMEOUT);
        await reportTurnFailure(tools, timedOut, this.logger, { messageId: message.id });
      } else {
        await reportProviderTurnFailure(tools, this.logger, this.provider, "Tool-calling adapter request failed", error, { messageId: message.id });
      }
    }

    const mention = [{ id: message.senderId, handle: message.senderName ?? message.senderType }];
    // Only text that was actually delivered belongs in the next turn.
    if (await deliverFallbackReply(reply, text, mention)) {
      conversation.push({ role: "assistant", content: text });
    }
  }

  public override async onCleanup(roomId: string): Promise<void> {
    this.conversations.delete(roomId);
    this.roomTurns.release(roomId);
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

  private userTurn(message: PlatformMessage): ToolModelMessage {
    return this.asConversationTurn({
      role: "user",
      content: message.content,
      sender_name: message.senderName,
      sender_type: message.senderType,
      message_type: message.messageType,
      metadata: message.metadata,
    });
  }

  private turnNotices(
    participantsMessage: string | null,
    contactsMessage: string | null,
  ): ToolModelMessage[] {
    const notices: ToolModelMessage[] = [];
    if (participantsMessage) {
      notices.push({ role: "system", content: participantsMessage });
    }
    if (contactsMessage) {
      notices.push({ role: "system", content: contactsMessage });
    }
    return notices;
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

export function runSingleToolRound(
  model: ToolCallingModel,
  request: ToolCallingModelRequest,
): Promise<ToolCallingResponse> {
  return model.complete(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool round failed: ${message}`, { cause: error });
  });
}

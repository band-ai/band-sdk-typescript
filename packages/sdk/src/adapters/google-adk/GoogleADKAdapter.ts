import { randomUUID } from "node:crypto";

import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { MetadataMap, ToolOperationResult } from "../../contracts/dtos";
import { formatMessageForLlm } from "../../runtime/formatters";
import { renderSystemPrompt, withMemoryGuidance } from "../../runtime/prompts";
import { renderSystemPrompt, withMemoryGuidance } from "../../runtime/prompts";
import { deliverFallbackReply, trackPostedReply } from "../../runtime/tools/postedReply";
import { postedSendContent } from "../../runtime/tools/schemas";
import { postedSendContent } from "../../runtime/tools/schemas";
import type { PlatformMessage } from "../../runtime/types";
import {
  customToolToOpenAISchema,
  executeCustomTool,
  type CustomToolDef,
} from "../../runtime/tools/customTools";
import { asOptionalRecord } from "../shared/coercion";
import { reportProviderTurnFailure } from "../../core/providerFailure";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { PREVIOUS_CONTEXT_HEADER } from "../shared/conversationPrompt";
import { takeLast } from "../shared/history";
import { createRoomTurnLock } from "../shared/roomTurnLock";
import {
  GoogleADKHistoryConverter,
  type GoogleADKMessages,
} from "../../converters/google-adk";

const APP_NAME = "band";
const DEFAULT_MAX_HISTORY_MESSAGES = 50;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_TOOL_OUTPUT_PREVIEW = 200;

interface GoogleAdkFunctionCallLike {
  id?: string;
  name?: string;
  args?: unknown;
}

interface GoogleAdkFunctionResponseLike {
  id?: string;
  name?: string;
  response?: unknown;
}

interface GoogleAdkRunnerLike {
  sessionService: {
    createSession(params: {
      appName: string;
      userId: string;
      sessionId: string;
    }): Promise<unknown>;
  };
  runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: {
      role: "user";
      parts: Array<{ text: string }>;
    };
  }): AsyncIterable<unknown>;
}

interface GoogleAdkSdkLike {
  /** A Gemini model bound to an explicit API key. */
  createModel(params: { model: string; apiKey: string }): unknown;
  createAgent(params: {
    name: string;
    /** A model name, resolved by ADK with its own key lookup, or a `createModel` result. */
    model: unknown;
    instruction: string;
    tools: unknown[];
  }): unknown;
  createFunctionTool(params: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    execute(input: unknown): Promise<unknown>;
  }): unknown;
  createRunner(params: {
    agent: unknown;
    appName: string;
  }): GoogleAdkRunnerLike;
  isFinalResponse(event: unknown): boolean;
  getFunctionCalls(event: unknown): GoogleAdkFunctionCallLike[];
  getFunctionResponses(event: unknown): GoogleAdkFunctionResponseLike[];
  stringifyContent(event: unknown): string;
}

export interface GoogleADKAdapterOptions {
  model?: string;
  /** The Gemini API key. Unset, `@google/adk` reads `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY`. */
  apiKey?: string;
  systemPrompt?: string;
  customSection?: string;
  enableExecutionReporting?: boolean;
  enableMemoryTools?: boolean;
  historyConverter?: GoogleADKHistoryConverter;
  additionalTools?: CustomToolDef[];
  maxHistoryMessages?: number;
  maxTranscriptChars?: number;
  logger?: Logger;
  sdkFactory?: () => Promise<GoogleAdkSdkLike>;
}

function stripAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripAdditionalProperties(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "additionalProperties") {
      continue;
    }
    next[key] = stripAdditionalProperties(nestedValue);
  }
  return next;
}

function asToolArgs(value: unknown): Record<string, unknown> {
  return asOptionalRecord(value) ?? {};
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

async function loadGoogleAdkSdk(): Promise<GoogleAdkSdkLike> {
  let sdkModule: Record<string, unknown>;
  try {
    sdkModule = await import("@google/adk") as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      "Google ADK support requires the optional peer dependency `@google/adk`.",
      { cause: error },
    );
  }

  const LlmAgent = sdkModule.LlmAgent;
  const Gemini = sdkModule.Gemini;
  const FunctionTool = sdkModule.FunctionTool;
  const InMemoryRunner = sdkModule.InMemoryRunner;
  const isFinalResponse = sdkModule.isFinalResponse;
  const getFunctionCalls = sdkModule.getFunctionCalls;
  const getFunctionResponses = sdkModule.getFunctionResponses;
  const stringifyContent = sdkModule.stringifyContent;

  if (
    typeof LlmAgent !== "function"
    || typeof Gemini !== "function"
    || typeof FunctionTool !== "function"
    || typeof InMemoryRunner !== "function"
    || typeof isFinalResponse !== "function"
    || typeof getFunctionCalls !== "function"
    || typeof getFunctionResponses !== "function"
    || typeof stringifyContent !== "function"
  ) {
    throw new Error("Installed `@google/adk` package is missing required exports.");
  }

  return {
    createModel: (params) => new (Gemini as new (params: { model: string; apiKey: string }) => unknown)(params),
    createAgent: (params) => new (LlmAgent as new (params: Record<string, unknown>) => unknown)(params),
    createFunctionTool: (params) => new (
      FunctionTool as new (params: Record<string, unknown>) => unknown
    )(params),
    createRunner: (params) => new (
      InMemoryRunner as new (params: { agent: unknown; appName: string }) => GoogleAdkRunnerLike
    )(params),
    isFinalResponse: isFinalResponse as (event: unknown) => boolean,
    getFunctionCalls: getFunctionCalls as (event: unknown) => GoogleAdkFunctionCallLike[],
    getFunctionResponses: getFunctionResponses as (event: unknown) => GoogleAdkFunctionResponseLike[],
    stringifyContent: stringifyContent as (event: unknown) => string,
  };
}

export class GoogleADKAdapter extends SimpleAdapter<GoogleADKMessages, AdapterToolsProtocol> {
  protected readonly provider = "google-adk";

  private readonly model: string;
  private readonly apiKey?: string;
  private readonly systemPromptOverride?: string;
  private readonly customSection: string;
  private readonly enableExecutionReporting: boolean;
  private readonly enableMemoryTools: boolean;
  private readonly customTools: CustomToolDef[];
  private readonly maxHistoryMessages: number;
  private readonly maxTranscriptChars: number;
  private readonly logger: Logger;
  private readonly historyConverterInstance: GoogleADKHistoryConverter;
  private readonly sdkLoader: LazyAsyncValue<GoogleAdkSdkLike>;
  private readonly roomHistory = new Map<string, GoogleADKMessages>();
  private readonly roomSessions = new Map<string, string>();
  private readonly roomTurns = createRoomTurnLock();
  private systemPrompt = "";

  public constructor(options: GoogleADKAdapterOptions = {}) {
    const historyConverter = options.historyConverter ?? new GoogleADKHistoryConverter();
    super({ historyConverter });

    this.model = options.model ?? "gemini-2.5-flash";
    this.apiKey = options.apiKey;
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection ?? "";
    this.enableExecutionReporting = options.enableExecutionReporting ?? false;
    this.enableMemoryTools = options.enableMemoryTools ?? false;
    this.customTools = [...(options.additionalTools ?? [])];
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.maxTranscriptChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
    this.logger = resolveLogger(options.logger);
    this.historyConverterInstance = historyConverter;
    this.sdkLoader = new LazyAsyncValue({
      load: async () => (options.sdkFactory ? options.sdkFactory() : loadGoogleAdkSdk()),
      onRejected: (error) => {
        this.logger.warn("Google ADK initialization failed", { error });
      },
    });
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.historyConverterInstance.setAgentName(agentName);
    this.systemPrompt = withMemoryGuidance(
      this.systemPromptOverride ?? renderSystemPrompt({ agentName, agentDescription, customSection: this.customSection }),
      this.enableMemoryTools,
    );
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: GoogleADKMessages,
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
    tools: AdapterToolsProtocol,
    history: GoogleADKMessages,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (context.isSessionBootstrap) {
      this.roomHistory.set(context.roomId, [...history]);
    } else if (!this.roomHistory.has(context.roomId)) {
      this.roomHistory.set(context.roomId, []);
    }
    const roomHistory = this.roomHistory.get(context.roomId);
    if (!roomHistory) {
      return;
    }

    const prompt = this.buildPrompt(
      message,
      participantsMessage,
      contactsMessage,
      roomHistory,
    );

    let finalResponseText = "";
    const posted: string[] = [];
    const reply = trackPostedReply(tools, (content) => posted.push(content));
    try {
      const sdk = await this.sdkLoader.get();
      const runner = sdk.createRunner({
        agent: this.buildAgent(sdk, reply.tools),
        appName: APP_NAME,
      });
      const sessionId = randomUUID();
      this.roomSessions.set(context.roomId, sessionId);
      await runner.sessionService.createSession({
        appName: APP_NAME,
        userId: context.roomId,
        sessionId,
      });

      for await (const event of runner.runAsync({
        userId: context.roomId,
        sessionId,
        newMessage: {
          role: "user",
          parts: [{ text: prompt }],
        },
      })) {
        if (this.enableExecutionReporting) {
          await this.reportExecutionEvent(sdk, event, tools);
        }
        if (sdk.isFinalResponse(event)) {
          finalResponseText = sdk.stringifyContent(event);
        }
      }
    } catch (error) {
      this.rememberExchange(context.roomId, roomHistory, message, posted);
      await reportProviderTurnFailure(tools, this.logger, this.provider, "Google ADK adapter request failed", error, { roomId: context.roomId });
      return;
    }

    const stored = this.rememberExchange(context.roomId, roomHistory, message, posted);
    // Only text that was delivered belongs in the next turn.
    if (await deliverFallbackReply(reply, finalResponseText, [{ id: message.senderId }])) {
      this.rememberModelLine(context.roomId, stored, finalResponseText);
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.roomHistory.delete(roomId);
    this.roomSessions.delete(roomId);
    this.roomTurns.release(roomId);
  }

  /**
   * Append this turn's request and the sends that already landed.
   * Returns the array now stored for the room, or null when this turn's
   * history was replaced (the room was cleaned up, or a later session took it).
   */
  private rememberExchange(
    roomId: string,
    roomHistory: GoogleADKMessages,
    message: PlatformMessage,
    posted: readonly string[],
  ): GoogleADKMessages | null {
    if (this.roomHistory.get(roomId) !== roomHistory) {
      return null;
    }
    roomHistory.push({
      role: "user",
      content: this.formatIncomingMessage(message),
    });
    for (const content of posted) {
      roomHistory.push({ role: "model", content });
    }
    const trimmed = trimRoomHistory(roomHistory, this.maxHistoryMessages);
    this.roomHistory.set(roomId, trimmed);
    return trimmed;
  }

  private rememberModelLine(roomId: string, roomHistory: GoogleADKMessages | null, content: string): void {
    if (!roomHistory || this.roomHistory.get(roomId) !== roomHistory) {
      return;
    }
    roomHistory.push({ role: "model", content });
    this.roomHistory.set(roomId, trimRoomHistory(roomHistory, this.maxHistoryMessages));
  }

  private buildAgent(
    sdk: GoogleAdkSdkLike,
    tools: AdapterToolsProtocol,
  ): unknown {
    return sdk.createAgent({
      name: this.agentName || "band_agent",
      model: this.apiKey ? sdk.createModel({ model: this.model, apiKey: this.apiKey }) : this.model,
      instruction: this.systemPrompt,
      tools: this.buildTools(sdk, tools),
    });
  }

  private buildTools(
    sdk: GoogleAdkSdkLike,
    tools: AdapterToolsProtocol,
  ): unknown[] {
    const toolSchemas = tools.getOpenAIToolSchemas({
      includeMemory: this.enableMemoryTools,
    });
    const adkTools = toolSchemas
      .map((schema) => this.buildPlatformTool(sdk, tools, schema))
      .filter((tool): tool is unknown => tool !== null);

    for (const customTool of this.customTools) {
      adkTools.push(this.buildCustomTool(sdk, customTool));
    }

    return adkTools;
  }

  private buildPlatformTool(
    sdk: GoogleAdkSdkLike,
    tools: AdapterToolsProtocol,
    schema: Record<string, unknown>,
  ): unknown {
    const functionDef = asOptionalRecord(schema.function) ?? {};
    const name = functionDef?.name;
    if (typeof name !== "string" || name.length === 0) {
      return null;
    }

    return sdk.createFunctionTool({
      name,
      description: typeof functionDef.description === "string" ? functionDef.description : "",
      parameters: asOptionalRecord(stripAdditionalProperties(functionDef.parameters)) ?? undefined,
      execute: async (input) => {
        const args = asToolArgs(input);
        return stringifyToolResult(await tools.executeToolCall(name, args));
      },
    });
  }

  private buildCustomTool(
    sdk: GoogleAdkSdkLike,
    customTool: CustomToolDef,
  ): unknown {
    const schema = customToolToOpenAISchema(customTool);
    const functionDef = asOptionalRecord(schema.function) ?? {};
    return sdk.createFunctionTool({
      name: String(functionDef.name ?? customTool.name),
      description: typeof functionDef.description === "string" ? functionDef.description : "",
      parameters: asOptionalRecord(stripAdditionalProperties(functionDef.parameters)) ?? undefined,
      execute: async (input) => stringifyToolResult(await executeCustomTool(customTool, asToolArgs(input))),
    });
  }

  private buildPrompt(
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
    roomHistory: GoogleADKMessages,
  ): string {
    const parts: string[] = [];
    const transcript = formatHistoryTranscript(roomHistory, this.maxHistoryMessages, this.maxTranscriptChars);
    if (transcript.length > 0) {
      parts.push(PREVIOUS_CONTEXT_HEADER);
      parts.push(transcript);
      parts.push("[End of previous context]");
    }
    if (participantsMessage) {
      parts.push(`[System]: ${participantsMessage}`);
    }
    if (contactsMessage) {
      parts.push(`[System]: ${contactsMessage}`);
    }
    parts.push(this.formatIncomingMessage(message));
    return parts.join("\n\n");
  }

  private formatIncomingMessage(message: PlatformMessage): string {
    const formatted = formatMessageForLlm({
      content: message.content,
      sender_name: message.senderName,
      sender_type: message.senderType,
      message_type: message.messageType,
      metadata: message.metadata,
    });
    const formattedContent = String(formatted.content ?? "");
    return formatted.sender_name
      ? `[${formatted.sender_name}]: ${formattedContent}`
      : formattedContent;
  }

  private async reportExecutionEvent(
    sdk: GoogleAdkSdkLike,
    event: unknown,
    tools: AdapterToolsProtocol,
  ): Promise<void> {
    for (const functionCall of sdk.getFunctionCalls(event)) {
      const result = await tools.sendEvent(JSON.stringify({
        name: functionCall.name ?? "unknown",
        args: asToolArgs(functionCall.args),
        tool_call_id: functionCall.id ?? "",
      }), "tool_call");
      this.warnOnFailedSend(result, "Google ADK tool_call event send failed", { toolCallId: functionCall.id ?? "" });
    }

    for (const functionResponse of sdk.getFunctionResponses(event)) {
      const result = await tools.sendEvent(JSON.stringify({
        name: functionResponse.name ?? "unknown",
        output: String(functionResponse.response ?? ""),
        tool_call_id: functionResponse.id ?? "",
      }), "tool_result");
      this.warnOnFailedSend(result, "Google ADK tool_result event send failed", { toolCallId: functionResponse.id ?? "" });
    }
  }

  private warnOnFailedSend(result: ToolOperationResult, message: string, meta: MetadataMap): void {
    if (result.ok === false) {
      this.logger.warn(message, meta);
    }
  }
}

function formatHistoryTranscript(
  history: GoogleADKMessages,
  maxHistoryMessages: number,
  maxTranscriptChars: number,
): string {
  const windowedHistory = takeLast(history, maxHistoryMessages);
  const lines: string[] = [];

  for (const message of windowedHistory) {
    if (typeof message.content === "string") {
      lines.push(message.content);
      continue;
    }

    for (const block of message.content) {
      const blockType = String(block.type ?? "");
      if (blockType === "function_call") {
        lines.push(
          `[Tool Call] ${String(block.name ?? "unknown")} (${JSON.stringify(block.args ?? {})})`,
        );
        continue;
      }

      if (blockType === "function_response") {
        const output = String(block.output ?? "");
        const preview = output.length > MAX_TOOL_OUTPUT_PREVIEW
          ? `${output.slice(0, MAX_TOOL_OUTPUT_PREVIEW)}...`
          : output;
        lines.push(`[Tool Result] ${String(block.name ?? "unknown")}: ${preview}`);
      }
    }
  }

  let transcript = lines.join("\n");
  if (transcript.length <= maxTranscriptChars) {
    return transcript;
  }

  transcript = transcript.slice(-maxTranscriptChars);
  const firstNewline = transcript.indexOf("\n");
  return firstNewline >= 0 ? transcript.slice(firstNewline + 1) : transcript;
}

function trimRoomHistory(
  history: GoogleADKMessages,
  maxHistoryMessages: number,
): GoogleADKMessages {
  const maxEntries = maxHistoryMessages * 2;
  return history.length > maxEntries ? takeLast(history, maxHistoryMessages) : history;
}

import { randomUUID } from "node:crypto";

import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { formatMessageForLlm } from "../../runtime/formatters";
import { renderSystemPrompt } from "../../runtime/prompts";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import {
  customToolToOpenAISchema,
  executeCustomTool,
  type CustomToolDef,
} from "../../runtime/tools/customTools";
import { asErrorMessage, asOptionalRecord } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import {
  GoogleADKHistoryConverter,
  type GoogleADKMessages,
} from "../../converters/google-adk";

const APP_NAME = "thenvoi";
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
  createAgent(params: {
    name: string;
    model: string;
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
  const FunctionTool = sdkModule.FunctionTool;
  const InMemoryRunner = sdkModule.InMemoryRunner;
  const isFinalResponse = sdkModule.isFinalResponse;
  const getFunctionCalls = sdkModule.getFunctionCalls;
  const getFunctionResponses = sdkModule.getFunctionResponses;
  const stringifyContent = sdkModule.stringifyContent;

  if (
    typeof LlmAgent !== "function"
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
  private readonly model: string;
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
  private systemPrompt = "";

  public constructor(options: GoogleADKAdapterOptions = {}) {
    const historyConverter = options.historyConverter ?? new GoogleADKHistoryConverter();
    super({ historyConverter });

    this.model = options.model ?? "gemini-2.5-flash";
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection ?? "";
    this.enableExecutionReporting = options.enableExecutionReporting ?? false;
    this.enableMemoryTools = options.enableMemoryTools ?? false;
    this.customTools = [...(options.additionalTools ?? [])];
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.maxTranscriptChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
    this.logger = options.logger ?? new NoopLogger();
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
    this.systemPrompt =
      this.systemPromptOverride
      ?? renderSystemPrompt({
        agentName,
        agentDescription,
        customSection: this.customSection,
      });
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: GoogleADKMessages,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const sdk = await this.sdkLoader.get();
    if (context.isSessionBootstrap) {
      this.roomHistory.set(context.roomId, [...history]);
    } else if (!this.roomHistory.has(context.roomId)) {
      this.roomHistory.set(context.roomId, []);
    }

    const runner = sdk.createRunner({
      agent: this.buildAgent(sdk, tools),
      appName: APP_NAME,
    });
    const sessionId = randomUUID();
    this.roomSessions.set(context.roomId, sessionId);
    await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: context.roomId,
      sessionId,
    });

    const prompt = this.buildPrompt(
      message,
      participantsMessage,
      contactsMessage,
      this.roomHistory.get(context.roomId) ?? [],
    );

    let finalResponseText = "";
    try {
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
      const messageText = asErrorMessage(error);
      this.logger.error("Google ADK adapter request failed", {
        error,
        roomId: context.roomId,
      });
      await tools.sendEvent(`Google ADK adapter error: ${messageText}`, "error");
      throw error instanceof Error ? error : new Error(messageText);
    }

    const nextHistory = this.roomHistory.get(context.roomId) ?? [];
    nextHistory.push({
      role: "user",
      content: this.formatIncomingMessage(message),
    });
    if (finalResponseText.length > 0) {
      nextHistory.push({
        role: "model",
        content: finalResponseText,
      });
      await tools.sendMessage(finalResponseText, [{ id: message.senderId }]);
    }
    this.roomHistory.set(context.roomId, trimRoomHistory(nextHistory, this.maxHistoryMessages));
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.roomHistory.delete(roomId);
    this.roomSessions.delete(roomId);
  }

  private buildAgent(
    sdk: GoogleAdkSdkLike,
    tools: AdapterToolsProtocol,
  ): unknown {
    return sdk.createAgent({
      name: this.agentName || "thenvoi_agent",
      model: this.model,
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
      execute: async (input) => stringifyToolResult(await tools.executeToolCall(name, asToolArgs(input))),
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
      parts.push("[Previous conversation context]");
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
      await tools.sendEvent(JSON.stringify({
        name: functionCall.name ?? "unknown",
        args: asToolArgs(functionCall.args),
        tool_call_id: functionCall.id ?? "",
      }), "tool_call");
    }

    for (const functionResponse of sdk.getFunctionResponses(event)) {
      await tools.sendEvent(JSON.stringify({
        name: functionResponse.name ?? "unknown",
        output: String(functionResponse.response ?? ""),
        tool_call_id: functionResponse.id ?? "",
      }), "tool_result");
    }
  }
}

function formatHistoryTranscript(
  history: GoogleADKMessages,
  maxHistoryMessages: number,
  maxTranscriptChars: number,
): string {
  const windowedHistory = history.slice(-maxHistoryMessages);
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
  return history.length > maxEntries ? history.slice(-maxHistoryMessages) : history;
}

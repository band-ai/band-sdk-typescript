import { RuntimeStateError, UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { isFailedToolOutput, type AdapterToolsProtocol } from "../../contracts/protocols";
import { parseToolPayload } from "../../converters/shared";
import { renderSystemPrompt, withMemoryGuidance } from "../../runtime/prompts";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { asErrorMessage, asOptionalRecord, asRecord } from "../shared/coercion";
import { reportProviderTurnFailure } from "../../core/providerFailure";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { takeLast } from "../shared/history";
import { RoundOutcome } from "../shared/toolRounds";
import { relayReply, type TurnTools } from "../../core/turn";
import { withNativeActivity, type NativeActivity } from "../../runtime/workingState";

import {
  buildCustomToolIndex,
  assertCustomToolNamesAvailable,
  customToolToOpenAISchema,
  executeCustomTool,
  type CustomToolDef,
} from "../../runtime/tools/customTools";

type LangGraphRole = "system" | "user" | "assistant";
type LangGraphTupleMessage = [LangGraphRole, string];

/** The Python SDK's default for the same option. */
const DEFAULT_RECURSION_LIMIT = 50;

export interface LangGraphGraph {
  invoke?(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>;
  streamEvents?(
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AsyncIterable<unknown>;
}

interface LangGraphToolLike {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** The part of LangGraph's prebuilt ToolNode the adapter overrides. */
interface LangGraphToolNode {
  runTool(call: unknown, config: unknown): Promise<unknown>;
}

interface LangGraphSdk {
  createReactAgent: (params: {
    llm: unknown;
    tools: LangGraphToolNode;
    checkpointer?: unknown;
    prompt?: string;
    preModelHook?: () => Record<string, never>;
  }) => LangGraphGraph;
  GraphInterrupt: new () => Error;
  GraphRecursionError: abstract new (...args: never[]) => Error;
  ToolNode: new (tools: unknown[]) => LangGraphToolNode;
  tool: (
    fn: (input: Record<string, unknown>) => Promise<string>,
    fields: {
      name: string;
      description: string;
      schema: Record<string, unknown>;
    },
  ) => unknown;
}

export interface LangGraphAdapterOptions {
  llm?: unknown;
  checkpointer?: unknown;
  graph?: LangGraphGraph;
  graphFactory?: (tools: unknown[]) => LangGraphGraph | Promise<LangGraphGraph>;
  additionalTools?: unknown[];
  customTools?: CustomToolDef[];
  systemPrompt?: string;
  customSection?: string;
  /**
   * LangGraph steps one turn may run; the built-in graph takes three per tool
   * round and has a default. A `graph` or `graphFactory` graph gets it only
   * when set, so its own `withConfig({ recursionLimit })` otherwise holds.
   */
  recursionLimit?: number;
  maxHistoryMessages?: number;
  emitExecutionEvents?: boolean;
  includeMemoryTools?: boolean;
  logger?: Logger;
}

export class LangGraphAdapter extends SimpleAdapter<HistoryProvider, TurnTools> {
  protected readonly provider = "langgraph";

  private readonly llm?: unknown;
  private readonly checkpointer?: unknown;
  private readonly graph?: LangGraphGraph;
  private readonly graphFactory?: (tools: unknown[]) => LangGraphGraph | Promise<LangGraphGraph>;
  private readonly additionalTools: unknown[];
  private readonly customTools: CustomToolDef[];
  private readonly systemPromptOverride?: string;
  private readonly customSection: string;
  private readonly recursionLimit: number | undefined;
  private readonly maxHistoryMessages: number;
  private readonly emitExecutionEvents: boolean;
  private readonly includeMemoryTools: boolean;
  private readonly logger: Logger;
  private readonly sdkLoader: LazyAsyncValue<LangGraphSdk>;
  private renderedSystemPrompt = "";
  private readonly bootstrappedRooms = new Set<string>();

  public constructor(options: LangGraphAdapterOptions) {
    super();

    if (!options.graph && !options.graphFactory && options.llm === undefined) {
      throw new ValidationError("LangGraphAdapter requires `llm`, `graph`, or `graphFactory`.");
    }

    this.llm = options.llm;
    this.checkpointer = options.checkpointer;
    this.graph = options.graph;
    this.graphFactory = options.graphFactory;
    this.additionalTools = options.additionalTools ?? [];
    this.customTools = [...buildCustomToolIndex(options.customTools ?? []).values()];
    if (this.customTools.length > 0 && !this.usesBandTools) {
      throw new ValidationError("LangGraph customTools require `llm` or `graphFactory` to receive the tools.");
    }
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection ?? "";
    this.recursionLimit = options.recursionLimit ?? (this.usesCustomGraph ? undefined : DEFAULT_RECURSION_LIMIT);
    this.maxHistoryMessages = options.maxHistoryMessages ?? 100;
    this.emitExecutionEvents = options.emitExecutionEvents ?? true;
    this.includeMemoryTools = options.includeMemoryTools ?? false;
    this.logger = resolveLogger(options.logger);
    this.sdkLoader = new LazyAsyncValue({
      load: async () => loadLangGraphSdk(),
      onRejected: (error: unknown) => {
        this.logger.warn("LangGraph SDK initialization failed", { error });
      },
    });
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.renderedSystemPrompt = withMemoryGuidance(
      this.systemPromptOverride ?? renderSystemPrompt({ agentName, agentDescription, customSection: this.customSection }),
      this.includeMemoryTools,
    );
  }

  public async onMessage(
    message: PlatformMessage,
    tools: TurnTools,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    let text: string | null = null;
    // LangGraph's recursionLimit caps the rounds.
    const round = new RoundOutcome(tools.turn);
    let sdk: LangGraphSdk | undefined;
    try {
      let langGraphTools = [...this.additionalTools];
      let observedNames = new Set<string>();
      if (this.usesBandTools) {
        sdk = await this.sdkLoader.get();
        const built = buildLangGraphTools({
          sdk,
          tools,
          round,
          includeMemoryTools: this.includeMemoryTools,
          logger: this.logger,
          customTools: this.customTools,
          additionalTools: this.additionalTools,
        });
        langGraphTools = built.tools;
        observedNames = built.observedNames;
      }

      const graph = await this.resolveGraph(sdk, langGraphTools, round);

      const usesCheckpointer = Boolean(this.checkpointer);

      // First bootstrap for a room (not a later reconnect of the same room).
      const isFirstBootstrap =
        context.isSessionBootstrap && !this.bootstrappedRooms.has(context.roomId);

      // Stateless graphs replay history every turn; with a checkpointer, seed once on first bootstrap
      // and rely on persisted state after. The guard is in-memory, so a durable checkpointer reused
      // across restarts may re-seed once.
      const replayHistory = !usesCheckpointer || isFirstBootstrap;

      // createReactAgent gets the prompt via `prompt`; only custom graphs need it as a message —
      // every turn when stateless, once per room when checkpointed (same signal as replay).
      const includeSystemPrompt = this.usesCustomGraph && (!usesCheckpointer || isFirstBootstrap);

      if (context.isSessionBootstrap) {
        this.bootstrappedRooms.add(context.roomId);
      }

      const messages = this.buildMessages(history, message, participantsMessage, contactsMessage, {
        replayHistory,
        includeSystemPrompt,
      });
      const input = { messages };
      const graphConfig = {
        configurable: {
          thread_id: context.roomId,
        },
        // Omitted, not undefined: LangGraph's streamEvents lets an undefined key replace a graph's own limit.
        ...(this.recursionLimit === undefined ? {} : { recursionLimit: this.recursionLimit }),
      };

      if (this.emitExecutionEvents && graph.streamEvents) {
        text = await withNativeActivity(tools, observedNames, (native) => this.forwardStreamEvents(graph, input, graphConfig, tools, native));
      } else if (graph.invoke) {
        const invoke = graph.invoke.bind(graph);
        const result = await withNativeActivity(tools, observedNames, (native) => invoke(input, { ...graphConfig, callbacks: [toolActivityCallbacks(native)] }));
        text = extractAssistantText(result);
      } else {
        return;
      }
    } catch (error) {
      // Ending a declined run takes one more step; a limit that refuses it leaves the turn declined, not failed.
      if (!this.usesCustomGraph && round.declined && sdk !== undefined && error instanceof sdk.GraphRecursionError) {
        this.logger.debug("LangGraph decline ended at the recursion limit", { roomId: context.roomId, recursionLimit: this.recursionLimit });
      } else {
        await reportProviderTurnFailure(tools, this.logger, this.provider, "LangGraph adapter request failed", error, { roomId: context.roomId });
      }
    }

    await relayReply(tools, text, [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.bootstrappedRooms.delete(roomId);
  }

  /** The built-in createReactAgent or a `graphFactory` graph gets Band tools; a static `graph` has none to answer with. */
  private get usesBandTools(): boolean {
    return this.graph === undefined || this.graphFactory !== undefined;
  }

  protected override get judgesTurns(): boolean {
    return this.usesBandTools;
  }

  /** A caller-supplied graph rather than the built-in createReactAgent. */
  private get usesCustomGraph(): boolean {
    return Boolean(this.graph || this.graphFactory);
  }

  private resolveGraph(
    sdk: LangGraphSdk | undefined,
    langGraphTools: unknown[],
    round: RoundOutcome,
  ): Promise<LangGraphGraph> {
    if (this.graphFactory) {
      return Promise.resolve(this.graphFactory(langGraphTools));
    }

    if (this.graph) {
      return Promise.resolve(this.graph);
    }

    if (this.llm === undefined) {
      throw new ValidationError("LangGraphAdapter is missing an `llm` instance.");
    }
    if (!sdk) {
      throw new RuntimeStateError("LangGraphAdapter SDK failed to initialize.");
    }
    const { GraphInterrupt } = sdk;

    return Promise.resolve(sdk.createReactAgent({
      llm: this.llm,
      tools: roundToolNode(sdk, langGraphTools, round),
      checkpointer: this.checkpointer,
      prompt: this.renderedSystemPrompt,
      // The graph's only way on from a tools round is the model, so the round rule ends the run here.
      // An empty interrupt, like a static interruptAfter, ends it cleanly: streams complete and nothing is reported as failed.
      preModelHook: () => {
        if (round.declined) {
          throw new GraphInterrupt();
        }
        round.start();
        return {};
      },
    }));
  }

  private buildMessages(
    history: HistoryProvider,
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
    options: { replayHistory: boolean; includeSystemPrompt: boolean },
  ): LangGraphTupleMessage[] {
    const messages: LangGraphTupleMessage[] = [];

    if (options.includeSystemPrompt) {
      messages.push(["system", this.renderedSystemPrompt]);
    }

    if (options.replayHistory && history.length > 0) {
      // Drop the triggering message before truncating so the limit counts only prior turns;
      // the current message is appended exactly once, last.
      const historical = takeLast(
        history.raw.filter((item) => item.id !== message.id),
        this.maxHistoryMessages,
      );
      for (const item of historical) {
        const role = String(item.sender_type ?? "") === "Agent" ? "assistant" : "user";
        const content = String(item.content ?? "");
        if (content) {
          messages.push([role, content]);
        }
      }
    }

    if (participantsMessage) {
      messages.push(["user", `[System]: ${participantsMessage}`]);
    }

    if (contactsMessage) {
      messages.push(["user", `[System]: ${contactsMessage}`]);
    }

    // The current turn always appears exactly once, as the last message.
    messages.push(["user", message.content]);
    return messages;
  }

  private async forwardStreamEvents(
    graph: LangGraphGraph,
    input: Record<string, unknown>,
    config: Record<string, unknown>,
    tools: AdapterToolsProtocol,
    native: NativeActivity,
  ): Promise<string | null> {
    // version belongs on config (arg 2), not the optional third arg.
    const stream = graph.streamEvents?.(input, { ...config, version: "v2" });
    if (!stream) {
      return null;
    }

    let lastAssistantText: string | null = null;

    for await (const event of stream) {
      const data = asOptionalRecord(event) ?? {};
      const eventType = String(data.event ?? "");
      const details = asOptionalRecord(data.data) ?? {};
      const runId = typeof data.run_id === "string" ? data.run_id : "";
      if (eventType === "on_tool_start") native.tool(runId, typeof data.name === "string" ? data.name : "");
      if (eventType === "on_tool_end" || eventType === "on_tool_error") native.end(runId);
      if (eventType === "on_tool_start") {
        // The run ID pairs both events; the model's call ID arrives only at tool end.
        await tools.sendEvent(
          stringifyJsonWithFallback({
            ...data,
            tool_call_id: data.run_id,
            args: streamToolArgs(details.input),
          }, this.logger, {
            label: "LangGraph event",
            eventType,
          }),
          "tool_call",
        );
      }
      if (eventType === "on_tool_end") {
        const message = asOptionalRecord(details.output);
        const output = typeof message?.tool_call_id === "string" ? message.content : details.output;
        const parsedOutput = typeof output === "string" ? parseToolPayload(output) ?? output : output;
        await tools.sendEvent(
          stringifyJsonWithFallback({
            ...data,
            tool_call_id: data.run_id,
            output,
            is_error: isErrorToolMessage(message) || isFailedToolOutput(parsedOutput),
          }, this.logger, {
            label: "LangGraph event",
            eventType,
          }),
          "tool_result",
        );
      }
      if (eventType === "on_chain_end") {
        const chainName = String(data.name ?? "");
        // For the built-in createReactAgent path, ignore intermediate chains that emit routing
        // markers rather than replies. Custom graphs use arbitrary chain names, so don't filter them.
        if (!this.usesCustomGraph && chainName !== "LangGraph" && chainName !== "agent") {
          continue;
        }
        const output = asOptionalRecord(data.data) ?? {};
        const text = extractAssistantText(output.output);
        if (text) {
          lastAssistantText = text;
        }
      }
    }

    return lastAssistantText;
  }
}

/** A LangChain callback handler that reports the tools a graph runs natively; it is awaited so no report trails `invoke`. */
function toolActivityCallbacks(native: NativeActivity) {
  return {
    awaitHandlers: true,
    handleToolStart: (_tool: unknown, _input: string, runId: string, _parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string): void => native.tool(runId, runName ?? ""),
    handleToolEnd: (_output: unknown, runId: string): void => native.end(runId),
    handleToolError: (_error: unknown, runId: string): void => native.end(runId),
  };
}

function streamToolArgs(input: unknown): Record<string, unknown> {
  const args = asOptionalRecord(input) ?? {};
  // LangChain wraps JSON-schema tool arguments in a single JSON string field.
  return Object.keys(args).length === 1 && typeof args.input === "string"
    ? parseToolPayload(args.input) ?? args
    : args;
}

function buildLangGraphTools(input: {
  sdk: LangGraphSdk;
  tools: TurnTools;
  round: RoundOutcome;
  customTools: CustomToolDef[];
  additionalTools: unknown[];
  includeMemoryTools: boolean;
  logger: Logger;
}): { tools: unknown[]; observedNames: Set<string> } {
  const schemas = input.tools.getToolSchemas("openai", {
    includeMemory: input.includeMemoryTools,
  });
  const specs = schemas.flatMap((schema) => {
    const spec = toLangGraphToolSpec(schema);
    return spec ? [spec] : [];
  });
  const portable = input.customTools.map((def) => ({ def, spec: toLangGraphToolSpec(customToolToOpenAISchema(def))! }));
  if (portable.length > 0) {
    assertCustomToolNamesAvailable(portable.map(({ spec }) => spec.name), [
      ...specs.map((spec) => spec.name),
      ...input.additionalTools.map((tool) => asOptionalRecord(tool)?.name),
    ]);
  }
  const wrap = (spec: LangGraphToolLike, execute: (args: Record<string, unknown>) => Promise<unknown>) =>
    input.sdk.tool(async (args) => {
      const output = await execute(args);
      input.round.record(output);
      return stringifyToolResult(output, input.logger, spec.name);
    }, spec);

  return {
    tools: [
      ...specs.map((spec) => wrap(spec, (args) => input.tools.executeToolCall(spec.name, args))),
      ...portable.map(({ def, spec }) => wrap(spec, (args) => executeCustomTool(def, args, input.tools.turn, input.tools))),
      ...input.additionalTools,
    ],
    observedNames: new Set([...specs, ...portable.map(({ spec }) => spec)].map(({ name }) => name)),
  };
}

function toLangGraphToolSpec(schema: Record<string, unknown>): LangGraphToolLike | null {
  const functionBlock = asRecord(schema.function);
  const name = functionBlock.name;
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }

  const description = typeof functionBlock.description === "string" ? functionBlock.description : "";
  const parameters = asRecord(functionBlock.parameters);

  return {
    name,
    description,
    schema: parameters,
  };
}

function stringifyToolResult(
  value: unknown,
  logger: Logger,
  toolName: string,
): string {
  if (typeof value === "string") {
    return value;
  }

  return stringifyJsonWithFallback(value, logger, {
    label: "LangGraph tool result",
    toolName,
    fallback: String(value),
  });
}

function extractAssistantText(result: unknown): string | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    // createReactAgent streams "__end__"/"__start__" markers as plain strings.
    return trimmed.length > 0 && !isInternalLangGraphMarker(trimmed) ? trimmed : null;
  }

  const record = asOptionalRecord(result) ?? {};
  // createReactAgent returns LangChain AIMessage objects, not tuples.
  if (isLangChainAssistantMessage(record)) {
    const text = asLangChainMessageContent(record);
    if (text && !isInternalLangGraphMarker(text)) {
      return text;
    }
  }

  const directContent = asMessageContent(record.content);
  if (directContent && !isInternalLangGraphMarker(directContent)) {
    return directContent;
  }

  const messages = Array.isArray(record.messages) ? record.messages : [];
  // Messages before this turn's input are earlier turns: their text is not this turn's answer.
  for (let index = messages.length - 1; index >= 0 && !isHumanMessage(messages[index]); index -= 1) {
    const text = asMessageText(messages[index]);
    if (text && !isInternalLangGraphMarker(text)) {
      return text;
    }
  }

  return null;
}

function asMessageText(value: unknown): string | null {
  if (Array.isArray(value) && value.length >= 2 && value[0] === "assistant") {
    if (typeof value[1] === "string" && value[1].trim().length > 0) {
      return value[1].trim();
    }
    return null;
  }

  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }

  if (isLangChainAssistantMessage(record)) {
    return asLangChainMessageContent(record);
  }

  const role = String(record.role ?? "");
  if (role !== "assistant") {
    return null;
  }

  return asMessageContent(record.content);
}

const LANGCHAIN_MESSAGE_TYPES = ["ai", "human"] as const;
type LangChainMessageType = (typeof LANGCHAIN_MESSAGE_TYPES)[number];

function isLangChainMessageType(value: unknown): value is LangChainMessageType {
  return LANGCHAIN_MESSAGE_TYPES.includes(value as LangChainMessageType);
}

/** LangChain's serialized class names, by the type `getType()` reports for an instance. */
const LANGCHAIN_MESSAGE_CLASSES: Readonly<Record<string, LangChainMessageType>> = {
  AIMessage: "ai",
  AIMessageChunk: "ai",
  HumanMessage: "human",
  HumanMessageChunk: "human",
};

// A LangChain message's type in either shape:
//  - serialized: { id: [..., "AIMessage" | "HumanMessage" | …], kwargs: { content } }
//  - in-memory instance (real createReactAgent stream): getType(), content on the instance
function langChainMessageType(record: Record<string, unknown>): LangChainMessageType | null {
  const id = record.id;
  if (Array.isArray(id)) {
    const type = LANGCHAIN_MESSAGE_CLASSES[String(id[id.length - 1] ?? "")];
    if (type) {
      return type;
    }
  }

  const getType = (record as { getType?: unknown }).getType;
  if (typeof getType === "function") {
    try {
      const type = (getType as () => unknown).call(record);
      return isLangChainMessageType(type) ? type : null;
    } catch {
      return null;
    }
  }

  return null;
}

function isLangChainAssistantMessage(record: Record<string, unknown>): boolean {
  return langChainMessageType(record) === "ai";
}

/** ToolNode's report of a call that failed: it threw, named no tool, or had invalid arguments. */
function isErrorToolMessage(value: unknown): boolean {
  return asOptionalRecord(value)?.status === "error";
}

function isMessagesWrite(write: unknown): write is ["messages", unknown] {
  return Array.isArray(write) && write[0] === "messages";
}

/** The messages a Command's update writes, in either form LangGraph applies: a record or `[channel, value]` tuples. */
function commandUpdateMessages(update: unknown): unknown[] {
  if (Array.isArray(update)) {
    return update.filter(isMessagesWrite).flatMap(([, messages]) => messages);
  }
  return [asOptionalRecord(update)?.messages].flat();
}

/** A tools-step output carrying an error ToolMessage, returned directly or in a Command's update. */
function hasErrorToolMessage(output: unknown): boolean {
  return isErrorToolMessage(output) || commandUpdateMessages(asOptionalRecord(output)?.update).some(isErrorToolMessage);
}

/**
 * The built-in graph's tools step, counting each call ToolNode reports as
 * failed toward the round; a Band or custom tool's failed output is recorded
 * by its own wrapper, since ToolNode reports it as a success.
 */
function roundToolNode(sdk: LangGraphSdk, tools: unknown[], round: RoundOutcome): LangGraphToolNode {
  class RoundToolNode extends sdk.ToolNode {
    public override async runTool(call: unknown, config: unknown): Promise<unknown> {
      const output = await super.runTool(call, config);
      if (hasErrorToolMessage(output)) {
        round.fail();
      }
      return output;
    }
  }
  return new RoundToolNode(tools);
}

/** The roles LangChain reads as a human message, in a tuple or a role record. */
const HUMAN_ROLES: ReadonlySet<unknown> = new Set(["user", "human"]);

/** A human message, in any shape a graph's state holds it: a tuple, a role record, or a LangChain message. */
function isHumanMessage(value: unknown): boolean {
  if (Array.isArray(value)) {
    return HUMAN_ROLES.has(value[0]);
  }
  const record = asOptionalRecord(value);
  if (!record) {
    return false;
  }
  return langChainMessageType(record) === "human" || HUMAN_ROLES.has(record.role);
}

// Serialized messages carry text under kwargs.content; instances expose it directly.
function asLangChainMessageContent(record: Record<string, unknown>): string | null {
  const kwargs = asOptionalRecord(record.kwargs);
  return asMessageContent(kwargs?.content ?? record.content);
}

function isInternalLangGraphMarker(text: string): boolean {
  return text === "__end__" || text === "__start__";
}

function asMessageContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      const record = asOptionalRecord(item);
      if (!record) {
        continue;
      }
      if (typeof record.text === "string" && record.text.trim().length > 0) {
        chunks.push(record.text.trim());
      }
    }

    if (chunks.length > 0) {
      return chunks.join("\n");
    }
  }

  return null;
}

async function loadLangGraphSdk(): Promise<LangGraphSdk> {
  try {
    const [langGraphModule, prebuiltModule, coreToolsModule] = await Promise.all([
      import("@langchain/langgraph").then((module) => module as Pick<LangGraphSdk, "GraphInterrupt" | "GraphRecursionError">),
      import("@langchain/langgraph/prebuilt").then((module) => module as Pick<LangGraphSdk, "createReactAgent" | "ToolNode">),
      import("@langchain/core/tools").then((module) => module as { tool: LangGraphSdk["tool"] }),
    ]);
    const { GraphInterrupt, GraphRecursionError } = langGraphModule;
    const { createReactAgent, ToolNode } = prebuiltModule;
    const { tool } = coreToolsModule;

    if ([GraphInterrupt, GraphRecursionError, createReactAgent, ToolNode, tool].some((value) => typeof value !== "function")) {
      throw new UnsupportedFeatureError("LangGraph SDK exports are unavailable.");
    }

    return { GraphInterrupt, GraphRecursionError, ToolNode, createReactAgent, tool };
  } catch (error) {
    throw new UnsupportedFeatureError(
      `LangGraphAdapter requires @langchain/langgraph and @langchain/core. Install them with "pnpm add @langchain/langgraph @langchain/core". (${asErrorMessage(error)})`,
    );
  }
}

function stringifyJsonWithFallback(
  value: unknown,
  logger: Logger,
  context: {
    label: string;
    eventType?: string;
    toolName?: string;
    fallback?: string;
  },
): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logger.warn(`${context.label} serialization fell back to a safe value`, {
      eventType: context.eventType,
      toolName: context.toolName,
      error,
    });

    if (context.fallback !== undefined) {
      return context.fallback;
    }

    return JSON.stringify({
      event: context.eventType ?? null,
      serialization_error: asErrorMessage(error),
    });
  }
}

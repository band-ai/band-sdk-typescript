import { RuntimeStateError, UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { renderSystemPrompt } from "../../runtime/prompts";
import type { HistoryProvider, PlatformMessage } from "../../runtime/types";
import { asErrorMessage, asOptionalRecord, asRecord } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";

type LangGraphRole = "system" | "user" | "assistant";
type LangGraphTupleMessage = [LangGraphRole, string];

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

interface LangGraphSdk {
  createReactAgent: (params: {
    llm: unknown;
    tools: unknown[];
    checkpointer?: unknown;
    prompt?: string;
  }) => LangGraphGraph;
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
  systemPrompt?: string;
  customSection?: string;
  recursionLimit?: number;
  maxHistoryMessages?: number;
  emitExecutionEvents?: boolean;
  includeMemoryTools?: boolean;
  logger?: Logger;
}

export class LangGraphAdapter extends SimpleAdapter<HistoryProvider, AdapterToolsProtocol> {
  private readonly llm?: unknown;
  private readonly checkpointer?: unknown;
  private readonly graph?: LangGraphGraph;
  private readonly graphFactory?: (tools: unknown[]) => LangGraphGraph | Promise<LangGraphGraph>;
  private readonly additionalTools: unknown[];
  private readonly systemPromptOverride?: string;
  private readonly customSection: string;
  private readonly recursionLimit: number;
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
    this.systemPromptOverride = options.systemPrompt;
    this.customSection = options.customSection ?? "";
    this.recursionLimit = options.recursionLimit ?? 50;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 100;
    this.emitExecutionEvents = options.emitExecutionEvents ?? true;
    this.includeMemoryTools = options.includeMemoryTools ?? false;
    this.logger = options.logger ?? new NoopLogger();
    this.sdkLoader = new LazyAsyncValue({
      load: async () => loadLangGraphSdk(),
      onRejected: (error: unknown) => {
        this.logger.warn("LangGraph SDK initialization failed", { error });
      },
    });
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.renderedSystemPrompt =
      this.systemPromptOverride ??
      renderSystemPrompt({
        agentName,
        agentDescription,
        customSection: this.customSection,
        capabilities: { memory: this.includeMemoryTools },
      });
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    let sdk: LangGraphSdk | undefined;
    let langGraphTools = [...this.additionalTools];
    if (!this.graph || this.graphFactory) {
      sdk = await this.sdkLoader.get();
      langGraphTools = [
        ...buildLangGraphTools({
          sdk,
          tools,
          includeMemoryTools: this.includeMemoryTools,
          logger: this.logger,
        }),
        ...this.additionalTools,
      ];
    }

    const graph = await this.resolveGraph(sdk, langGraphTools);

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
      recursion_limit: this.recursionLimit,
    };

    if (this.emitExecutionEvents && graph.streamEvents) {
      const text = await this.forwardStreamEvents(graph, input, graphConfig, tools);
      if (text) {
        await tools.sendMessage(text, [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
      }
      return;
    }

    if (!graph.invoke) {
      return;
    }

    const result = await graph.invoke(input, graphConfig);
    const text = extractAssistantText(result);
    if (text) {
      await tools.sendMessage(text, [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.bootstrappedRooms.delete(roomId);
  }

  /** A caller-supplied graph rather than the built-in createReactAgent. */
  private get usesCustomGraph(): boolean {
    return Boolean(this.graph || this.graphFactory);
  }

  private resolveGraph(
    sdk: LangGraphSdk | undefined,
    langGraphTools: unknown[],
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

    return Promise.resolve(sdk.createReactAgent({
      llm: this.llm,
      tools: langGraphTools,
      checkpointer: this.checkpointer,
      prompt: this.renderedSystemPrompt,
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
      const historical = history.raw
        .filter((item) => item.id !== message.id)
        .slice(-this.maxHistoryMessages);
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
      if (eventType === "on_tool_start") {
        await tools.sendEvent(
          stringifyJsonWithFallback(data, this.logger, {
            label: "LangGraph event",
            eventType,
          }),
          "tool_call",
        );
      }
      if (eventType === "on_tool_end") {
        await tools.sendEvent(
          stringifyJsonWithFallback(data, this.logger, {
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

function buildLangGraphTools(input: {
  sdk: LangGraphSdk;
  tools: AdapterToolsProtocol;
  includeMemoryTools: boolean;
  logger: Logger;
}): unknown[] {
  const schemas = input.tools.getToolSchemas("openai", {
    includeMemory: input.includeMemoryTools,
  });
  const wrappers: unknown[] = [];

  for (const schema of schemas) {
    const spec = toLangGraphToolSpec(schema);
    if (!spec) {
      continue;
    }

    wrappers.push(
      input.sdk.tool(
        async (args: Record<string, unknown>) => {
          const result = await input.tools.executeToolCall(spec.name, args);
          return stringifyToolResult(result, input.logger, spec.name);
        },
        {
          name: spec.name,
          description: spec.description,
          schema: spec.schema,
        },
      ),
    );
  }

  return wrappers;
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
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

// Detects a LangChain assistant message in either shape:
//  - serialized: { id: [..., "AIMessage" | "AIMessageChunk"], kwargs: { content } }
//  - in-memory instance (real createReactAgent stream): getType() === "ai", content on the instance
function isLangChainAssistantMessage(record: Record<string, unknown>): boolean {
  const id = record.id;
  if (Array.isArray(id)) {
    const typeName = String(id[id.length - 1] ?? "");
    if (typeName === "AIMessage" || typeName === "AIMessageChunk") {
      return true;
    }
  }

  const getType = (record as { getType?: unknown }).getType;
  if (typeof getType === "function") {
    try {
      return (getType as () => unknown).call(record) === "ai";
    } catch {
      return false;
    }
  }

  return false;
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
    const [prebuiltModule, coreToolsModule] = await Promise.all([
      import("@langchain/langgraph/prebuilt").then((module) => module as { createReactAgent: LangGraphSdk["createReactAgent"] }),
      import("@langchain/core/tools").then((module) => module as { tool: LangGraphSdk["tool"] }),
    ]);
    const { createReactAgent } = prebuiltModule;
    const { tool } = coreToolsModule;

    if (typeof createReactAgent !== "function" || typeof tool !== "function") {
      throw new UnsupportedFeatureError("LangGraph SDK exports are unavailable.");
    }

    return { createReactAgent, tool };
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

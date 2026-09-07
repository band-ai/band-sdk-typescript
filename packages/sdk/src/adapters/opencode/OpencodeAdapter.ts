import { AgentFailure } from "@band-ai/band-sdk-core";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MentionInput } from "../../contracts/dtos";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { renderSystemPrompt } from "../../runtime/prompts";
import type { PlatformMessage } from "../../runtime/types";
import {
  executeCustomTool,
  getCustomToolName,
  customToolToOpenAISchema,
  type CustomToolDef,
} from "../../runtime/tools/customTools";
import {
  createBandMcpBackend,
  type BandMcpBackend,
} from "../../mcp/backends";
import type { McpToolRegistration } from "../../mcp/registrations";
import { errorResult, successResult } from "../../mcp/registrations";
import { MCP_SERVER_NAME } from "../../runtime/tools/schemas";
import { abandon } from "../shared/abandon";
import { asErrorMessage, asOptionalRecord } from "../shared/coercion";
import { deliverReply, rethrowIfDeliveryFailure } from "../shared/deliveryFailedError";
import { FAILURE_CODE_TIMEOUT, agentFailure, safeSendFailure } from "../shared/providerFailure";
import {
  type OpencodeSessionState,
  OpencodeHistoryConverter,
} from "../../converters/opencode";
import {
  HttpOpencodeClient,
  HttpStatusError,
  ManagedOpencodeClient,
  type OpencodeClientLike,
} from "./client";

const OPENCODE_SYSTEM_NOTE = [
  "Responses are relayed back into the Band room by the adapter.",
  "Use the band_ prefixed tools (for example band_send_message) for Band platform actions when available.",
  "When you need approval or clarification, ask clearly and wait for the user's next room message.",
].join("\n");

export type OpencodeApprovalMode = "manual" | "auto_accept" | "auto_decline";
export type OpencodeQuestionMode = "manual" | "auto_reject";
export type OpencodeApprovalReply = "once" | "always" | "reject";

export interface OpencodeAdapterConfig {
  baseUrl?: string;
  directory?: string;
  workspace?: string;
  providerId?: string;
  modelId?: string;
  agent?: string;
  variant?: string;
  customSection?: string;
  includeBaseInstructions?: boolean;
  enableTaskEvents?: boolean;
  enableExecutionReporting?: boolean;
  enableMemoryTools?: boolean;
  fallbackSendAgentText?: boolean;
  turnTimeoutMs?: number;
  approvalMode?: OpencodeApprovalMode;
  approvalWaitTimeoutMs?: number;
  approvalTimeoutReply?: OpencodeApprovalReply;
  questionMode?: OpencodeQuestionMode;
  questionWaitTimeoutMs?: number;
  sessionTitlePrefix?: string;
  mcpServerName?: string;
}

interface PendingPermission {
  requestId: string;
  permission: string;
  patterns: string[];
  timeout: ReturnType<typeof setTimeout> | null;
}

interface PendingQuestion {
  requestId: string;
  questions: Array<Record<string, unknown>>;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface RoomState {
  roomId: string;
  sessionId: string | null;
  tools: AdapterToolsProtocol | null;
  turnDone: Promise<void> | null;
  // Set synchronously the instant `resolveTurnDone` runs — unlike `turnDone`
  // itself (nulled only once `watchTurnCompletion`'s own cleanup finishes,
  // several microtask hops later), this lets `onMessage` tell "the turn has
  // genuinely finished" from "still pending" without a race against that
  // cleanup. It decides who observes `turnTask`: this call, when the turn
  // finished inside it, or a background catch when the turn outlives it.
  turnDoneSettled: boolean;
  resolveTurnDone: (() => void) | null;
  releaseWait: Promise<void> | null;
  resolveReleaseWait: (() => void) | null;
  turnTask: Promise<void> | null;
  pendingMentions: MentionInput;
  textParts: Map<string, string>;
  assistantMessageIds: Set<string>;
  assistantPartTypes: Map<string, string>;
  reportedToolCalls: Set<string>;
  reportedToolResults: Set<string>;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  lastErrorMessage: string | null;
  persistedSessionId: string | null;
}

interface OpencodeAdapterOptions {
  config?: OpencodeAdapterConfig;
  customTools?: CustomToolDef[];
  historyConverter?: OpencodeHistoryConverter;
  clientFactory?: (config: Required<OpencodeAdapterConfig>) => OpencodeClientLike;
  mcpBackendFactory?: typeof createBandMcpBackend;
  logger?: Logger;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function withDefaults(config?: OpencodeAdapterConfig): Required<OpencodeAdapterConfig> {
  return {
    baseUrl: "",
    directory: "",
    workspace: "",
    providerId: "",
    modelId: "",
    agent: "",
    variant: "",
    customSection: "",
    includeBaseInstructions: false,
    enableTaskEvents: true,
    enableExecutionReporting: false,
    enableMemoryTools: false,
    fallbackSendAgentText: true,
    turnTimeoutMs: 300_000,
    approvalMode: "manual",
    approvalWaitTimeoutMs: 300_000,
    approvalTimeoutReply: "reject",
    questionMode: "manual",
    questionWaitTimeoutMs: 300_000,
    sessionTitlePrefix: "Band",
    mcpServerName: MCP_SERVER_NAME,
    ...config,
  };
}

function buildCustomMcpRegistrations(customTools: CustomToolDef[]): McpToolRegistration[] {
  return customTools.map((customTool) => {
    const schema = customToolToOpenAISchema(customTool);
    const functionSchema = asOptionalRecord(schema.function) ?? {};
    const parameters = asOptionalRecord(functionSchema.parameters) ?? {};
    const properties = asOptionalRecord(parameters.properties) ?? {};
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [];

    return {
      name: getCustomToolName(customTool),
      description: typeof functionSchema.description === "string" ? functionSchema.description : "",
      inputSchema: {
        type: "object",
        properties,
        required,
      },
      execute: async (args) => {
        try {
          return successResult(await executeCustomTool(customTool, args));
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    };
  });
}

export class OpencodeAdapter extends SimpleAdapter<OpencodeSessionState, AdapterToolsProtocol> {
  protected readonly provider = "opencode";

  private readonly config: Required<OpencodeAdapterConfig>;
  private readonly customTools: CustomToolDef[];
  private readonly clientFactory: (config: Required<OpencodeAdapterConfig>) => OpencodeClientLike;
  private readonly mcpBackendFactory: typeof createBandMcpBackend;
  private readonly logger: Logger;
  private readonly rooms = new Map<string, RoomState>();
  private readonly roomBySession = new Map<string, string>();
  private client: OpencodeClientLike | null = null;
  private eventTask: Promise<void> | null = null;
  private mcpBackend: BandMcpBackend | null = null;
  private systemPrompt = "";

  public constructor(options: OpencodeAdapterOptions = {}) {
    super({
      historyConverter: options.historyConverter ?? new OpencodeHistoryConverter(),
    });
    this.config = withDefaults(options.config);
    this.customTools = [...(options.customTools ?? [])];
    this.clientFactory = options.clientFactory ?? ((config) => (
      config.baseUrl
        ? new HttpOpencodeClient({
          baseUrl: config.baseUrl,
          directory: config.directory || undefined,
          workspace: config.workspace || undefined,
          timeoutMs: config.turnTimeoutMs,
        })
        : new ManagedOpencodeClient({
          directory: config.directory || undefined,
          workspace: config.workspace || undefined,
        })
    ));
    this.mcpBackendFactory = options.mcpBackendFactory ?? createBandMcpBackend;
    this.logger = resolveLogger(options.logger);
  }

  public override async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    const systemPrompt = renderSystemPrompt({
      agentName,
      agentDescription,
      customSection: this.config.customSection,
      includeBaseInstructions: this.config.includeBaseInstructions,
      capabilities: { memory: this.config.enableMemoryTools },
    }).trim();
    this.systemPrompt = `${systemPrompt}\n\n${OPENCODE_SYSTEM_NOTE}`.trim();
  }

  public async onRuntimeStop(): Promise<void> {
    await this.shutdownClient();
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: OpencodeSessionState,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const roomState = this.getOrCreateRoomState(context.roomId);
    roomState.tools = tools;

    if (await this.handleControlMessage(roomState, message)) {
      return;
    }

    if (roomState.turnDone) {
      await tools.sendEvent(
        "OpenCode is still processing the previous request in this room.",
        "error",
      );
      return;
    }

    try {
      await this.ensureClientStarted();
      const client = this.client;
      if (!client) {
        throw new Error("OpenCode client is not initialized.");
      }

      const { sessionId, created, restoredMissingSession } = await this.ensureSession(roomState, history);
      if (this.config.enableTaskEvents && (roomState.persistedSessionId !== sessionId || context.isSessionBootstrap)) {
        await this.emitSessionTaskEvent(roomState, created ? "created" : "resumed");
      }

      await this.startTurn(roomState, client, sessionId, message, participantsMessage, contactsMessage, history, restoredMissingSession, context.roomId);
    } catch (error) {
      rethrowIfDeliveryFailure(error);

      this.logger.error("OpenCode adapter request failed", {
        error,
        roomId: context.roomId,
      });
      await tools.sendFailure(this.toAgentFailure(error));
    }
  }

  private async startTurn(
    roomState: RoomState,
    client: OpencodeClientLike,
    sessionId: string,
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
    history: OpencodeSessionState,
    restoredMissingSession: boolean,
    roomId: string,
  ): Promise<void> {
    this.beginTurn(roomState, message.senderId);
    try {
      await client.promptAsync(sessionId, {
        parts: this.buildPromptParts(message, participantsMessage, contactsMessage, {
          replayMessages: restoredMissingSession ? history.replayMessages : null,
        }),
        system: this.systemPrompt,
        model: this.buildModelPayload(),
        agent: this.config.agent || undefined,
        variant: this.config.variant || undefined,
      });
    } catch (error) {
      this.clearTurnState(roomState);
      throw error;
    }

    const turnTask = this.watchTurnCompletion(roomState);
    roomState.turnTask = turnTask;
    if (roomState.releaseWait) {
      await roomState.releaseWait;
    }
    if (roomState.turnDoneSettled) {
      await turnTask;
      return;
    }

    // The turn outlives this call — OpenCode asked for permission, so its
    // reply is delivered from the background completion instead. No turn is
    // left to fail, but the promise must still be observed: a delivery
    // failure here would otherwise be an unhandled rejection, which ends
    // the process rather than the turn.
    void turnTask.catch((error: unknown) => {
      this.logger.error("OpenCode turn failed after the request returned", {
        error,
        roomId,
      });
    });
  }

  public async onCleanup(roomId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) {
      return;
    }

    this.rooms.delete(roomId);
    if (roomState.sessionId) {
      this.roomBySession.delete(roomState.sessionId);
    }
    this.clearTurnState(roomState);

    if (this.rooms.size === 0) {
      await this.shutdownClient();
    }
  }

  private getOrCreateRoomState(roomId: string): RoomState {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const created: RoomState = {
      roomId,
      sessionId: null,
      tools: null,
      turnDone: null,
      turnDoneSettled: false,
      resolveTurnDone: null,
      releaseWait: null,
      resolveReleaseWait: null,
      turnTask: null,
      pendingMentions: [],
      textParts: new Map(),
      assistantMessageIds: new Set(),
      assistantPartTypes: new Map(),
      reportedToolCalls: new Set(),
      reportedToolResults: new Set(),
      pendingPermission: null,
      pendingQuestion: null,
      lastErrorMessage: null,
      persistedSessionId: null,
    };
    this.rooms.set(roomId, created);
    return created;
  }

  private async ensureClientStarted(): Promise<void> {
    const wasNew = this.client === null;
    if (this.client === null) {
      this.client = this.clientFactory(this.config);
    }
    if (!this.eventTask) {
      this.eventTask = this.runEventLoop();
    }
    if (wasNew) {
      await this.registerMcpBackend();
    }
  }

  private async ensureMcpBackend(): Promise<BandMcpBackend> {
    if (this.mcpBackend) {
      return this.mcpBackend;
    }

    const backend = await this.mcpBackendFactory({
      kind: "http",
      enableMemoryTools: this.config.enableMemoryTools,
      getToolsForRoom: (roomId) => this.rooms.get(roomId)?.tools ?? undefined,
      additionalTools: this.customTools.length > 0 ? buildCustomMcpRegistrations(this.customTools) : undefined,
    });
    this.mcpBackend = backend;
    return backend;
  }

  private async registerMcpBackend(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    try {
      const backend = await this.ensureMcpBackend();
      const server = backend.server as { url?: string | null };
      if (!server.url) {
        this.logger.warn("OpenCode MCP backend has no URL.");
        return;
      }
      await client.registerMcpServer({
        name: this.config.mcpServerName,
        url: server.url,
        headers: backend.authToken ? { Authorization: `Bearer ${backend.authToken}` } : undefined,
      });
    } catch (error) {
      this.logger.warn("Failed to register OpenCode MCP backend", { error });
    }
  }

  private async shutdownClient(): Promise<void> {
    const client = this.client;
    const backend = this.mcpBackend;
    const eventTask = this.eventTask;
    this.client = null;
    this.mcpBackend = null;
    this.eventTask = null;

    if (client) {
      try {
        await client.deregisterMcpServer(this.config.mcpServerName);
      } catch {}
    }

    if (backend) {
      await backend.stop();
    }

    if (client) {
      await client.close();
    }

    if (eventTask) {
      await Promise.resolve(eventTask).catch(() => undefined);
    }
  }

  private async runEventLoop(): Promise<void> {
    let retryDelayMs = 1000;
    while (this.client) {
      const activeClient = this.client;
      try {
        for await (const event of activeClient.iterEvents()) {
          retryDelayMs = 1000;
          await this.handleEvent(event);
        }
      } catch (error) {
        if (this.client !== activeClient) {
          return;
        }
        this.logger.warn("OpenCode event stream failed", { error, retryDelayMs });
        await delay(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const eventType = String(event.type ?? "");
    const properties = asOptionalRecord(event.properties) ?? {};
    const roomState = this.roomStateForEvent(eventType, properties);
    if (!roomState) {
      return;
    }

    if (eventType === "message.updated") {
      const info = asOptionalRecord(properties.info) ?? {};
      const messageId = typeof info.id === "string" ? info.id : null;
      if (info.role === "assistant" && messageId) {
        roomState.assistantMessageIds.add(messageId);
      }
      const error = info.error;
      if (info.role === "assistant" && error) {
        roomState.lastErrorMessage = this.formatOpenCodeError(error);
      }
      return;
    }

    if (eventType === "message.part.updated") {
      const part = asOptionalRecord(properties.part);
      if (part) {
        await this.handlePartUpdate(roomState, part);
      }
      return;
    }

    if (eventType === "message.part.delta") {
      this.handlePartDelta(roomState, properties);
      return;
    }

    if (eventType === "permission.asked") {
      await this.handlePermissionAsked(roomState, properties);
      return;
    }

    if (eventType === "question.asked") {
      await this.handleQuestionAsked(roomState, properties);
      return;
    }

    if (eventType === "session.error") {
      roomState.lastErrorMessage = this.formatOpenCodeError(properties.error);
      this.finishTurn(roomState);
      return;
    }

    if (eventType === "session.idle") {
      this.finishTurn(roomState);
    }
  }

  private roomStateForEvent(eventType: string, properties: Record<string, unknown>): RoomState | null {
    const sessionId = this.extractSessionId(eventType, properties);
    if (!sessionId) {
      return null;
    }

    const roomId = this.roomBySession.get(sessionId);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  private extractSessionId(eventType: string, properties: Record<string, unknown>): string | null {
    if (typeof properties.sessionID === "string" && properties.sessionID.length > 0) {
      return properties.sessionID;
    }

    if (eventType === "message.updated") {
      const info = asOptionalRecord(properties.info);
      return typeof info?.sessionID === "string" ? info.sessionID : null;
    }

    if (eventType === "message.part.updated") {
      const part = asOptionalRecord(properties.part);
      return typeof part?.sessionID === "string" ? part.sessionID : null;
    }

    return null;
  }

  private async handlePartUpdate(roomState: RoomState, part: Record<string, unknown>): Promise<void> {
    const partType = String(part.type ?? "");
    const partId = typeof part.id === "string" ? part.id : null;
    const messageId = typeof part.messageID === "string" ? part.messageID : null;
    if (!partId) {
      return;
    }

    if (partType === "text") {
      if (messageId && roomState.assistantMessageIds.has(messageId)) {
        roomState.assistantPartTypes.set(partId, "text");
        roomState.textParts.set(partId, String(part.text ?? ""));
      }
      return;
    }

    if (partType === "reasoning") {
      if (messageId && roomState.assistantMessageIds.has(messageId)) {
        roomState.assistantPartTypes.set(partId, "reasoning");
      }
      return;
    }

    if (partType !== "tool" || !this.config.enableExecutionReporting) {
      return;
    }

    const state = asOptionalRecord(part.state) ?? {};
    const toolName = typeof part.tool === "string" ? part.tool : "unknown";
    const callId = typeof part.callID === "string" && part.callID.length > 0 ? part.callID : partId;
    const status = String(state.status ?? "");

    if ((status === "pending" || status === "running") && !roomState.reportedToolCalls.has(callId)) {
      roomState.reportedToolCalls.add(callId);
      await this.reportToolCall(roomState, toolName, state, callId);
      return;
    }

    if ((status === "completed" || status === "error")) {
      if (!roomState.reportedToolCalls.has(callId)) {
        roomState.reportedToolCalls.add(callId);
        await this.reportToolCall(roomState, toolName, state, callId);
      }
      if (!roomState.reportedToolResults.has(callId)) {
        roomState.reportedToolResults.add(callId);
        await this.reportToolResult(roomState, state, callId);
      }
    }
  }

  private handlePartDelta(roomState: RoomState, properties: Record<string, unknown>): void {
    if (properties.field !== "text") {
      return;
    }

    const partId = typeof properties.partID === "string" ? properties.partID : null;
    const messageId = typeof properties.messageID === "string" ? properties.messageID : null;
    if (!partId || !messageId || !roomState.assistantMessageIds.has(messageId)) {
      return;
    }
    if (roomState.assistantPartTypes.get(partId) !== "text") {
      return;
    }

    const deltaText = String(properties.delta ?? "");
    roomState.textParts.set(partId, `${roomState.textParts.get(partId) ?? ""}${deltaText}`);
  }

  private async handlePermissionAsked(roomState: RoomState, properties: Record<string, unknown>): Promise<void> {
    const requestId = typeof properties.id === "string" ? properties.id : null;
    if (!requestId) {
      return;
    }

    this.cancelPendingTimeout(roomState.pendingPermission);
    roomState.pendingPermission = {
      requestId,
      permission: typeof properties.permission === "string" ? properties.permission : "unknown",
      patterns: Array.isArray(properties.patterns)
        ? properties.patterns.filter((value): value is string => typeof value === "string")
        : [],
      timeout: null,
    };

    if (this.config.approvalMode === "auto_accept") {
      await this.replyPermission(roomState, "once");
      return;
    }
    if (this.config.approvalMode === "auto_decline") {
      await this.replyPermission(roomState, "reject");
      return;
    }

    roomState.pendingPermission.timeout = setTimeout(() => {
      void this.expirePermission(roomState, requestId);
    }, this.config.approvalWaitTimeoutMs);
    if (roomState.tools) {
      const patterns = roomState.pendingPermission.patterns.join(", ") || "n/a";
      await roomState.tools.sendMessage(
        `OpenCode approval requested for \`${roomState.pendingPermission.permission}\` (${patterns}). Reply with \`approve ${requestId}\`, \`always ${requestId}\`, or \`reject ${requestId}\`.`,
      );
    }
    this.releaseTurnWait(roomState);
  }

  private async handleQuestionAsked(roomState: RoomState, properties: Record<string, unknown>): Promise<void> {
    const requestId = typeof properties.id === "string" ? properties.id : null;
    const questions = Array.isArray(properties.questions)
      ? properties.questions.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
      : [];
    if (!requestId || questions.length === 0) {
      return;
    }

    this.cancelPendingTimeout(roomState.pendingQuestion);
    roomState.pendingQuestion = {
      requestId,
      questions,
      timeout: null,
    };

    if (this.config.questionMode === "auto_reject") {
      await this.rejectQuestion(roomState);
      return;
    }

    roomState.pendingQuestion.timeout = setTimeout(() => {
      void this.expireQuestion(roomState, requestId);
    }, this.config.questionWaitTimeoutMs);
    if (roomState.tools) {
      await roomState.tools.sendMessage(this.formatQuestionPrompt(questions, requestId));
    }
    this.releaseTurnWait(roomState);
  }

  private async handleControlMessage(roomState: RoomState, message: PlatformMessage): Promise<boolean> {
    const content = message.content.trim();
    if (content.length === 0) {
      return false;
    }

    const lowered = content.toLowerCase();
    if (roomState.pendingPermission) {
      const reply = this.parsePermissionReply(lowered, roomState.pendingPermission);
      if (reply) {
        await this.replyPermission(roomState, reply);
        if (roomState.tools) {
          await deliverReply(roomState.tools, 
            `OpenCode approval \`${roomState.pendingPermission?.requestId ?? ""}\` handled with \`${reply}\`.`,
          );
        }
        return true;
      }
    }

    if (roomState.pendingQuestion) {
      const requestId = roomState.pendingQuestion.requestId;
      if (lowered === "reject" || lowered === "/reject") {
        await this.rejectQuestion(roomState);
        if (roomState.tools) {
          await deliverReply(roomState.tools, `OpenCode question \`${requestId}\` rejected.`);
        }
        return true;
      }

      const answers = this.parseQuestionAnswers(content, roomState.pendingQuestion);
      if (answers === null) {
        if (roomState.tools) {
          await deliverReply(roomState.tools, 
            "OpenCode is waiting for answers. Reply with one line per question, or `reject` to reject the question.",
          );
        }
        return true;
      }

      await this.replyQuestion(roomState, answers);
      if (roomState.tools) {
        await deliverReply(roomState.tools, `OpenCode question \`${requestId}\` answered.`);
      }
      return true;
    }

    return false;
  }

  private async replyPermission(roomState: RoomState, reply: OpencodeApprovalReply): Promise<void> {
    const pending = roomState.pendingPermission;
    const client = this.client;
    if (!pending || !client || !roomState.sessionId) {
      return;
    }

    this.cancelPendingTimeout(pending);
    await client.replyPermission(roomState.sessionId, pending.requestId, { response: reply });
    roomState.pendingPermission = null;
  }

  private async replyQuestion(roomState: RoomState, answers: string[][]): Promise<void> {
    const pending = roomState.pendingQuestion;
    const client = this.client;
    if (!pending || !client) {
      return;
    }

    this.cancelPendingTimeout(pending);
    await client.replyQuestion(pending.requestId, { answers });
    roomState.pendingQuestion = null;
  }

  private async rejectQuestion(roomState: RoomState): Promise<void> {
    const pending = roomState.pendingQuestion;
    const client = this.client;
    if (!pending || !client) {
      return;
    }

    this.cancelPendingTimeout(pending);
    await client.rejectQuestion(pending.requestId);
    roomState.pendingQuestion = null;
  }

  private async expirePermission(roomState: RoomState, requestId: string): Promise<void> {
    if (roomState.pendingPermission?.requestId !== requestId) {
      return;
    }

    await this.replyPermission(roomState, this.config.approvalTimeoutReply);
    if (roomState.tools) {
      await roomState.tools.sendEvent(
        `OpenCode approval \`${requestId}\` timed out and was handled with \`${this.config.approvalTimeoutReply}\`.`,
        "error",
      );
    }
  }

  private async expireQuestion(roomState: RoomState, requestId: string): Promise<void> {
    if (roomState.pendingQuestion?.requestId !== requestId) {
      return;
    }

    await this.rejectQuestion(roomState);
    if (roomState.tools) {
      await roomState.tools.sendEvent(
        `OpenCode question \`${requestId}\` timed out and was rejected.`,
        "error",
      );
    }
  }

  private cancelPendingTimeout(pending: { timeout: ReturnType<typeof setTimeout> | null } | null): void {
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
  }

  private async ensureSession(
    roomState: RoomState,
    history: OpencodeSessionState,
  ): Promise<{ sessionId: string; created: boolean; restoredMissingSession: boolean }> {
    const client = this.client;
    if (!client) {
      throw new Error("OpenCode client is not initialized.");
    }

    const restoredSessionId = roomState.sessionId ?? history.sessionId;
    let created = false;
    let restoredMissingSession = false;
    let session: Record<string, unknown>;

    if (restoredSessionId) {
      try {
        session = await client.getSession(restoredSessionId);
      } catch (error) {
        if (!(error instanceof HttpStatusError) || error.status !== 404) {
          throw error;
        }
        session = await client.createSession({ title: this.buildSessionTitle(roomState.roomId) });
        created = true;
        restoredMissingSession = true;
      }
    } else {
      session = await client.createSession({ title: this.buildSessionTitle(roomState.roomId) });
      created = true;
    }

    const sessionId = typeof session.id === "string" ? session.id : String(session.id ?? "");
    if (roomState.sessionId && roomState.sessionId !== sessionId) {
      this.roomBySession.delete(roomState.sessionId);
    }
    roomState.sessionId = sessionId;
    this.roomBySession.set(sessionId, roomState.roomId);
    return { sessionId, created, restoredMissingSession };
  }

  private beginTurn(roomState: RoomState, senderId: string | null): void {
    const turnDone = createDeferred();
    const releaseWait = createDeferred();
    roomState.turnDone = turnDone.promise;
    roomState.turnDoneSettled = false;
    roomState.resolveTurnDone = () => {
      roomState.turnDoneSettled = true;
      turnDone.resolve();
    };
    roomState.releaseWait = releaseWait.promise;
    roomState.resolveReleaseWait = releaseWait.resolve;
    roomState.pendingMentions = senderId ? [{ id: senderId }] : [];
    roomState.turnTask = null;
    roomState.textParts.clear();
    roomState.assistantMessageIds.clear();
    roomState.assistantPartTypes.clear();
    roomState.reportedToolCalls.clear();
    roomState.reportedToolResults.clear();
    roomState.lastErrorMessage = null;
  }

  private async watchTurnCompletion(roomState: RoomState): Promise<void> {
    const turnDone = roomState.turnDone;
    if (!turnDone) {
      return;
    }

    try {
      await Promise.race([
        turnDone,
        delay(this.config.turnTimeoutMs).then(() => {
          throw new Error("timeout");
        }),
      ]);
      await this.deliverFallbackText(roomState);
      this.releaseTurnWait(roomState);
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        await this.handleTurnTimeout(roomState);
        return;
      }
      throw error;
    } finally {
      this.clearTurnState(roomState, turnDone);
    }
  }

  private async handleTurnTimeout(roomState: RoomState): Promise<void> {
    const client = this.client;
    const abortedSessionId = roomState.sessionId;
    if (client && abortedSessionId) {
      // A server wedged enough to blow the turn timeout can leave this
      // request pending too, and everything below frees the room. See
      // `abandon`.
      abandon(() => client.abortSession(abortedSessionId));
    }
    if (roomState.tools) {
      // Best-effort: the timeout itself is the truth we already know, and
      // failing to report it must not leave the room's turn wait released
      // forever.
      await safeSendFailure(
        roomState.tools,
        new AgentFailure(this.provider, "OpenCode timed out before completing the turn.", FAILURE_CODE_TIMEOUT),
        this.logger,
        { roomId: roomState.roomId },
      );
    }
    this.releaseTurnWait(roomState);
  }

  private releaseTurnWait(roomState: RoomState): void {
    roomState.resolveReleaseWait?.();
  }

  private finishTurn(roomState: RoomState): void {
    roomState.resolveTurnDone?.();
    roomState.resolveReleaseWait?.();
  }

  private clearTurnState(roomState: RoomState, expectedTurn?: Promise<void>): void {
    if (expectedTurn && roomState.turnDone !== expectedTurn) {
      return;
    }
    this.cancelPendingTimeout(roomState.pendingPermission);
    this.cancelPendingTimeout(roomState.pendingQuestion);
    roomState.pendingPermission = null;
    roomState.pendingQuestion = null;
    roomState.turnDone = null;
    roomState.resolveTurnDone = null;
    roomState.releaseWait = null;
    roomState.resolveReleaseWait = null;
    roomState.turnTask = null;
  }

  private async emitSessionTaskEvent(roomState: RoomState, status: "created" | "resumed"): Promise<void> {
    if (!roomState.tools || !roomState.sessionId) {
      return;
    }

    const createdAt = new Date().toISOString();
    await roomState.tools.sendEvent(
      `OpenCode session ${status}: \`${roomState.sessionId}\``,
      "task",
      {
        opencode_session_id: roomState.sessionId,
        opencode_room_id: roomState.roomId,
        opencode_created_at: createdAt,
      },
    );
    roomState.persistedSessionId = roomState.sessionId;
  }

  private async deliverFallbackText(roomState: RoomState): Promise<void> {
    if (!roomState.tools || !this.config.fallbackSendAgentText) {
      return;
    }

    const text = [...roomState.textParts.values()]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();

    if (text.length > 0) {
      await deliverReply(roomState.tools, text, roomState.pendingMentions);
      roomState.pendingMentions = [];
      return;
    }

    if (roomState.lastErrorMessage) {
      await roomState.tools.sendFailure(new AgentFailure(this.provider, roomState.lastErrorMessage));
      roomState.pendingMentions = [];
      return;
    }

    await deliverReply(
      roomState.tools,
      "OpenCode completed the turn without a text reply.",
      roomState.pendingMentions,
    );
    roomState.pendingMentions = [];
  }

  private async reportToolCall(
    roomState: RoomState,
    toolName: string,
    state: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    if (!roomState.tools) {
      return;
    }
    try {
      await roomState.tools.sendEvent(
        JSON.stringify({
          name: toolName,
          args: asOptionalRecord(state.input) ?? {},
          tool_call_id: callId,
        }),
        "tool_call",
      );
    } catch (error) {
      this.logger.warn("Failed to report OpenCode tool call", { error, callId });
    }
  }

  private async reportToolResult(
    roomState: RoomState,
    state: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    if (!roomState.tools) {
      return;
    }
    const output = state.status === "error"
      ? { error: state.error ?? "OpenCode tool failed" }
      : state.output ?? "";
    try {
      await roomState.tools.sendEvent(
        JSON.stringify({
          output,
          tool_call_id: callId,
        }),
        "tool_result",
      );
    } catch (error) {
      this.logger.warn("Failed to report OpenCode tool result", { error, callId });
    }
  }

  private buildSessionTitle(roomId: string): string {
    return `${this.config.sessionTitlePrefix}: ${this.agentName || "Agent"} / ${roomId}`;
  }

  private buildModelPayload(): Record<string, string> | undefined {
    if (!this.config.providerId || !this.config.modelId) {
      return undefined;
    }
    return {
      providerID: this.config.providerId,
      modelID: this.config.modelId,
    };
  }

  private buildPromptParts(
    message: PlatformMessage,
    participantsMessage: string | null,
    contactsMessage: string | null,
    options?: { replayMessages?: string[] | null },
  ): Array<Record<string, unknown>> {
    const lines: string[] = [];
    if (options?.replayMessages && options.replayMessages.length > 0) {
      lines.push("Previous OpenCode session state was missing. Recovered room history:");
      lines.push(...options.replayMessages);
    }
    if (participantsMessage) {
      lines.push(`[System]: ${participantsMessage}`);
    }
    if (contactsMessage) {
      lines.push(`[System]: ${contactsMessage}`);
    }
    lines.push(`[${message.senderName ?? "Unknown"}]: ${message.content}`);
    return [{ type: "text", text: lines.join("\n") }];
  }

  private parsePermissionReply(
    loweredContent: string,
    pending: PendingPermission,
  ): OpencodeApprovalReply | null {
    const tokens = loweredContent.split(/\s+/).filter((value) => value.length > 0);
    if (tokens.length === 0) {
      return null;
    }

    const command = tokens[0].replace(/^\//, "");
    const requestId = tokens[1] ?? pending.requestId;
    if (requestId !== pending.requestId) {
      return null;
    }
    if (command === "approve") {
      return "once";
    }
    if (command === "always") {
      return "always";
    }
    if (command === "reject") {
      return "reject";
    }
    return null;
  }

  private parseQuestionAnswers(content: string, pending: PendingQuestion): string[][] | null {
    if (pending.questions.length === 1) {
      return [[content.trim()]];
    }

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < pending.questions.length) {
      return null;
    }
    return lines.slice(0, pending.questions.length).map((line) => [line]);
  }

  private formatQuestionPrompt(questions: Array<Record<string, unknown>>, requestId: string): string {
    const lines = [`OpenCode asked question \`${requestId}\`:`];
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${String(question.question ?? "Question")}`);
    });
    lines.push("Reply with one line per question, or `reject`.");
    return lines.join("\n");
  }

  private toAgentFailure(error: unknown): AgentFailure {
    if (error instanceof HttpStatusError) {
      // `error.body` is an untyped provider payload — JSON.stringify throws on
      // a cycle or a BigInt, and this is building the report for a failure
      // that must never itself throw.
      let body: string;
      try {
        body = typeof error.body === "string" ? error.body : JSON.stringify(error.body);
      } catch {
        body = "<unserializable body>";
      }
      const message = `OpenCode request failed (${error.status}): ${body}`;
      return agentFailure(this.provider, message, String(error.status), error.body);
    }
    return new AgentFailure(this.provider, `OpenCode failed while processing the message: ${asErrorMessage(error)}`);
  }

  private formatOpenCodeError(error: unknown): string {
    const payload = asOptionalRecord(error);
    if (!payload) {
      return "OpenCode reported an unknown error.";
    }
    const name = typeof payload.name === "string" ? payload.name : "OpenCodeError";
    const data = asOptionalRecord(payload.data);
    const message = typeof data?.message === "string" ? data.message : null;
    return message ? `${name}: ${message}` : `${name}: OpenCode reported an error.`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

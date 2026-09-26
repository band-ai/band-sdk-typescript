import { AgentFailure, isAuthorizedSender } from "@band-ai/band-sdk-core";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MentionInput } from "../../contracts/dtos";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { rethrowIfRecoverableTurnFailure, type RecoverableTurnError } from "../../core/errors";
import { createDeferred } from "../../core/deferred";
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
import { DecisionRegistry, senderAllowlist, type DecisionEntry } from "../shared/decisions";
import { asErrorMessage, asNestedMessage, asOptionalRecord, toDisplayText, truncate } from "../shared/coercion";
import {
  DeliveryFailedError,
  deliverReply,
} from "../../core/deliveryFailedError";
import {
  FAILURE_CODE_TIMEOUT,
  ProviderTurnFailedError,
  agentFailure,
  reportTurnFailure,
  safeSendFailure,
} from "../../core/providerFailure";
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
import { OPENCODE_DECISION_MESSAGES, formatQuestionPrompt } from "./messages";
import {
  REPLY_WORDS,
  routeReply,
  toPendingPermission,
  toPendingQuestion,
  type DecisionKind,
  type OpencodeApprovalReply,
  type PendingPermission,
  type PendingQuestion,
  type ReplyAction,
  type RoomDecisions,
} from "./replies";

const OPENCODE_SYSTEM_NOTE = [
  "Responses are relayed back into the Band room by the adapter.",
  "Use the band_ prefixed tools (for example band_send_message) for Band platform actions when available.",
  "When you need approval or clarification, ask clearly and wait for the user's next room message.",
].join("\n");

export type OpencodeApprovalMode = "manual" | "auto_accept" | "auto_decline";
export type OpencodeQuestionMode = "manual" | "auto_reject";

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
  /**
   * "manual" relays each OpenCode permission ask to the room. Replies are
   * `approve <id>`, `always <id>`, or `reject <id>`, optionally after
   * @mentions. The id may be left out while exactly one approval is pending.
   */
  approvalMode?: OpencodeApprovalMode;
  approvalWaitTimeoutMs?: number;
  approvalTimeoutReply?: OpencodeApprovalReply;
  /**
   * "manual" relays each OpenCode question to the room. Free text answers the
   * oldest pending question, one line per question; `reject [id]` rejects it.
   */
  questionMode?: OpencodeQuestionMode;
  questionWaitTimeoutMs?: number;
  sessionTitlePrefix?: string;
  mcpServerName?: string;
}

type TurnReleaseOutcome =
  | { kind: "foreground" }
  | { kind: "background" }
  | { kind: "cancelled" }
  | { kind: "delivery_failed"; error: RecoverableTurnError };

// "completed": OpenCode itself finished the turn (session.idle/session.error).
// "cancelled": something else ended it first — room cleanup (`onCleanup`) tore
// the turn down, or one of its interactions failed (`failInteraction`) — so
// `watchTurnCompletion`'s race must exit quietly rather than through its
// timeout branch, which would abort and fail whatever session id a later,
// unrelated turn goes on to reuse for this or another room.
type TurnEndOutcome = "completed" | "cancelled";

// Sends the reply to the ask `entry` claimed; `expectedTurn` is the turn it belongs to.
type ReplySender<T> = (entry: DecisionEntry<T>, expectedTurn: Promise<TurnEndOutcome> | null) => Promise<void>;

// What differs between a permission ask and a question ask.
interface AskLifecycle<T> {
  kind: DecisionKind;
  // Set when the configured mode answers without asking the room.
  autoReply: ReplySender<T> | null;
  timeoutMs: number;
  timeoutReply: ReplySender<T>;
  timedOutNotice: string;
  prompt: string;
  // Rejects the ask server-side when its prompt could not be posted.
  rejectAsk: (client: OpencodeClientLike) => Promise<unknown>;
}

interface RoomState {
  roomId: string;
  sessionId: string | null;
  tools: AdapterToolsProtocol | null;
  turnOutcome: Promise<TurnEndOutcome> | null;
  resolveTurnOutcome: ((outcome: TurnEndOutcome) => void) | null;
  releaseWait: Promise<TurnReleaseOutcome> | null;
  resolveReleaseWait: ((outcome: TurnReleaseOutcome) => void) | null;
  turnTask: Promise<void> | null;
  // Set by `failInteraction`. `releaseWait` is a one-shot channel: once a
  // turn has already backgrounded on an earlier interactive prompt, a later
  // interaction's failure has no live `releaseWait` left to carry it to
  // `startTurn`'s caller — `watchTurnCompletion`'s "cancelled" branch
  // re-throws this instead, so `turnTask`'s own background observer (see
  // `startTurn`) still sees the failure.
  pendingDeliveryFailure: RecoverableTurnError | null;
  pendingMentions: MentionInput;
  textParts: Map<string, string>;
  assistantMessageIds: Set<string>;
  assistantPartTypes: Map<string, string>;
  reportedToolCalls: Set<string>;
  reportedToolResults: Set<string>;
  decisions: RoomDecisions;
  lastErrorMessage: string | null;
  // Distinct from a truthy `lastErrorMessage`: a `message.updated` event can set
  // that for a single assistant message's own reported error without the
  // session as a whole failing, but only a real `session.error` event may mark
  // the turn itself as terminally failed.
  sessionErrored: boolean;
  persistedSessionId: string | null;
  // Set when a turn times out: its session's abort is fired-and-forgotten
  // (see `abandon`), so the session may still be settling server-side. The
  // next turn in this room must not resume it — `ensureSession` consumes
  // this to force a brand-new session instead of restoring the old one.
  forceFreshSession: boolean;
}

interface OpencodeAdapterOptions {
  config?: OpencodeAdapterConfig;
  customTools?: CustomToolDef[];
  historyConverter?: OpencodeHistoryConverter;
  clientFactory?: (config: Required<OpencodeAdapterConfig>) => OpencodeClientLike;
  mcpBackendFactory?: typeof createBandMcpBackend;
  logger?: Logger;
  /**
   * Sender ids allowed to resolve approvals and questions from the room.
   * Omitted lets anyone resolve; an empty list lets nobody. Hints about how
   * to reply go to anyone.
   */
  decisionAuthorizedSenders?: readonly string[];
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
  private readonly authorizedSenders: ReadonlySet<string> | null;
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
    this.authorizedSenders = senderAllowlist(options.decisionAuthorizedSenders);
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

    try {
      if (await this.handleControlMessage(roomState, message)) {
        return;
      }
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error);
      await reportTurnFailure(
        tools,
        this.toAgentFailure(error),
        this.logger,
        { roomId: roomState.roomId, sessionId: roomState.sessionId },
      );
      return;
    }

    if (roomState.turnOutcome) {
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

      const { sessionId, created, needsHistoryReplay } = await this.ensureSession(roomState, history);
      if (this.config.enableTaskEvents && (roomState.persistedSessionId !== sessionId || context.isSessionBootstrap)) {
        await this.emitSessionTaskEvent(roomState, created ? "created" : "resumed");
      }

      await this.startTurn(roomState, client, sessionId, message, participantsMessage, contactsMessage, history, needsHistoryReplay, context.roomId);
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error);

      this.logger.error("OpenCode adapter request failed", {
        error,
        roomId: context.roomId,
      });
      // Reports and throws, like every other adapter this PR converted:
      // returning here would mark this message processed even though the
      // turn — startup, session establishment, or the prompt itself — never
      // actually completed, dropping PlatformRuntime's retry along with it.
      return reportTurnFailure(tools, this.toAgentFailure(error), this.logger, { roomId: context.roomId });
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
    needsHistoryReplay: boolean,
    roomId: string,
  ): Promise<void> {
    const releaseWait = this.beginTurn(roomState, message.senderId);
    try {
      await client.promptAsync(sessionId, {
        parts: this.buildPromptParts(message, participantsMessage, contactsMessage, {
          replayMessages: needsHistoryReplay ? history.replayMessages : null,
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
    // Only now has a forced-fresh replacement's history replay actually been
    // submitted — see `ensureSession`'s comment on why clearing the flag
    // can't happen there, before this call was known to succeed.
    roomState.forceFreshSession = false;

    const turnTask = this.watchTurnCompletion(roomState);
    roomState.turnTask = turnTask;
    const release = await releaseWait;

    if (release.kind === "background") {
      // The turn outlives this call while OpenCode waits for user input. Its
      // eventual outcome still needs an observer after this request returns.
      void turnTask.catch((error: unknown) => {
        this.logger.error("OpenCode turn failed after the request returned", {
          error,
          roomId,
        });
      });
      return;
    }

    await turnTask;
    if (release.kind === "delivery_failed") {
      throw release.error;
    }
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
      turnOutcome: null,
      resolveTurnOutcome: null,
      releaseWait: null,
      resolveReleaseWait: null,
      turnTask: null,
      pendingDeliveryFailure: null,
      pendingMentions: [],
      textParts: new Map(),
      assistantMessageIds: new Set(),
      assistantPartTypes: new Map(),
      reportedToolCalls: new Set(),
      reportedToolResults: new Set(),
      decisions: {
        permissions: new DecisionRegistry({ logger: this.logger }),
        questions: new DecisionRegistry({ logger: this.logger }),
        knownIds: new Map(),
      },
      lastErrorMessage: null,
      sessionErrored: false,
      persistedSessionId: null,
      forceFreshSession: false,
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
      roomState.sessionErrored = true;
      this.finishTurn(roomState);
      return;
    }

    if (eventType === "session.idle") {
      const hasText = [...roomState.textParts.values()].some((value) => value.trim().length > 0);
      if (roomState.lastErrorMessage && !hasText) {
        roomState.sessionErrored = true;
      }
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
    const pending = toPendingPermission(properties);
    if (!pending) {
      return;
    }
    const { requestId } = pending;
    const replyWith = (reply: OpencodeApprovalReply): ReplySender<PendingPermission> =>
      (entry, expectedTurn) => this.sendPermissionReply(roomState, entry, reply, expectedTurn);
    const { approvalMode, approvalTimeoutReply } = this.config;
    await this.openAsk(roomState, roomState.decisions.permissions, pending, {
      kind: "permission",
      autoReply: approvalMode === "manual" ? null : replyWith(approvalMode === "auto_accept" ? REPLY_WORDS.approve : REPLY_WORDS.reject),
      timeoutMs: this.config.approvalWaitTimeoutMs,
      timeoutReply: replyWith(approvalTimeoutReply),
      timedOutNotice: OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, approvalTimeoutReply),
      prompt: OPENCODE_DECISION_MESSAGES.approvalRequested(pending),
      rejectAsk: (client) => {
        const sessionId = roomState.sessionId;
        return sessionId ? client.replyPermission(sessionId, requestId, { response: REPLY_WORDS.reject }) : Promise.resolve();
      },
    });
  }

  private async handleQuestionAsked(roomState: RoomState, properties: Record<string, unknown>): Promise<void> {
    const pending = toPendingQuestion(properties);
    if (!pending) {
      return;
    }
    const { requestId, questions } = pending;
    if (questions.length === 0) {
      // Nothing to answer, so nobody would: reject it rather than leave OpenCode blocked on it.
      this.logger.warn("opencode_adapter.empty_question_rejected", { roomId: roomState.roomId, requestId });
      const client = this.client;
      if (client) {
        this.rejectInBackground(roomState, () => client.rejectQuestion(requestId));
      }
      return;
    }
    const reject: ReplySender<PendingQuestion> = (entry, expectedTurn) => this.sendQuestionReject(roomState, entry, expectedTurn);
    await this.openAsk(roomState, roomState.decisions.questions, pending, {
      kind: "question",
      autoReply: this.config.questionMode === "auto_reject" ? reject : null,
      timeoutMs: this.config.questionWaitTimeoutMs,
      timeoutReply: reject,
      timedOutNotice: OPENCODE_DECISION_MESSAGES.questionTimedOut(requestId),
      prompt: formatQuestionPrompt(questions, requestId),
      rejectAsk: (client) => client.rejectQuestion(requestId),
    });
  }

  // One ask's lifecycle, whatever its kind: register it, then reply automatically or relay it to the room.
  private async openAsk<T extends { requestId: string }>(
    roomState: RoomState,
    registry: DecisionRegistry<T>,
    pending: T,
    ask: AskLifecycle<T>,
  ): Promise<void> {
    const { requestId } = pending;
    // Null for a redelivery of an ask whose reply is already in flight: that reply answers it.
    const registration = registry.registerKeyed(pending, { key: requestId });
    if (!registration) {
      return;
    }
    const { entry } = registration;
    roomState.decisions.knownIds.set(requestId, ask.kind);

    if (ask.autoReply) {
      const claimed = registry.tryClaim(requestId);
      if (claimed) {
        await this.replyInBackground(roomState, claimed, ask.autoReply);
      }
      return;
    }
    registry.startTimeout(entry, ask.timeoutMs, async (expired) => {
      if (await this.replyInBackground(roomState, expired, ask.timeoutReply)) {
        await roomState.tools?.sendEvent(ask.timedOutNotice, "error");
      }
    });
    await this.postAsk(roomState, registry, entry, ask.prompt, ask.rejectAsk);
  }

  // Best-effort: the session is being given up on, so nothing waits on this rejection.
  private rejectInBackground(roomState: RoomState, reject: () => Promise<unknown>): void {
    abandon(reject, (error) => {
      this.logger.warn("opencode_adapter.interaction_rejection_failed", { roomId: roomState.roomId, error });
    });
  }

  // Posts a manual ask to the room and backgrounds the turn while it waits.
  private async postAsk<T>(
    roomState: RoomState,
    registry: DecisionRegistry<T>,
    entry: DecisionEntry<T>,
    prompt: string,
    rejectAsk: (client: OpencodeClientLike) => Promise<unknown>,
  ): Promise<void> {
    const expectedTurn = roomState.turnOutcome;
    try {
      await roomState.tools?.sendMessage(prompt, roomState.pendingMentions);
    } catch (error) {
      // A reply that claimed the ask meanwhile owns it, and so does whatever replaced or removed it.
      if (roomState.turnOutcome !== expectedTurn || !registry.withdraw(entry)) {
        return;
      }
      this.logger.warn("opencode_adapter.ask_prompt_delivery_failed", {
        roomId: roomState.roomId,
        requestId: entry.token,
        error,
      });
      const client = this.client;
      this.failInteraction(roomState, new DeliveryFailedError(error), client ? () => rejectAsk(client) : undefined);
      return;
    }
    if (roomState.turnOutcome !== expectedTurn || !registry.has(entry.token)) {
      return;
    }
    this.releaseTurnWait(roomState, { kind: "background" });
  }

  private async handleControlMessage(roomState: RoomState, message: PlatformMessage): Promise<boolean> {
    const action = routeReply(message.content, roomState.decisions);
    if (action.kind === "pass") {
      return false;
    }
    if (action.kind === "notice") {
      await this.notifySender(roomState, action.text, message.senderId);
      return true;
    }
    if (!isAuthorizedSender(this.authorizedSenders, message.senderId)) {
      await this.notifySender(roomState, OPENCODE_DECISION_MESSAGES.notAuthorized(), message.senderId);
      return true;
    }
    const expectedTurn = roomState.turnOutcome;
    const handled = await this.resolveDecision(roomState, action, expectedTurn);
    if (handled && roomState.turnOutcome === expectedTurn) {
      await this.notifySender(roomState, handled, message.senderId);
    }
    return true;
  }

  // Sends the reply an action resolves to; the notice to post, or null when another path already owns the ask.
  private async resolveDecision(
    roomState: RoomState,
    action: Exclude<ReplyAction, { kind: "pass" } | { kind: "notice" }>,
    expectedTurn: Promise<TurnEndOutcome> | null,
  ): Promise<string | null> {
    const { permissions, questions } = roomState.decisions;
    if (action.kind === "permission") {
      const permission = permissions.tryClaim(action.id);
      if (!permission) {
        return null;
      }
      await this.sendPermissionReply(roomState, permission, action.reply, expectedTurn);
      return OPENCODE_DECISION_MESSAGES.approvalHandled(action.id, action.reply);
    }
    const question = questions.tryClaim(action.id);
    if (!question) {
      return null;
    }
    if (action.kind === "reject-question") {
      await this.sendQuestionReject(roomState, question, expectedTurn);
      return OPENCODE_DECISION_MESSAGES.questionRejected(action.id);
    }
    await this.sendQuestionReply(roomState, question, action.answers, expectedTurn);
    return OPENCODE_DECISION_MESSAGES.questionAnswered(action.id);
  }

  private async notifySender(roomState: RoomState, text: string, senderId: string): Promise<void> {
    if (roomState.tools) {
      await deliverReply(roomState.tools, text, [{ id: senderId }]);
    }
  }

  private async sendPermissionReply(
    roomState: RoomState,
    entry: DecisionEntry<PendingPermission>,
    reply: OpencodeApprovalReply,
    expectedTurn: Promise<TurnEndOutcome> | null,
  ): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.permissions, entry, expectedTurn, (client) => {
      const sessionId = roomState.sessionId;
      if (!sessionId) {
        throw new Error("OpenCode session is not established.");
      }
      return client.replyPermission(sessionId, entry.token, { response: reply });
    });
  }

  private async sendQuestionReply(
    roomState: RoomState,
    entry: DecisionEntry<PendingQuestion>,
    answers: string[][],
    expectedTurn: Promise<TurnEndOutcome> | null,
  ): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.questions, entry, expectedTurn,
      (client) => client.replyQuestion(entry.token, { answers }));
  }

  private async sendQuestionReject(
    roomState: RoomState,
    entry: DecisionEntry<PendingQuestion>,
    expectedTurn: Promise<TurnEndOutcome> | null,
  ): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.questions, entry, expectedTurn,
      (client) => client.rejectQuestion(entry.token));
  }

  // The caller has claimed the ask. A failure while its turn is still current
  // fails that turn; the original error is rethrown for the caller to report.
  private async sendClaimedReply<T>(
    roomState: RoomState,
    registry: DecisionRegistry<T>,
    entry: DecisionEntry<T>,
    expectedTurn: Promise<TurnEndOutcome> | null,
    send: (client: OpencodeClientLike) => Promise<unknown>,
  ): Promise<void> {
    try {
      const client = this.client;
      if (!client) {
        throw new Error("OpenCode client is not initialized.");
      }
      await send(client);
    } catch (error) {
      if (roomState.turnOutcome === expectedTurn) {
        this.failInteraction(roomState, new ProviderTurnFailedError(this.toAgentFailure(error), error));
      }
      throw error;
    }
    registry.forget(entry);
  }

  // For replies no room message is waiting on (auto modes, expiries): a throw
  // here would reach the SSE loop and reconnect it, so the failure is reported
  // to the room once, and only if it failed the turn. True when the reply went through.
  private async replyInBackground<T>(
    roomState: RoomState,
    entry: DecisionEntry<T>,
    send: ReplySender<T>,
  ): Promise<boolean> {
    try {
      await send(entry, roomState.turnOutcome);
      return true;
    } catch (error) {
      const turnError = roomState.pendingDeliveryFailure;
      if (turnError instanceof ProviderTurnFailedError && turnError.cause === error && roomState.tools) {
        await safeSendFailure(roomState.tools, turnError.failure, this.logger, { roomId: roomState.roomId });
      } else {
        this.logger.warn("opencode_adapter.stale_reply_failed", { roomId: roomState.roomId, error });
      }
      return false;
    }
  }

  // Drops every ask still pending in the room; the session it came from is going away.
  private dropDecisions(roomState: RoomState, reason: string): void {
    const { permissions, questions } = roomState.decisions;
    for (const { token } of [...permissions.cancelAll(), ...questions.cancelAll()]) {
      this.logger.info("opencode_adapter.decision_dropped", { roomId: roomState.roomId, requestId: token, reason });
    }
  }

  private async ensureSession(
    roomState: RoomState,
    history: OpencodeSessionState,
  ): Promise<{ sessionId: string; created: boolean; needsHistoryReplay: boolean }> {
    const client = this.client;
    if (!client) {
      throw new Error("OpenCode client is not initialized.");
    }

    // A timed-out turn's abort is fire-and-forget (see handleTurnTimeout) —
    // this room's session may still be settling server-side, so this turn
    // must not resume it, however history or in-memory state would otherwise
    // resolve it. Not cleared here: `startTurn` only clears it once this
    // turn's `promptAsync` actually submits the history replay it forces
    // below — if that submission itself fails, the *next* turn must still
    // force a fresh session and replay history, not silently resume the
    // history-less session just created.
    const forceFreshSession = roomState.forceFreshSession;
    const priorSessionId = roomState.sessionId ?? history.sessionId;
    const restoredSessionId = forceFreshSession ? null : priorSessionId;
    let created = false;
    // True whenever the session this turn ends up with is not the one the
    // room's prior conversation actually lived in — a missing restore target
    // and a forced-fresh replacement are both "OpenCode has no memory of this
    // room's history," so both need it replayed the same way.
    let needsHistoryReplay = false;
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
        needsHistoryReplay = true;
      }
    } else {
      session = await client.createSession({ title: this.buildSessionTitle(roomState.roomId) });
      created = true;
      needsHistoryReplay = forceFreshSession && Boolean(priorSessionId);
    }

    const sessionId = typeof session.id === "string" ? session.id : String(session.id ?? "");
    if (roomState.sessionId && roomState.sessionId !== sessionId) {
      this.roomBySession.delete(roomState.sessionId);
    }
    roomState.sessionId = sessionId;
    this.roomBySession.set(sessionId, roomState.roomId);
    return { sessionId, created, needsHistoryReplay };
  }

  private beginTurn(roomState: RoomState, senderId: string | null): Promise<TurnReleaseOutcome> {
    const turnOutcome = createDeferred<TurnEndOutcome>();
    const releaseWait = createDeferred<TurnReleaseOutcome>();
    roomState.turnOutcome = turnOutcome.promise;
    roomState.resolveTurnOutcome = turnOutcome.resolve;
    roomState.releaseWait = releaseWait.promise;
    roomState.resolveReleaseWait = releaseWait.resolve;
    roomState.pendingMentions = senderId ? [{ id: senderId }] : [];
    roomState.turnTask = null;
    roomState.pendingDeliveryFailure = null;
    roomState.textParts.clear();
    roomState.assistantMessageIds.clear();
    roomState.assistantPartTypes.clear();
    roomState.reportedToolCalls.clear();
    roomState.reportedToolResults.clear();
    roomState.lastErrorMessage = null;
    roomState.sessionErrored = false;
    return releaseWait.promise;
  }

  private async watchTurnCompletion(roomState: RoomState): Promise<void> {
    const turnOutcome = roomState.turnOutcome;
    if (!turnOutcome) {
      return;
    }

    try {
      const outcome = await Promise.race([
        turnOutcome,
        delay(this.config.turnTimeoutMs).then(() => "timed_out" as const),
      ]);
      if (outcome === "cancelled") {
        // A still-live turn's own interaction failed after it had already
        // backgrounded (see `failInteraction`):
        // `releaseWait` was already spent on the earlier "background" release,
        // so this is the only channel left to surface it to `startTurn`'s
        // `void turnTask.catch(...)` observer. A room-cleanup cancellation
        // (`onCleanup`) leaves this unset and returns quietly, as before.
        if (roomState.pendingDeliveryFailure) {
          throw roomState.pendingDeliveryFailure;
        }
        return;
      }
      if (outcome === "timed_out") {
        await this.handleTurnTimeout(roomState);
        return;
      }
      if (roomState.sessionErrored) {
        // OpenCode's own session.error resolved turnOutcome the same way
        // session.idle does (see the event handler), so this is only
        // reachable here, not via the timeout branch below — handle it as
        // its own terminal failure rather than falling into the success path.
        await this.handleSessionError(roomState);
        return;
      }
      await this.deliverFallbackText(roomState);
    } finally {
      this.releaseTurnWait(roomState, { kind: "foreground" });
      this.clearTurnState(roomState, turnOutcome);
    }
  }

  private async handleTurnTimeout(roomState: RoomState): Promise<void> {
    this.abortAndAbandonSession(roomState);
    const failure = agentFailure(this.provider, "OpenCode timed out before completing the turn.", FAILURE_CODE_TIMEOUT);
    await this.reportTerminalFailure(roomState, failure);
  }

  // Best-effort aborts the room's current session server-side (see `abandon`)
  // and unroutes it (see `abandonSession`) so a turn this room has given up
  // on — a timeout, or a failed interactive-prompt delivery — can't leave a
  // late event attaching to the room's next, unrelated turn. Also marks the
  // room to open a fresh session next time, since the abort above is
  // fire-and-forget and this session may still be settling server-side.
  private abortAndAbandonSession(roomState: RoomState): void {
    const client = this.client;
    const abandonedSessionId = roomState.sessionId;
    if (!client || !abandonedSessionId) {
      return;
    }
    roomState.forceFreshSession = true;
    abandon(
      () => client.abortSession(abandonedSessionId),
      (abortError) => {
        this.logger.warn("opencode_adapter.turn_abort_failed", {
          roomId: roomState.roomId,
          sessionId: abandonedSessionId,
          error: abortError,
        });
      },
    );
    this.abandonSession(abandonedSessionId);
  }

  // Unroutes a session this room has given up on (a turn timeout, or a
  // failed interactive-prompt delivery) so a late event the still-settling
  // turn emits afterward — `roomStateForEvent` resolves purely off
  // `roomBySession`, with no notion of "this room moved on" of its own — is
  // dropped instead of attaching to the room's current, unrelated state.
  // Left to `ensureSession`'s own cleanup, this wouldn't happen until the
  // room's *next* turn, which can be arbitrarily later than this point.
  private abandonSession(sessionId: string): void {
    this.roomBySession.delete(sessionId);
  }

  private async handleSessionError(roomState: RoomState): Promise<void> {
    // OpenCode's session.error is a terminal provider failure exactly like
    // turnTimeoutMs expiring: flush whatever text the turn produced first
    // (same as a clean completion would), then fail the turn so
    // PlatformRuntime retries it — independent of fallbackSendAgentText and
    // regardless of any partial text, unlike deliverFallbackText's own
    // best-effort, non-throwing sendFailure for this same message.
    await this.flushTurnText(roomState);
    const failure = agentFailure(this.provider, roomState.lastErrorMessage ?? "OpenCode reported a session error.");
    await this.reportTerminalFailure(roomState, failure);
  }

  private async reportTerminalFailure(roomState: RoomState, failure: AgentFailure): Promise<never> {
    if (roomState.tools) {
      // Best-effort: the failure itself is the truth we already know, and
      // failing to report it must not leave the room's turn wait released
      // forever.
      await safeSendFailure(roomState.tools, failure, this.logger, { roomId: roomState.roomId });
    }
    // Thrown, not returned: PlatformRuntime marks a message failed — and
    // retries it — only when onMessage throws. Matches every other terminal
    // provider failure in this adapter (see ProviderTurnFailedError).
    throw new ProviderTurnFailedError(failure);
  }

  private releaseTurnWait(roomState: RoomState, outcome: TurnReleaseOutcome): void {
    roomState.resolveReleaseWait?.(outcome);
  }

  private finishTurn(roomState: RoomState): void {
    roomState.resolveTurnOutcome?.("completed");
  }

  private failInteraction(
    roomState: RoomState,
    turnError: RecoverableTurnError,
    rejectInteraction?: () => Promise<unknown>,
  ): void {
    // The aborted provider turn can still emit an idle/error event after one
    // of its interactions failed. A retry must own a new session so that late
    // events remain attributable to the abandoned turn.
    this.abortAndAbandonSession(roomState);
    if (rejectInteraction) {
      this.rejectInBackground(roomState, rejectInteraction);
    }
    // The aborted session can answer none of the room's other asks either.
    this.dropDecisions(roomState, "interaction_failed");
    // Reaches `startTurn`'s caller if it's still awaiting `releaseWait` (the
    // turn's first interactive prompt); otherwise a no-op, since that one-shot
    // channel was already spent on an earlier "background" release — in which
    // case `pendingDeliveryFailure` below is what actually surfaces this.
    this.releaseTurnWait(roomState, { kind: "delivery_failed", error: turnError });
    roomState.pendingDeliveryFailure = turnError;
    // Settles a still-running watchTurnCompletion's race quietly (see
    // TurnEndOutcome) instead of letting it run to its timeout branch for a
    // turn that's already ending here.
    roomState.resolveTurnOutcome?.("cancelled");
  }

  private clearTurnState(roomState: RoomState, expectedTurn?: Promise<TurnEndOutcome>): void {
    if (expectedTurn && roomState.turnOutcome !== expectedTurn) {
      return;
    }
    this.dropDecisions(roomState, "turn_ended");
    // Settles a still-running watchTurnCompletion's race (see TurnEndOutcome)
    // — a no-op once that race has already settled through session.idle,
    // session.error, or the timeout, which is exactly what happens when this
    // runs from watchTurnCompletion's own `finally` for the turn it belongs to.
    roomState.resolveTurnOutcome?.("cancelled");
    roomState.turnOutcome = null;
    roomState.resolveTurnOutcome = null;
    // Release a startTurn still waiting while room cleanup cancels its watcher.
    roomState.resolveReleaseWait?.({ kind: "cancelled" });
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

  /**
   * "blocked" and "empty" are both a no-op today, but `deliverFallbackText`
   * needs to tell them apart: only "empty" means the shared guard already
   * passed, so it's safe to go on and send its own fallback message.
   */
  private async flushTurnText(roomState: RoomState): Promise<"sent" | "empty" | "blocked"> {
    if (!roomState.tools || !this.config.fallbackSendAgentText) {
      return "blocked";
    }

    const text = [...roomState.textParts.values()]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();

    if (text.length === 0) {
      return "empty";
    }

    await deliverReply(roomState.tools, text, roomState.pendingMentions);
    roomState.pendingMentions = [];
    return "sent";
  }

  private async deliverFallbackText(roomState: RoomState): Promise<void> {
    const outcome = await this.flushTurnText(roomState);
    if (outcome !== "empty" || !roomState.tools) {
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

  private toAgentFailure(error: unknown): AgentFailure {
    if (error instanceof HttpStatusError) {
      // `error.body` is an untyped provider payload; toDisplayText already
      // handles the string-passthrough/safe-JSON.stringify-with-fallback
      // shape this needs, and never throws on a cycle or a BigInt.
      const body = typeof error.body === "string" ? error.body : toDisplayText(error.body);
      const message = `OpenCode request failed (${error.status}): ${body}`;
      return agentFailure(this.provider, message, String(error.status), error.body);
    }
    return agentFailure(this.provider, `OpenCode failed while processing the message: ${asErrorMessage(error)}`);
  }

  private formatOpenCodeError(error: unknown): string {
    const payload = asOptionalRecord(error);
    if (!payload) {
      return "OpenCode reported an unknown error.";
    }
    const name = typeof payload.name === "string" ? payload.name : "OpenCodeError";
    const message = asNestedMessage(payload.data);
    return message ? `${name}: ${truncate(message)}` : `${name}: OpenCode reported an error.`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

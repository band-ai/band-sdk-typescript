import { AgentFailure, isAuthorizedSender } from "@band-ai/band-sdk-core";
import { SimpleAdapter } from "../../core/simpleAdapter";
import type { MentionInput } from "../../contracts/dtos";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { Logger } from "../../core/logger";
import { resolveLogger } from "../../core/logger";
import { rethrowIfRecoverableTurnFailure, type RecoverableTurnError } from "../../core/errors";
import { Deadline } from "../../core/deadline";
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
import { senderAllowlist, type DecisionEntry, type DecisionRegistry, type Registration } from "../shared/decisions";
import { replyToSender } from "../shared/replyToSender";
import { runUntilReleased } from "../shared/runUntilReleased";
import { asErrorMessage, asNestedMessage, asOptionalRecord, asString, toDisplayText, truncate } from "../shared/coercion";
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
  type OpencodeApprovalReply,
  type PendingPermission,
  type PendingQuestion,
  REPLY_ACTION,
  RoomDecisions,
  type DecisionAction,
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

// "completed" came from OpenCode; "cancelled" exits quietly and skips the timeout abort.
type TurnEndOutcome = "completed" | "cancelled";

// Sends the reply to the ask `entry` claimed.
type ReplySender<T> = (entry: DecisionEntry<T>) => Promise<void>;

// What differs between a permission ask and a question ask.
interface AskLifecycle<T> {
  // Set when the configured mode answers without asking the room.
  autoReply: ReplySender<T> | null;
  timeoutMs: number;
  timeoutReply: ReplySender<T>;
  timedOutNotice: string;
  prompt: string;
  // Rejects the ask server-side when its prompt could not be posted.
  rejectAsk: (client: OpencodeClientLike) => Promise<unknown>;
}

/** One turn's state. A turn is still current while `room.turn` is this object. */
class OpencodeTurn {
  public readonly textParts = new Map<string, string>();
  public readonly assistantMessageIds = new Set<string>();
  public readonly assistantPartTypes = new Map<string, string>();
  public readonly reportedToolCalls = new Set<string>();
  public readonly reportedToolResults = new Set<string>();
  public lastErrorMessage: string | null = null;
  // Only `session.error` fails the session; one message's error only sets `lastErrorMessage`.
  public sessionErrored = false;
  // `watchTurnCompletion` rethrows it, even after the turn backgrounded.
  public failure: RecoverableTurnError | null = null;
  private readonly outcome = createDeferred<TurnEndOutcome>();
  private readonly backgrounded = createDeferred<void>();

  public get ended(): Promise<TurnEndOutcome> {
    return this.outcome.promise;
  }

  /** Resolves once the turn waits on the room, so its request can return. */
  public get released(): Promise<void> {
    return this.backgrounded.promise;
  }

  public end(outcome: TurnEndOutcome): void {
    this.outcome.resolve(outcome);
  }

  // A failed turn reports to its caller, so it never backgrounds.
  public background(): void {
    if (!this.failure) {
      this.backgrounded.resolve();
    }
  }

  public fail(error: RecoverableTurnError): void {
    this.failure = error;
    this.end("cancelled");
  }
}

interface RoomState {
  roomId: string;
  sessionId: string | null;
  tools: AdapterToolsProtocol;
  turn: OpencodeTurn | null;
  // The latest turn's requester; every room message mentions them, since the platform drops one that mentions nobody.
  requesterMentions: MentionInput;
  decisions: RoomDecisions;
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
    const roomState = this.roomStateFor(context.roomId, tools);

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

    if (roomState.turn) {
      await tools.sendEvent(OPENCODE_DECISION_MESSAGES.turnInProgress(), "error");
      return;
    }

    try {
      const client = await this.ensureClientStarted();
      const { sessionId, created, needsHistoryReplay } = await this.ensureSession(roomState, client, history);
      if (this.config.enableTaskEvents && (roomState.persistedSessionId !== sessionId || context.isSessionBootstrap)) {
        await this.emitSessionTaskEvent(roomState, sessionId, created ? "created" : "resumed");
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
    const turn = new OpencodeTurn();
    roomState.turn = turn;
    roomState.requesterMentions = [{ id: message.senderId }];
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

    await runUntilReleased(this.watchTurnCompletion(roomState, turn), turn.released, (error) => {
      this.logger.error("OpenCode turn failed after the request returned", { error, roomId });
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

  private roomStateFor(roomId: string, tools: AdapterToolsProtocol): RoomState {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.tools = tools;
      return existing;
    }

    const created: RoomState = {
      roomId,
      sessionId: null,
      tools,
      turn: null,
      requesterMentions: [],
      decisions: new RoomDecisions(this.logger),
      persistedSessionId: null,
      forceFreshSession: false,
    };
    this.rooms.set(roomId, created);
    return created;
  }

  private async ensureClientStarted(): Promise<OpencodeClientLike> {
    if (this.client) {
      return this.client;
    }
    const client = this.clientFactory(this.config);
    this.client = client;
    this.eventTask = this.runEventLoop();
    await this.registerMcpBackend(client);
    return client;
  }

  // Replies and rejects only run for a live room's asks, and a live room keeps the client up.
  private requireClient(): OpencodeClientLike {
    if (!this.client) {
      throw new Error("OpenCode client is not initialized.");
    }
    return this.client;
  }

  private async startMcpBackend(): Promise<BandMcpBackend> {
    const backend = await this.mcpBackendFactory({
      kind: "http",
      enableMemoryTools: this.config.enableMemoryTools,
      getToolsForRoom: (roomId) => this.rooms.get(roomId)?.tools ?? undefined,
      additionalTools: this.customTools.length > 0 ? buildCustomMcpRegistrations(this.customTools) : undefined,
    });
    this.mcpBackend = backend;
    return backend;
  }

  private async registerMcpBackend(client: OpencodeClientLike): Promise<void> {
    try {
      const backend = await this.startMcpBackend();
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
        await new Deadline(retryDelayMs).expired;
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

    if (eventType === "permission.asked") {
      await this.handlePermissionAsked(roomState, properties);
      return;
    }

    if (eventType === "question.asked") {
      await this.handleQuestionAsked(roomState, properties);
      return;
    }

    // The rest only updates a live turn.
    const turn = roomState.turn;
    if (!turn) {
      return;
    }

    if (eventType === "message.updated") {
      const info = asOptionalRecord(properties.info) ?? {};
      const messageId = typeof info.id === "string" ? info.id : null;
      if (info.role === "assistant" && messageId) {
        turn.assistantMessageIds.add(messageId);
      }
      const error = info.error;
      if (info.role === "assistant" && error) {
        turn.lastErrorMessage = this.formatOpenCodeError(error);
      }
      return;
    }

    if (eventType === "message.part.updated") {
      const part = asOptionalRecord(properties.part);
      if (part) {
        await this.handlePartUpdate(roomState, turn, part);
      }
      return;
    }

    if (eventType === "message.part.delta") {
      this.handlePartDelta(turn, properties);
      return;
    }

    if (eventType === "session.error") {
      turn.lastErrorMessage = this.formatOpenCodeError(properties.error);
      turn.sessionErrored = true;
      turn.end("completed");
      return;
    }

    if (eventType === "session.idle") {
      const hasText = [...turn.textParts.values()].some((value) => value.trim().length > 0);
      if (turn.lastErrorMessage && !hasText) {
        turn.sessionErrored = true;
      }
      turn.end("completed");
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

  private async handlePartUpdate(roomState: RoomState, turn: OpencodeTurn, part: Record<string, unknown>): Promise<void> {
    const partType = String(part.type ?? "");
    const partId = typeof part.id === "string" ? part.id : null;
    const messageId = typeof part.messageID === "string" ? part.messageID : null;
    if (!partId) {
      return;
    }

    if (partType === "text") {
      if (messageId && turn.assistantMessageIds.has(messageId)) {
        turn.assistantPartTypes.set(partId, "text");
        turn.textParts.set(partId, String(part.text ?? ""));
      }
      return;
    }

    if (partType === "reasoning") {
      if (messageId && turn.assistantMessageIds.has(messageId)) {
        turn.assistantPartTypes.set(partId, "reasoning");
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

    if ((status === "pending" || status === "running") && !turn.reportedToolCalls.has(callId)) {
      turn.reportedToolCalls.add(callId);
      await this.reportToolCall(roomState, toolName, state, callId);
      return;
    }

    if ((status === "completed" || status === "error")) {
      if (!turn.reportedToolCalls.has(callId)) {
        turn.reportedToolCalls.add(callId);
        await this.reportToolCall(roomState, toolName, state, callId);
      }
      if (!turn.reportedToolResults.has(callId)) {
        turn.reportedToolResults.add(callId);
        await this.reportToolResult(roomState, state, callId);
      }
    }
  }

  private handlePartDelta(turn: OpencodeTurn, properties: Record<string, unknown>): void {
    if (properties.field !== "text") {
      return;
    }

    const partId = typeof properties.partID === "string" ? properties.partID : null;
    const messageId = typeof properties.messageID === "string" ? properties.messageID : null;
    if (!partId || !messageId || !turn.assistantMessageIds.has(messageId)) {
      return;
    }
    if (turn.assistantPartTypes.get(partId) !== "text") {
      return;
    }

    const deltaText = String(properties.delta ?? "");
    turn.textParts.set(partId, `${turn.textParts.get(partId) ?? ""}${deltaText}`);
  }

  private async handlePermissionAsked(roomState: RoomState, properties: Record<string, unknown>): Promise<void> {
    const pending = toPendingPermission(properties);
    if (!pending) {
      return;
    }
    const { requestId, sessionId } = pending;
    const replyWith = (reply: OpencodeApprovalReply): ReplySender<PendingPermission> =>
      (entry) => this.sendPermissionReply(roomState, entry, reply);
    const { approvalMode, approvalTimeoutReply } = this.config;
    await this.openAsk(roomState, roomState.decisions.permissions, roomState.decisions.registerPermission(pending), {
      autoReply: approvalMode === "manual" ? null : replyWith(approvalMode === "auto_accept" ? REPLY_WORDS.approve : REPLY_WORDS.reject),
      timeoutMs: this.config.approvalWaitTimeoutMs,
      timeoutReply: replyWith(approvalTimeoutReply),
      timedOutNotice: OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, approvalTimeoutReply),
      prompt: OPENCODE_DECISION_MESSAGES.approvalRequested(pending),
      rejectAsk: (client) => client.replyPermission(sessionId, requestId, { response: REPLY_WORDS.reject }),
    });
  }

  private async handleQuestionAsked(roomState: RoomState, properties: Record<string, unknown>): Promise<void> {
    const pending = toPendingQuestion(properties);
    if (!pending) {
      return;
    }
    const { requestId, questions } = pending;
    const rejectAsk = (client: OpencodeClientLike) => client.rejectQuestion(requestId);
    if (questions.length === 0) {
      // Nothing to answer, so nobody would: reject it rather than leave OpenCode blocked on it.
      this.logger.warn("opencode_adapter.empty_question_rejected", { roomId: roomState.roomId, requestId });
      this.rejectInBackground(roomState, () => rejectAsk(this.requireClient()));
      return;
    }
    const reject: ReplySender<PendingQuestion> = (entry) => this.sendQuestionReject(roomState, entry);
    await this.openAsk(roomState, roomState.decisions.questions, roomState.decisions.registerQuestion(pending), {
      autoReply: this.config.questionMode === "auto_reject" ? reject : null,
      timeoutMs: this.config.questionWaitTimeoutMs,
      timeoutReply: reject,
      timedOutNotice: OPENCODE_DECISION_MESSAGES.questionTimedOut(requestId),
      prompt: formatQuestionPrompt(questions, requestId),
      rejectAsk,
    });
  }

  // One ask's lifecycle, whatever its kind: register it, then reply automatically or relay it to the room.
  // `registration` is null for a redelivery whose reply is already in flight.
  private async openAsk<T>(
    roomState: RoomState,
    registry: DecisionRegistry<T>,
    registration: Registration<T> | null,
    ask: AskLifecycle<T>,
  ): Promise<void> {
    if (!registration) {
      return;
    }
    const { entry } = registration;

    if (ask.autoReply) {
      await this.replyInBackground(roomState, registry.tryClaim(entry.token)!, ask.autoReply);
      return;
    }
    registry.startTimeout(entry, ask.timeoutMs, async (expired) => {
      if (await this.replyInBackground(roomState, expired, ask.timeoutReply)) {
        await roomState.tools.sendEvent(ask.timedOutNotice, "error");
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
    const turn = roomState.turn;
    try {
      await roomState.tools.sendMessage(prompt, roomState.requesterMentions);
    } catch (error) {
      // A reply that claimed the ask meanwhile owns it, and so does whatever replaced or removed it.
      if (roomState.turn !== turn || !registry.withdraw(entry)) {
        return;
      }
      this.logger.warn("opencode_adapter.ask_prompt_delivery_failed", {
        roomId: roomState.roomId,
        requestId: entry.token,
        error,
      });
      this.failInteraction(roomState, turn, new DeliveryFailedError(error), () => rejectAsk(this.requireClient()));
      return;
    }
    if (roomState.turn === turn && registry.has(entry.token)) {
      turn?.background();
    }
  }

  private async handleControlMessage(roomState: RoomState, message: PlatformMessage): Promise<boolean> {
    const action = routeReply(message.content, roomState.decisions);
    switch (action.kind) {
      case REPLY_ACTION.pass:
        return false;
      case REPLY_ACTION.notice:
        await this.notifySender(roomState, action.text, message.senderId);
        return true;
      default:
        await this.applyDecisionReply(roomState, action, message.senderId);
        return true;
    }
  }

  private async applyDecisionReply(roomState: RoomState, action: DecisionAction, senderId: string): Promise<void> {
    if (!isAuthorizedSender(this.authorizedSenders, senderId)) {
      await this.notifySender(roomState, OPENCODE_DECISION_MESSAGES.notAuthorized(), senderId);
      return;
    }
    const turn = roomState.turn;
    const handled = await this.resolveDecision(roomState, action);
    if (handled && roomState.turn === turn) {
      await this.notifySender(roomState, handled, senderId);
    }
  }

  // Sends the reply an action resolves to; the notice to post, or null when another path already owns the ask.
  private async resolveDecision(roomState: RoomState, action: DecisionAction): Promise<string | null> {
    const { permissions, questions } = roomState.decisions;
    switch (action.kind) {
      case REPLY_ACTION.permission:
        return claimAndSend(permissions, action.id, OPENCODE_DECISION_MESSAGES.approvalHandled(action.id, action.reply),
          (entry) => this.sendPermissionReply(roomState, entry, action.reply));
      case REPLY_ACTION.rejectQuestion:
        return claimAndSend(questions, action.id, OPENCODE_DECISION_MESSAGES.questionRejected(action.id),
          (entry) => this.sendQuestionReject(roomState, entry));
      case REPLY_ACTION.answerQuestion:
        return claimAndSend(questions, action.id, OPENCODE_DECISION_MESSAGES.questionAnswered(action.id),
          (entry) => this.sendQuestionReply(roomState, entry, action.answers));
    }
  }

  private async notifySender(roomState: RoomState, text: string, senderId: string): Promise<void> {
    await replyToSender(roomState.tools, text, senderId);
  }

  private async sendPermissionReply(
    roomState: RoomState,
    entry: DecisionEntry<PendingPermission>,
    reply: OpencodeApprovalReply,
  ): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.permissions, entry, (client) =>
      client.replyPermission(entry.payload.sessionId, entry.token, { response: reply }),
    );
  }

  private async sendQuestionReply(
    roomState: RoomState,
    entry: DecisionEntry<PendingQuestion>,
    answers: string[][],
  ): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.questions, entry,
      (client) => client.replyQuestion(entry.token, { answers }));
  }

  private async sendQuestionReject(roomState: RoomState, entry: DecisionEntry<PendingQuestion>): Promise<void> {
    await this.sendClaimedReply(roomState, roomState.decisions.questions, entry,
      (client) => client.rejectQuestion(entry.token));
  }

  // The caller has claimed the ask. A failure while its turn is still current
  // fails and reports that turn, throwing the reported error; any other failure is rethrown as is.
  private async sendClaimedReply<T>(
    roomState: RoomState,
    registry: DecisionRegistry<T>,
    entry: DecisionEntry<T>,
    send: (client: OpencodeClientLike) => Promise<unknown>,
  ): Promise<void> {
    const turn = roomState.turn;
    try {
      await send(this.requireClient());
    } catch (error) {
      if (roomState.turn !== turn) {
        throw error;
      }
      throw await this.failTurnOnReply(roomState, turn, error);
    }
    registry.forget(entry);
  }

  private async failTurnOnReply(roomState: RoomState, turn: OpencodeTurn | null, error: unknown): Promise<ProviderTurnFailedError> {
    const turnError = new ProviderTurnFailedError(this.toAgentFailure(error), error);
    this.failInteraction(roomState, turn, turnError);
    await safeSendFailure(roomState.tools, turnError.failure, this.logger, { roomId: roomState.roomId, sessionId: roomState.sessionId });
    return turnError;
  }

  // For replies no room message is waiting on (auto modes, expiries): a throw
  // here would reach the SSE loop and reconnect it. True when the reply went through.
  private async replyInBackground<T>(
    roomState: RoomState,
    entry: DecisionEntry<T>,
    send: ReplySender<T>,
  ): Promise<boolean> {
    try {
      await send(entry);
      return true;
    } catch (error) {
      // A failure that failed the turn has already been reported.
      if (!(error instanceof ProviderTurnFailedError)) {
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
    client: OpencodeClientLike,
    history: OpencodeSessionState,
  ): Promise<{ sessionId: string; created: boolean; needsHistoryReplay: boolean }> {
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

    const sessionId = asString(session.id);
    if (!sessionId) {
      throw new Error("OpenCode returned a session without an id.");
    }
    if (roomState.sessionId && roomState.sessionId !== sessionId) {
      this.roomBySession.delete(roomState.sessionId);
    }
    roomState.sessionId = sessionId;
    this.roomBySession.set(sessionId, roomState.roomId);
    return { sessionId, created, needsHistoryReplay };
  }

  private async watchTurnCompletion(roomState: RoomState, turn: OpencodeTurn): Promise<void> {
    try {
      using watchdog = new Deadline(this.config.turnTimeoutMs);
      const outcome = await Promise.race([turn.ended, watchdog.expired.then(() => "timed_out" as const)]);
      if (outcome === "cancelled") {
        // A failed interaction ended the turn; room cleanup leaves this null.
        if (turn.failure) {
          throw turn.failure;
        }
        return;
      }
      if (outcome === "timed_out") {
        await this.handleTurnTimeout(roomState);
        return;
      }
      if (turn.sessionErrored) {
        // OpenCode's own session.error ends the turn the same way
        // session.idle does (see the event handler), so this is only
        // reachable here, not via the timeout branch below — handle it as
        // its own terminal failure rather than falling into the success path.
        await this.handleSessionError(roomState, turn);
        return;
      }
      await this.deliverFallbackText(roomState, turn);
    } finally {
      this.clearTurnState(roomState, turn);
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

  private async handleSessionError(roomState: RoomState, turn: OpencodeTurn): Promise<void> {
    // OpenCode's session.error is a terminal provider failure exactly like
    // turnTimeoutMs expiring: flush whatever text the turn produced first
    // (same as a clean completion would), then fail the turn so
    // PlatformRuntime retries it — independent of fallbackSendAgentText and
    // regardless of any partial text, unlike deliverFallbackText's own
    // best-effort, non-throwing sendFailure for this same message.
    await this.flushTurnText(roomState, turn);
    const failure = agentFailure(this.provider, turn.lastErrorMessage ?? "OpenCode reported a session error.");
    await this.reportTerminalFailure(roomState, failure);
  }

  private async reportTerminalFailure(roomState: RoomState, failure: AgentFailure): Promise<never> {
    // Best-effort: failing to report the failure must not leave the room's turn wait released forever.
    await safeSendFailure(roomState.tools, failure, this.logger, { roomId: roomState.roomId });
    // Thrown, not returned: PlatformRuntime marks a message failed — and
    // retries it — only when onMessage throws. Matches every other terminal
    // provider failure in this adapter (see ProviderTurnFailedError).
    throw new ProviderTurnFailedError(failure);
  }

  private failInteraction(
    roomState: RoomState,
    turn: OpencodeTurn | null,
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
    // `watchTurnCompletion` rethrows it, without its timeout branch.
    turn?.fail(turnError);
  }

  // Ends `turn` if it is still the room's; by default whatever turn the room holds.
  private clearTurnState(roomState: RoomState, turn = roomState.turn): void {
    if (roomState.turn !== turn) {
      return;
    }
    this.dropDecisions(roomState, "turn_ended");
    // Settles a still-running `watchTurnCompletion` quietly; a no-op once it has settled.
    turn?.end("cancelled");
    roomState.turn = null;
  }

  private async emitSessionTaskEvent(roomState: RoomState, sessionId: string, status: "created" | "resumed"): Promise<void> {
    const createdAt = new Date().toISOString();
    await roomState.tools.sendEvent(
      `OpenCode session ${status}: \`${sessionId}\``,
      "task",
      {
        opencode_session_id: sessionId,
        opencode_room_id: roomState.roomId,
        opencode_created_at: createdAt,
      },
    );
    roomState.persistedSessionId = sessionId;
  }

  /**
   * "blocked" and "empty" are both a no-op today, but `deliverFallbackText`
   * needs to tell them apart: only "empty" means the shared guard already
   * passed, so it's safe to go on and send its own fallback message.
   */
  private async flushTurnText(roomState: RoomState, turn: OpencodeTurn): Promise<"sent" | "empty" | "blocked"> {
    if (!this.config.fallbackSendAgentText) {
      return "blocked";
    }

    const text = [...turn.textParts.values()]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();

    if (text.length === 0) {
      return "empty";
    }

    await deliverReply(roomState.tools, text, roomState.requesterMentions);
    return "sent";
  }

  private async deliverFallbackText(roomState: RoomState, turn: OpencodeTurn): Promise<void> {
    const outcome = await this.flushTurnText(roomState, turn);
    if (outcome !== "empty") {
      return;
    }

    await deliverReply(
      roomState.tools,
      "OpenCode completed the turn without a text reply.",
      roomState.requesterMentions,
    );
  }

  private async reportToolCall(
    roomState: RoomState,
    toolName: string,
    state: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
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

/** Sends `id`'s reply and returns `notice`, or null when someone else already claimed it. */
async function claimAndSend<T>(
  registry: DecisionRegistry<T>,
  id: string,
  notice: string,
  send: (entry: DecisionEntry<T>) => Promise<void>,
): Promise<string | null> {
  const entry = registry.tryClaim(id);
  if (!entry) {
    return null;
  }
  await send(entry);
  return notice;
}

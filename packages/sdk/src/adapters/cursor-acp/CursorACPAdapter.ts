import type { PermissionOption } from "@agentclientprotocol/sdk";

import { isAuthorizedSender } from "@band-ai/band-sdk-core";

import { createDeferred } from "../../core/deferred";
import { resolveLogger, type Logger } from "../../core/logger";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { PlatformMessage } from "../../runtime/types";
import type { ACPClientSessionState } from "../../converters/acp-client";
import {
  ACPClientAdapter,
  type ACPClientExtensionContext,
  type ACPClientExtensionHandler,
  type ACPClientStdioOptions,
  type ACPPermissionRequest,
} from "../acp";
import type { ACPPermissionAbandonReason, ACPPermissionEndReason, CollectedChunk } from "../acp/types";
import { abandon } from "../shared/abandon";
import { DecisionRegistry, senderAllowlist, TIMED_OUT, type DecisionEntry } from "../shared/decisions";
import { stripLeadingMentions } from "../../runtime/formatters";
import { CURSOR_COMMAND, CURSOR_DECISION_MESSAGES, CURSOR_VERB, DECISION_KIND, type DecisionKind } from "./messages";

export const DEFAULT_CURSOR_ACP_COMMAND = ["agent", "acp"] as const;
export const DEFAULT_CURSOR_DECISION_TIMEOUT_MS = 300_000;
export const DEFAULT_CURSOR_MAX_PENDING_DECISIONS = 10;

export type CursorApprovalMode = "manual" | "autoAccept" | "autoDecline";
export type CursorQuestionMode = "manual" | "autoFirst" | "autoCancel";
export type CursorPlanMode = "manual" | "autoAccept" | "autoDecline";

export interface CursorACPAdapterOptions extends Omit<ACPClientStdioOptions, "command" | "authMethod" | "env" | "extensionHandler" | "resolvePermission"> {
  command?: string | string[];
  env?: Record<string, string>;
  apiKey?: string;
  authToken?: string;
  approvalMode?: CursorApprovalMode;
  questionMode?: CursorQuestionMode;
  planMode?: CursorPlanMode;
  decisionTimeoutMs?: number;
  maxPendingDecisions?: number;
  decisionAuthorizedSenders?: readonly string[];
}

// Why a decision ended without an answer. `timeout` is shared with the ACP base class, whose own permission timeout aborts with it.
const END_REASON = {
  timeout: "timeout" satisfies ACPPermissionAbandonReason,
  turnFinished: "turn_finished",
  roomCleanup: "room_cleanup",
  stopped: "stopped",
  evicted: "evicted",
  promptDeliveryFailed: "prompt_delivery_failed",
} as const;
// A permission offers its options as a single choice under this key.
const PERMISSION_CHOICE = DECISION_KIND.permission;

type EndReason = (typeof END_REASON)[keyof typeof END_REASON] | ACPPermissionEndReason;

interface CursorTurn {
  messageId: string;
  roomId: string;
  sessionId?: string;
  tools: AdapterToolsProtocol;
  requesterId: string;
  // Hands the room's message queue back to the platform, so a reply to this turn's decision can reach the adapter.
  releaseRoom: () => void;
}

// What a decision asks for; the rest of `PendingDecision` comes from its turn.
interface DecisionSpec {
  kind: DecisionKind;
  roomId: string;
  choices: Map<string, readonly string[]>;
  multiSelect: ReadonlySet<string>;
}

interface PendingDecision extends DecisionSpec {
  tools: AdapterToolsProtocol;
  requesterId: string;
  resolve(value: unknown): void;
}

class CursorExtensions implements ACPClientExtensionHandler {
  private adapter: CursorACPAdapter | null = null;
  private readonly todosBySession = new Map<string, Map<string, CursorTodo>>();

  public bind(adapter: CursorACPAdapter): void {
    this.adapter = adapter;
  }

  public async resolvePermission(
    request: ACPPermissionRequest,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    return this.adapter?.resolveCursorPermission(request, signal);
  }

  public extensionSessionId(): string | null {
    return this.adapter?.extensionSessionId() ?? null;
  }

  public async extMethod(
    method: string,
    params: Record<string, unknown>,
    context: ACPClientExtensionContext,
  ): Promise<Record<string, unknown> | null> {
    return this.adapter?.resolveExtension(method, params, context.sessionId) ?? null;
  }

  public async extNotification(
    method: string,
    params: Record<string, unknown>,
    context: ACPClientExtensionContext,
  ): Promise<readonly CollectedChunk[] | void> {
    const sessionId = context.sessionId ?? this.extensionSessionId();
    if (!sessionId) {
      return;
    }
    if (method === "cursor/update_todos") {
      const content = this.updateTodos(sessionId, params);
      if (!content) {
        return;
      }
      return [{ chunkType: "plan", content, metadata: { cursor_todos: true }, streamed: false }];
    }
    if (method === "cursor/task") {
      const description = stringValue(params.description);
      if (!description) {
        return [];
      }
      const subagentType = stringValue(params.subagentType) ?? "unspecified";
      const model = stringValue(params.model);
      const suffix = model ? ` (${model})` : "";
      return [{ chunkType: "plan", content: `[Cursor ${subagentType} task] ${description}${suffix}`, metadata: {}, streamed: false }];
    }
    if (method === "cursor/generate_image") {
      const description = stringValue(params.description);
      if (!description) {
        return [];
      }
      const filePath = stringValue(params.filePath);
      return [{ chunkType: "plan", content: `[Cursor generated image] ${description}${filePath ? ` → ${filePath}` : ""}`, metadata: {}, streamed: false }];
    }
  }

  public forgetSession(sessionId: string): void {
    this.todosBySession.delete(sessionId);
  }

  public clearSessions(): void {
    this.todosBySession.clear();
  }

  private updateTodos(sessionId: string, params: Record<string, unknown>): string | undefined {
    const todos = parseTodos(params.todos);
    if (params.merge === true) {
      const current = this.todosBySession.get(sessionId) ?? new Map<string, CursorTodo>();
      for (const todo of todos) {
        current.set(todo.id, todo);
      }
      this.todosBySession.set(sessionId, current);
    } else {
      this.todosBySession.set(sessionId, new Map(todos.map((todo) => [todo.id, todo])));
    }
    const current = this.todosBySession.get(sessionId);
    return current && current.size > 0
      ? [...current.values()].map((todo) => `- [${todoMark(todo.status)}] ${todo.content}`).join("\n")
      : undefined;
  }
}

export class CursorACPAdapter extends ACPClientAdapter {
  protected readonly provider = "cursor-acp";
  private readonly approvalMode: CursorApprovalMode;
  private readonly questionMode: CursorQuestionMode;
  private readonly planMode: CursorPlanMode;
  private readonly decisionTimeoutMs: number;
  private readonly authorizedSenders: ReadonlySet<string> | null;
  private readonly decisionLogger: Logger;
  private readonly extensions: CursorExtensions;
  private readonly turns = new Map<string, CursorTurn>();
  private readonly decisions: DecisionRegistry<PendingDecision>;
  private activeTurn: CursorTurn | null = null;
  private turnTail: Promise<void> = Promise.resolve();

  public constructor(options: CursorACPAdapterOptions = {}) {
    const extensions = new CursorExtensions();
    validateOptions(options);
    const env = cursorEnv(options);
    super({
      ...options,
      env,
      command: options.command ?? [...DEFAULT_CURSOR_ACP_COMMAND],
      authMethod: "cursor_login",
      extensionHandler: extensions,
      resolvePermission: (request, signal) => extensions.resolvePermission(request, signal),
    });
    extensions.bind(this);
    this.extensions = extensions;
    this.approvalMode = options.approvalMode ?? "manual";
    this.questionMode = options.questionMode ?? "manual";
    this.planMode = options.planMode ?? "manual";
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_CURSOR_DECISION_TIMEOUT_MS;
    this.authorizedSenders = senderAllowlist(options.decisionAuthorizedSenders);
    this.decisionLogger = resolveLogger(options.logger);
    this.decisions = new DecisionRegistry({
      maxPending: options.maxPendingDecisions ?? DEFAULT_CURSOR_MAX_PENDING_DECISIONS,
      logger: this.decisionLogger,
    });
  }

  public override async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: ACPClientSessionState,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (await this.handleControl(message, tools, context.roomId)) {
      return;
    }
    if (this.turns.has(context.roomId)) {
      await tools.sendMessage(CURSOR_DECISION_MESSAGES.turnInProgress(), [{ id: message.senderId }]);
      return;
    }
    const released = createDeferred<void>();
    const turn: CursorTurn = { messageId: message.id, roomId: context.roomId, tools, requesterId: message.senderId, releaseRoom: released.resolve };
    // Removing a room waits on its message, so one queued behind another room's turn must not hold it.
    const queued = this.turns.size > 0;
    this.turns.set(context.roomId, turn);
    const run = this.withCursorTurnLock(async () => {
      if (this.turns.get(turn.roomId) === turn) {
        await super.onMessage(message, tools, history, participantsMessage, contactsMessage, context);
      }
    }).finally(() => this.forgetTurn(turn));
    if (queued) {
      turn.releaseRoom();
    }
    await this.untilRoomReleased(turn, run, released.promise);
  }

  // The platform hands a room one message at a time, so a turn that asks the room something runs on detached.
  private async untilRoomReleased(turn: CursorTurn, run: Promise<void>, released: Promise<void>): Promise<void> {
    void released.then(() => run.catch((error: unknown) => {
      this.decisionLogger.warn("cursor_acp.released_turn_failed", { roomId: turn.roomId, error: String(error) });
    }));
    await Promise.race([run, released]);
  }

  private forgetTurn(turn: CursorTurn): void {
    if (this.turns.get(turn.roomId) === turn) {
      this.turns.delete(turn.roomId);
    }
  }

  protected override async onAcpTurnStarted(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const turn = this.turns.get(context.roomId);
    if (turn?.messageId === message.id) {
      this.activeTurn = turn;
    }
  }

  protected override async onAcpSessionReady(
    message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    context: { isSessionBootstrap: boolean; roomId: string },
    sessionId: string,
  ): Promise<void> {
    const turn = this.turns.get(context.roomId);
    if (turn?.messageId === message.id) {
      turn.sessionId = sessionId;
    }
  }

  protected override async onAcpTurnFinished(
    message: PlatformMessage,
    _tools: AdapterToolsProtocol,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const turn = this.turns.get(context.roomId);
    if (turn?.messageId === message.id) {
      this.turns.delete(context.roomId);
      this.cancelRoom(context.roomId, END_REASON.turnFinished);
    }
    if (this.activeTurn?.messageId === message.id) {
      this.activeTurn = null;
    }
  }

  public override async onCleanup(roomId: string): Promise<void> {
    const sessionId = this.turns.get(roomId)?.sessionId;
    this.cancelRoom(roomId, END_REASON.roomCleanup);
    this.turns.delete(roomId);
    if (this.activeTurn?.roomId === roomId) {
      this.activeTurn = null;
    }
    await super.onCleanup(roomId);
    if (sessionId) {
      this.extensions.forgetSession(sessionId);
    }
  }

  public override async stop(): Promise<void> {
    this.endUnanswered(this.decisions.cancelAll(), END_REASON.stopped);
    this.turns.clear();
    this.activeTurn = null;
    this.extensions.clearSessions();
    await super.stop();
  }

  public async resolveExtension(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): Promise<Record<string, unknown>> {
    const roomId = sessionId ? this.roomIdForSession(sessionId) : this.activeTurn?.roomId;
    const turn = roomId ? this.turns.get(roomId) : undefined;
    if (!turn || (sessionId && turn.sessionId !== sessionId)) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (method === "cursor/ask_question") {
      return this.resolveQuestion(turn.roomId, turn, params);
    }
    if (method === "cursor/create_plan") {
      return this.resolvePlan(turn.roomId, turn, params);
    }
    return {};
  }

  public async resolveCursorPermission(request: ACPPermissionRequest, signal: AbortSignal): Promise<string | undefined> {
    if (this.approvalMode === "autoAccept") {
      return allowOption(request.options)?.optionId;
    }
    if (this.approvalMode === "autoDecline") {
      return undefined;
    }
    const turn = this.turns.get(request.roomId);
    if (!turn) {
      return undefined;
    }
    const options = request.options.map((option) => option.optionId);
    const token = await this.waitForDecision(turn, { kind: DECISION_KIND.permission, roomId: request.roomId, choices: new Map([[PERMISSION_CHOICE, options]]), multiSelect: new Set() }, CURSOR_DECISION_MESSAGES.permissionPrompt, signal);
    return typeof token === "string" && options.includes(token) ? token : undefined;
  }

  public extensionSessionId(): string | null {
    return this.activeTurn?.sessionId ?? null;
  }

  private async resolveQuestion(roomId: string, turn: CursorTurn, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const questions = questionChoices(params.questions);
    if (questions.choices.size === 0) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (this.questionMode === "autoCancel") {
      return { outcome: { outcome: "cancelled" } };
    }
    if (this.questionMode === "autoFirst") {
      return answered(Object.fromEntries([...questions.choices].map(([id, options]) => [id, [options[0]]])));
    }
    const result = await this.waitForDecision(turn, { kind: DECISION_KIND.question, roomId, ...questions }, CURSOR_DECISION_MESSAGES.questionPrompt);
    return isRecord(result) ? result : { outcome: { outcome: "cancelled" } };
  }

  private async resolvePlan(roomId: string, turn: CursorTurn, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.planMode === "autoAccept") {
      return { outcome: { outcome: "accepted" } };
    }
    if (this.planMode === "autoDecline") {
      return { outcome: { outcome: "rejected" } };
    }
    const title = stringValue(params.title) ?? "Cursor plan";
    const result = await this.waitForDecision(turn, { kind: DECISION_KIND.plan, roomId, choices: new Map(), multiSelect: new Set() }, (token) => CURSOR_DECISION_MESSAGES.planPrompt(title, token));
    return isRecord(result) ? result : { outcome: { outcome: "cancelled" } };
  }

  private async waitForDecision(turn: CursorTurn, spec: DecisionSpec, prompt: (token: string) => string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return undefined;
    }
    const answer = createDeferred<unknown>();
    const registration = this.decisions.registerMinted(
      { ...spec, tools: turn.tools, requesterId: turn.requesterId, resolve: answer.resolve },
      { roomId: spec.roomId },
    );
    this.endUnanswered(registration.removed, END_REASON.evicted);
    const { entry } = registration;
    if (signal) {
      // The ACP base class aborts on its own timeout too; the claim guard lets only one of them end the decision.
      signal.addEventListener("abort", () => this.abandonDecision(entry, signal.reason as ACPPermissionEndReason), { once: true });
    }
    try {
      await turn.tools.sendMessage(prompt(entry.token), [turn.requesterId]);
    } catch (error) {
      this.decisionLogger.warn("cursor_acp.decision_prompt_delivery_failed", { roomId: spec.roomId, kind: spec.kind, error: String(error) });
      // A reply that claimed it meanwhile owns the answer; wait for it.
      if (this.abandonDecision(entry, END_REASON.promptDeliveryFailed)) {
        return undefined;
      }
    } finally {
      // Whether or not the prompt landed, the room's reply must not queue behind this turn.
      turn.releaseRoom();
    }
    const result = await this.decisions.wait(entry, answer.promise, { timeoutMs: this.decisionTimeoutMs });
    if (result !== TIMED_OUT) {
      return result;
    }
    this.endTimedOut(entry);
    return undefined;
  }

  // Ends a decision nobody has claimed; false when its claimant owns it.
  private abandonDecision(entry: DecisionEntry<PendingDecision>, reason: EndReason): boolean {
    if (!this.decisions.withdraw(entry)) {
      return false;
    }
    switch (reason) {
      case END_REASON.timeout:
        this.endTimedOut(entry);
        break;
      default:
        this.endUnanswered([entry], reason);
    }
    return true;
  }

  // Both deadlines, the registry's and the ACP base class's, tell the requester.
  private endTimedOut(entry: DecisionEntry<PendingDecision>): void {
    const { token, payload: decision } = entry;
    this.endUnanswered([entry], END_REASON.timeout);
    abandon(
      () => decision.tools.sendMessage(CURSOR_DECISION_MESSAGES.timedOut(decision.kind, token), [decision.requesterId]),
      (error) => {
        this.decisionLogger.warn("cursor_acp.decision_timeout_notice_failed", { roomId: decision.roomId, kind: decision.kind, error: String(error) });
      },
    );
  }

  // Whoever removes an unclaimed ask resolves it.
  private endUnanswered(entries: readonly DecisionEntry<PendingDecision>[], reason: EndReason): void {
    for (const { payload: decision } of entries) {
      decision.resolve(undefined);
      this.decisionLogger.info("cursor_acp.decision_ended", { roomId: decision.roomId, kind: decision.kind, reason });
    }
  }

  private async handleControl(message: PlatformMessage, tools: AdapterToolsProtocol, roomId: string): Promise<boolean> {
    const words = stripLeadingMentions(message.content).trim().split(/\s+/);
    if (words[0]?.toLowerCase() !== CURSOR_COMMAND) {
      return false;
    }
    // The platform drops a message that mentions nobody, so every reply goes to its sender.
    await tools.sendMessage(this.controlReply(words, message.senderId, roomId), [{ id: message.senderId }]);
    return true;
  }

  private controlReply(words: string[], senderId: string, roomId: string): string {
    if (words.length === 1 || words[1]?.toLowerCase() === CURSOR_VERB.list) {
      const entries = this.decisions.unclaimedInRoom(roomId).map(({ token, payload }) => `\`${token}\` (${payload.kind})`);
      return CURSOR_DECISION_MESSAGES.pendingList(entries);
    }
    const [_, action = "", token = "", ...args] = words;
    const decision = this.decisions.get(token);
    if (!decision || decision.roomId !== roomId) {
      return CURSOR_DECISION_MESSAGES.notPending(token);
    }
    if (!isAuthorizedSender(this.authorizedSenders, senderId)) {
      return CURSOR_DECISION_MESSAGES.notAuthorized();
    }
    const result = commandResult(action, args, decision);
    if (result === null) {
      return CURSOR_DECISION_MESSAGES.invalidCommand(decision.kind, token);
    }
    if (!this.decisions.tryClaim(token)) {
      return CURSOR_DECISION_MESSAGES.notPending(token);
    }
    decision.resolve(result);
    return CURSOR_DECISION_MESSAGES.resolved(decision.kind, token);
  }

  private cancelRoom(roomId: string, reason: EndReason): void {
    this.endUnanswered(this.decisions.cancelRoom(roomId), reason);
  }

  private async withCursorTurnLock<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.turnTail.then(run, run);
    this.turnTail = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

interface CursorTodo {
  id: string;
  content: string;
  status: string;
}

function cursorEnv(options: CursorACPAdapterOptions): Record<string, string> | undefined {
  const env = { ...options.env };
  if (options.apiKey) env.CURSOR_API_KEY ??= options.apiKey;
  if (options.authToken) env.CURSOR_AUTH_TOKEN ??= options.authToken;
  return Object.keys(env).length > 0 ? env : undefined;
}

function validateOptions(options: CursorACPAdapterOptions): void {
  if (options.apiKey && options.authToken) throw new Error("set either apiKey or authToken, not both");
  if (Array.isArray(options.command) && options.command.length === 0) throw new Error("Cursor ACP command must not be empty");
  if (options.decisionTimeoutMs !== undefined && (!Number.isFinite(options.decisionTimeoutMs) || options.decisionTimeoutMs <= 0)) throw new Error("decisionTimeoutMs must be a positive finite number");
  if (options.maxPendingDecisions !== undefined && (!Number.isInteger(options.maxPendingDecisions) || options.maxPendingDecisions <= 0)) throw new Error("maxPendingDecisions must be a positive integer");
}

function allowOption(options: readonly PermissionOption[]): PermissionOption | undefined {
  return options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
}

function questionChoices(value: unknown): { choices: Map<string, readonly string[]>; multiSelect: Set<string> } {
  const choices = new Map<string, readonly string[]>();
  const multiSelect = new Set<string>();
  if (!Array.isArray(value)) return { choices, multiSelect };
  for (const question of value) {
    if (!isRecord(question) || typeof question.id !== "string" || !Array.isArray(question.options)) continue;
    const options = question.options.filter(isRecord).map((option) => stringValue(option.id)).filter((id): id is string => !!id);
    if (options.length === 0) continue;
    choices.set(question.id, options);
    if (question.allowMultiple === true) multiSelect.add(question.id);
  }
  return { choices, multiSelect };
}

function commandResult(action: string, args: readonly string[], decision: PendingDecision): unknown {
  switch (decision.kind) {
    case DECISION_KIND.permission:
      return permissionResult(action, args, decision);
    case DECISION_KIND.plan:
      return planResult(action);
    case DECISION_KIND.question:
      return action === CURSOR_VERB.answer ? questionResult(args, decision) : null;
  }
}

function permissionResult(action: string, args: readonly string[], decision: PendingDecision): unknown {
  switch (action) {
    case CURSOR_VERB.deny:
      return undefined;
    case CURSOR_VERB.select: {
      const [choice, ...extra] = args;
      return choice && extra.length === 0 && decision.choices.get(PERMISSION_CHOICE)!.includes(choice) ? choice : null;
    }
    default:
      return null;
  }
}

function planResult(action: string): unknown {
  switch (action) {
    case CURSOR_VERB.accept:
      return { outcome: { outcome: "accepted" } };
    case CURSOR_VERB.reject:
      return { outcome: { outcome: "rejected" } };
    default:
      return null;
  }
}

function questionResult(args: readonly string[], decision: PendingDecision): unknown {
  const selected: Record<string, string[]> = {};
  for (const argument of args) {
    const [id, raw] = argument.split("=", 2);
    const values = raw?.split(",") ?? [];
    const offered = id ? decision.choices.get(id) : undefined;
    if (!id || !offered || selected[id] || values.length === 0 || (values.length > 1 && !decision.multiSelect.has(id)) || values.some((value) => !offered.includes(value))) return null;
    selected[id] = values;
  }
  return Object.keys(selected).length === decision.choices.size ? answered(selected) : null;
}

function answered(selected: Record<string, readonly string[]>): Record<string, unknown> {
  return { outcome: { outcome: "answered", answers: Object.entries(selected).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })) } };
}

function parseTodos(value: unknown): CursorTodo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((todo) => {
    if (!isRecord(todo)) return [];
    const id = stringValue(todo.id);
    const content = stringValue(todo.content);
    const status = stringValue(todo.status);
    return id && content && status ? [{ id, content, status }] : [];
  });
}

function todoMark(status: string): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "~";
    case "cancelled":
      return "-";
    default:
      return " ";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

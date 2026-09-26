import type { PermissionOption } from "@agentclientprotocol/sdk";

import { isAuthorizedSender } from "@band-ai/band-sdk-core";

import { createDeferred, type Deferred } from "../../core/deferred";
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
import { runUntilReleased } from "../shared/runUntilReleased";
import { commandWords } from "../../runtime/formatters";
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
  choices: Map<string, readonly string[]>;
  multiSelect: ReadonlySet<string>;
}

// A permission's option id, or an extension method's result; undefined denies or cancels.
type DecisionAnswer = string | Record<string, unknown> | undefined;

interface PendingDecision extends DecisionSpec {
  roomId: string;
  tools: AdapterToolsProtocol;
  requesterId: string;
  answer: Deferred<DecisionAnswer>;
}

// A room command that does not fit its decision.
const INVALID: unique symbol = Symbol("invalid decision command");

const CANCELLED = { outcome: { outcome: "cancelled" } };

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
    await runUntilReleased(run, released.promise, (error) => {
      this.decisionLogger.warn("cursor_acp.released_turn_failed", { roomId: turn.roomId, error: String(error) });
    });
  }

  // Only `turn` itself goes: its room may already hold a newer turn.
  private forgetTurn(turn: CursorTurn): void {
    if (this.turns.get(turn.roomId) === turn) {
      this.turns.delete(turn.roomId);
    }
    if (this.activeTurn === turn) {
      this.activeTurn = null;
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
    // Forgotten now, so a late Cursor ask finds no turn to attach to.
    const turn = this.turns.get(context.roomId);
    if (turn?.messageId === message.id) {
      this.forgetTurn(turn);
      this.cancelRoom(context.roomId, END_REASON.turnFinished);
    }
  }

  public override async onCleanup(roomId: string): Promise<void> {
    const turn = this.turns.get(roomId);
    this.cancelRoom(roomId, END_REASON.roomCleanup);
    if (turn) {
      this.forgetTurn(turn);
    }
    await super.onCleanup(roomId);
    if (turn?.sessionId) {
      this.extensions.forgetSession(turn.sessionId);
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
      return CANCELLED;
    }
    if (method === "cursor/ask_question") {
      return this.resolveQuestion(turn, params);
    }
    if (method === "cursor/create_plan") {
      return this.resolvePlan(turn, params);
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
    const token = await this.waitForDecision(turn, { kind: DECISION_KIND.permission, choices: new Map([[PERMISSION_CHOICE, options]]), multiSelect: new Set() }, CURSOR_DECISION_MESSAGES.permissionPrompt, signal);
    return typeof token === "string" && options.includes(token) ? token : undefined;
  }

  public extensionSessionId(): string | null {
    return this.activeTurn?.sessionId ?? null;
  }

  private async resolveQuestion(turn: CursorTurn, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const questions = questionChoices(params.questions);
    if (questions.choices.size === 0 || this.questionMode === "autoCancel") {
      return CANCELLED;
    }
    if (this.questionMode === "autoFirst") {
      return answered(Object.fromEntries([...questions.choices].map(([id, options]) => [id, [options[0]]])));
    }
    const result = await this.waitForDecision(turn, { kind: DECISION_KIND.question, ...questions }, CURSOR_DECISION_MESSAGES.questionPrompt);
    return isRecord(result) ? result : CANCELLED;
  }

  private async resolvePlan(turn: CursorTurn, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.planMode === "autoAccept") {
      return planOutcome("accepted");
    }
    if (this.planMode === "autoDecline") {
      return planOutcome("rejected");
    }
    const title = stringValue(params.title) ?? "Cursor plan";
    const result = await this.waitForDecision(turn, { kind: DECISION_KIND.plan, choices: new Map(), multiSelect: new Set() }, (token) => CURSOR_DECISION_MESSAGES.planPrompt(title, token));
    return isRecord(result) ? result : CANCELLED;
  }

  private async waitForDecision(turn: CursorTurn, spec: DecisionSpec, prompt: (token: string) => string, signal?: AbortSignal): Promise<DecisionAnswer> {
    if (signal?.aborted) {
      return undefined;
    }
    const entry = this.registerDecision(turn, spec, signal);
    if (!(await this.postPrompt(turn, entry, prompt))) {
      return undefined;
    }
    const result = await this.decisions.wait(entry, entry.payload.answer.promise, { timeoutMs: this.decisionTimeoutMs });
    if (result !== TIMED_OUT) {
      return result;
    }
    this.endTimedOut(entry);
    return undefined;
  }

  private registerDecision(turn: CursorTurn, spec: DecisionSpec, signal?: AbortSignal): DecisionEntry<PendingDecision> {
    const { entry, removed } = this.decisions.registerMinted(
      { ...spec, roomId: turn.roomId, tools: turn.tools, requesterId: turn.requesterId, answer: createDeferred<DecisionAnswer>() },
      { roomId: turn.roomId },
    );
    this.endUnanswered(removed, END_REASON.evicted);
    if (signal) {
      // The ACP base class aborts on its own timeout too; the claim guard lets only one of them end the decision.
      signal.addEventListener("abort", () => this.abandonDecision(entry, signal.reason as ACPPermissionEndReason), { once: true });
    }
    return entry;
  }

  // False when the prompt failed and the decision ended unanswered.
  private async postPrompt(turn: CursorTurn, entry: DecisionEntry<PendingDecision>, prompt: (token: string) => string): Promise<boolean> {
    try {
      await turn.tools.sendMessage(prompt(entry.token), [turn.requesterId]);
      return true;
    } catch (error) {
      this.decisionLogger.warn("cursor_acp.decision_prompt_delivery_failed", { roomId: turn.roomId, kind: entry.payload.kind, error: String(error) });
      // A reply that claimed it meanwhile owns the answer; wait for it.
      return !this.abandonDecision(entry, END_REASON.promptDeliveryFailed);
    } finally {
      // Whether or not the prompt landed, the room's reply must not queue behind this turn.
      turn.releaseRoom();
    }
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
      decision.answer.resolve(undefined);
      this.decisionLogger.info("cursor_acp.decision_ended", { roomId: decision.roomId, kind: decision.kind, reason });
    }
  }

  private async handleControl(message: PlatformMessage, tools: AdapterToolsProtocol, roomId: string): Promise<boolean> {
    const words = commandWords(message.content);
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
    if (result === INVALID) {
      return CURSOR_DECISION_MESSAGES.invalidCommand(decision.kind, token);
    }
    if (!this.decisions.tryClaim(token)) {
      return CURSOR_DECISION_MESSAGES.notPending(token);
    }
    decision.answer.resolve(result);
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

type CommandResult = DecisionAnswer | typeof INVALID;

function commandResult(action: string, args: readonly string[], decision: PendingDecision): CommandResult {
  switch (decision.kind) {
    case DECISION_KIND.permission:
      return permissionResult(action, args, decision);
    case DECISION_KIND.plan:
      return planResult(action);
    case DECISION_KIND.question:
      return action === CURSOR_VERB.answer ? questionResult(args, decision) : INVALID;
  }
}

function permissionResult(action: string, args: readonly string[], decision: PendingDecision): CommandResult {
  switch (action) {
    case CURSOR_VERB.deny:
      return undefined;
    case CURSOR_VERB.select: {
      const [choice, ...extra] = args;
      return choice && extra.length === 0 && decision.choices.get(PERMISSION_CHOICE)!.includes(choice) ? choice : INVALID;
    }
    default:
      return INVALID;
  }
}

function planResult(action: string): CommandResult {
  switch (action) {
    case CURSOR_VERB.accept:
      return planOutcome("accepted");
    case CURSOR_VERB.reject:
      return planOutcome("rejected");
    default:
      return INVALID;
  }
}

function questionResult(args: readonly string[], decision: PendingDecision): CommandResult {
  const selected: Record<string, string[]> = {};
  for (const argument of args) {
    const [id, raw] = argument.split("=", 2);
    const values = raw?.split(",") ?? [];
    if (!isValidSelection(decision, selected, id, values)) return INVALID;
    selected[id] = values;
  }
  return Object.keys(selected).length === decision.choices.size ? answered(selected) : INVALID;
}

// An offered question, not yet answered, with offered values: several only where it allows them.
function isValidSelection(decision: PendingDecision, selected: Record<string, string[]>, id: string | undefined, values: readonly string[]): id is string {
  const offered = id ? decision.choices.get(id) : undefined;
  return !!id && !!offered && !selected[id] && values.length > 0
    && (values.length === 1 || decision.multiSelect.has(id))
    && values.every((value) => offered.includes(value));
}

function planOutcome(outcome: "accepted" | "rejected"): Record<string, unknown> {
  return { outcome: { outcome } };
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

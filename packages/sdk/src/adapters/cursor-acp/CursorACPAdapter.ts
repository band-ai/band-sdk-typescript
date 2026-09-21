import type { PermissionOption } from "@agentclientprotocol/sdk";

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
import type { CollectedChunk } from "../acp/types";

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

type DecisionKind = "permission" | "question" | "plan";

interface CursorTurn {
  messageId: string;
  roomId: string;
  sessionId?: string;
  tools: AdapterToolsProtocol;
  requesterId: string;
}

interface PendingDecision {
  kind: DecisionKind;
  roomId: string;
  choices: Map<string, readonly string[]>;
  multiSelect: ReadonlySet<string>;
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
  private readonly maxPendingDecisions: number;
  private readonly authorizedSenders: ReadonlySet<string> | null;
  private readonly decisionLogger: Logger;
  private readonly extensions: CursorExtensions;
  private readonly turns = new Map<string, CursorTurn>();
  private readonly pending = new Map<string, PendingDecision>();
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
    this.maxPendingDecisions = options.maxPendingDecisions ?? DEFAULT_CURSOR_MAX_PENDING_DECISIONS;
    this.authorizedSenders = options.decisionAuthorizedSenders
      ? new Set(options.decisionAuthorizedSenders)
      : null;
    this.decisionLogger = resolveLogger(options.logger);
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
    await this.withCursorTurnLock(() => super.onMessage(message, tools, history, participantsMessage, contactsMessage, context));
  }

  protected override async onAcpTurnStarted(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    const turn = { messageId: message.id, roomId: context.roomId, tools, requesterId: message.senderId };
    this.turns.set(context.roomId, turn);
    this.activeTurn = turn;
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
      this.cancelRoom(context.roomId);
    }
    if (this.activeTurn?.messageId === message.id) {
      this.activeTurn = null;
    }
  }

  public override async onCleanup(roomId: string): Promise<void> {
    const sessionId = this.turns.get(roomId)?.sessionId;
    this.cancelRoom(roomId);
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
    for (const decision of this.pending.values()) {
      decision.resolve(undefined);
    }
    this.pending.clear();
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
    const token = await this.waitForDecision("permission", request.roomId, turn, new Map([["permission", options]]), new Set(), `Cursor needs permission. Reply \`/cursor select {token} option-id\` or \`/cursor deny {token}\`.`, signal);
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
    const result = await this.waitForDecision("question", roomId, turn, questions.choices, questions.multiSelect, "Cursor needs input. Reply \`/cursor answer {token} question-id=option-id[,option-id] ...\`.");
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
    const result = await this.waitForDecision("plan", roomId, turn, new Map(), new Set(), `${title} needs approval. Reply \`/cursor accept {token}\` or \`/cursor reject {token}\`.`);
    return isRecord(result) ? result : { outcome: { outcome: "cancelled" } };
  }

  private async waitForDecision(kind: DecisionKind, roomId: string, turn: CursorTurn, choices: Map<string, readonly string[]>, multiSelect: ReadonlySet<string>, prompt: string, signal?: AbortSignal): Promise<unknown> {
    if (this.pending.size >= this.maxPendingDecisions) {
      this.pending.values().next().value?.resolve(undefined);
    }
    const token = crypto.randomUUID().slice(0, 8);
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => settle(undefined), this.decisionTimeoutMs);
      const abort = () => settle(undefined);
      const settle = (value: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(token);
        resolve(value);
      };
      this.pending.set(token, { kind, roomId, choices, multiSelect, resolve: settle });
      signal?.addEventListener("abort", abort, { once: true });
      void turn.tools.sendMessage(prompt.replaceAll("{token}", token), [turn.requesterId]).catch((error: unknown) => {
        this.decisionLogger.warn("cursor_acp.decision_prompt_delivery_failed", { roomId, kind, error: String(error) });
        settle(undefined);
      });
    });
  }

  private async handleControl(message: PlatformMessage, tools: AdapterToolsProtocol, roomId: string): Promise<boolean> {
    const words = message.content.trim().split(/\s+/);
    if (words[0]?.toLowerCase() !== "/cursor") {
      return false;
    }
    if (words.length === 1 || words[1]?.toLowerCase() === "decisions") {
      const entries = [...this.pending.entries()].filter(([, decision]) => decision.roomId === roomId).map(([token, decision]) => `\`${token}\` (${decision.kind})`);
      await tools.sendMessage(`Pending Cursor decisions: ${entries.join(", ") || "none"}`);
      return true;
    }
    const [_, action, token, ...args] = words;
    const decision = token ? this.pending.get(token) : undefined;
    if (!decision || decision.roomId !== roomId) {
      await tools.sendMessage(`Cursor decision \`${token ?? ""}\` is not pending.`);
      return true;
    }
    if (this.authorizedSenders && !this.authorizedSenders.has(message.senderId)) {
      await tools.sendMessage("You are not authorized to resolve Cursor decisions.");
      return true;
    }
    const result = commandResult(action ?? "", args, decision);
    if (result === null) {
      await tools.sendMessage(`That command is not valid for Cursor ${decision.kind} decision \`${token}\`.`);
      return true;
    }
    decision.resolve(result);
    await tools.sendMessage(`Cursor ${decision.kind} decision \`${token}\` resolved.`);
    return true;
  }

  private cancelRoom(roomId: string): void {
    for (const [token, decision] of this.pending) {
      if (decision.roomId === roomId) {
        decision.resolve(undefined);
        this.pending.delete(token);
      }
    }
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
  if (decision.kind === "permission") return action === "deny" ? undefined : action === "select" && args.length === 1 && decision.choices.get("permission")?.includes(args[0] ?? "") ? args[0] : null;
  if (decision.kind === "plan") return action === "accept" ? { outcome: { outcome: "accepted" } } : action === "reject" ? { outcome: { outcome: "rejected" } } : null;
  if (action !== "answer") return null;
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

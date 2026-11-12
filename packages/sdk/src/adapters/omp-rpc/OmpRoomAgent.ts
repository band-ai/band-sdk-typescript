import type { AgentEventListener, RoomAgentIdentity } from "../../contracts/events";
import type { OmpRpcSessionState } from "../../converters/omp-rpc";
import { createDeferred, type Deferred } from "../../core/deferred";
import { rethrowIfRecoverableTurnFailure, ValidationError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { FAILURE_CODE_TIMEOUT, agentFailure, reportTurnFailure } from "../../core/providerFailure";
import { REDACTED_VALUE, SENSITIVE_KEY_TERMS, redactCredentialText } from "../../core/sensitiveTerms";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { relayReply, type TurnTools } from "../../core/turn";
import { buildSingleContextRegistrations, resolveSingleRoomTools, type McpToolRegistration } from "../../mcp/registrations";
import { renderSystemPrompt } from "../../runtime/prompts";
import type { PlatformMessage } from "../../runtime/types";
import { trackNativeActivity } from "../../runtime/workingState";
import { assertPermissionTimeoutMs } from "../acp/ACPRoomAgent";
import { asErrorMessage } from "../shared/coercion";
import { systemUpdateParts } from "../shared/conversationPrompt";
import { framedReplay } from "../shared/historyReplay";
import { roomContextLines } from "../shared/roomContext";
import { createRoomTurnLock } from "../shared/roomTurnLock";
import type { WorkspaceForRoom } from "../shared/roomWorkspace";
import { assertTurnTimeoutMs } from "../shared/turnTimeout";
import { withTimeout } from "../shared/withTimeout";
import {
  OmpProcessError,
  OmpRpcClient,
  OmpRpcError,
  spawnOmpProcess,
  type OmpProcessFactory,
  type OmpPromptHandlers,
} from "./client";
import {
  OMP_COMMAND,
  OMP_RPC_PROTOCOL_VERSION,
  type OmpEvent,
  type OmpHostToolCall,
  type OmpHostToolDefinition,
  type OmpPromptOutcome,
  type OmpToolResult,
  type OmpUIRequest,
  type OmpUIResponse,
} from "./protocol";

export const DEFAULT_OMP_RPC_COMMAND = ["omp", "--mode", "rpc"] as const;

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;
// A local process acknowledging a command; the turn itself ends on its own result.
const ABORT_ACK_TIMEOUT_MS = 10_000;
// The title OMP gives a tool approval: `Allow tool: <name>`, then details.
const APPROVAL_TITLE_PREFIX = "Allow tool: ";
// The one-time grant OMP offers on every tool approval.
const APPROVE_ONCE = "Approve";
const DENY = "Deny";
const SELECT_METHOD = "select";
const COMPACTION_ACTIVITY = "omp-compaction";
const SENSITIVE_KEY = new RegExp(`(${SENSITIVE_KEY_TERMS})`, "i");

/** A tool approval OMP asks for, in the shape of Python's `OmpPermissionRequest`. */
export interface OmpPermissionRequest {
  roomId: string;
  sessionId: string;
  /** OMP's own prompt, starting `Allow tool: <name>`. */
  title: string;
  /** The answers OMP offers, as labels; a resolver returns one of them. */
  options: readonly string[];
}

/**
 * Why a permission request's `signal` aborted: given up on (`timeout`, the
 * room or adapter stopping, the process failing, the turn cancelled, or OMP
 * withdrawing it), answered (`settled`), or ended without a usable answer
 * (`no-answer`).
 */
export type OmpPermissionEndReason =
  | "timeout"
  | "room-closed"
  | "adapter-stopped"
  | "connection-lost"
  | "turn-cancelled"
  | "withdrawn"
  | "settled"
  | "no-answer";

export interface OmpRpcAdapterOptions {
  /** Defaults to {@link DEFAULT_OMP_RPC_COMMAND}; must start OMP in RPC mode. */
  command?: string | string[];
  cwd?: string;
  // Each room's process runs in its own folder, `<cwd>/.band-workspaces/<roomId>`.
  // Replaces that layout; must return an absolute path, which the adapter
  // creates and gives to that one room. Cannot be combined with `cwd`.
  workspaceForRoom?: WorkspaceForRoom;
  /** Added to this process's environment for the OMP process. */
  env?: Record<string, string>;
  /** Merged into the first prompt's system context. */
  customSection?: string;
  enableMemoryTools?: boolean;
  /** Exposes the room's board and task tools; Band serves them only with the `tasks` capability. */
  enableTaskTools?: boolean;
  /** More tools OMP may call, run in this process with the room's tools. */
  additionalTools?: McpToolRegistration[];
  /**
   * More tools OMP may call, built for one room rather than shared by all of them. Called once per
   * room, where the room is created, with that room's id; what it returns is appended after
   * {@link additionalTools}. A host tool whose answer depends on which room called it — one that asks
   * the person to approve something **in that room**, say — belongs here: the shared set is the same
   * objects in every room, so it cannot tell them apart. Names may not collide across the two sets.
   */
  additionalToolsForRoom?: (roomId: string) => McpToolRegistration[];
  // Omitted ⇒ a tool approval is granted once ("Approve") when OMP offers
  // that, else cancelled. Set ⇒ each approval is handed to this callback; an
  // offered label is answered verbatim ("Deny" is a real refusal), anything
  // else cancels the approval. `signal` aborts with an `OmpPermissionEndReason`,
  // and an answer arriving after the abort is discarded.
  resolvePermission?: (request: OmpPermissionRequest, signal: AbortSignal) => Promise<string | undefined>;
  /** Only meaningful with `resolvePermission`. Defaults to five minutes. */
  permissionTimeoutMs?: number;
  /** Defaults to an hour; on expiry the room's process is stopped. */
  turnTimeoutMs?: number;
  logger?: Logger;
  // Starts each room's process. Must start a process dedicated to that room.
  spawnProcess?: OmpProcessFactory;
}

/** What one room's engine is built from: the adapter's options, bound to that room. */
export interface OmpRoomAgentOptions extends Omit<OmpRpcAdapterOptions, "command" | "cwd" | "workspaceForRoom" | "additionalToolsForRoom"> {
  command: string[];
  /** The room's claimed workspace; its process runs here. */
  cwd: string;
  roomId: string;
  /** Where the room reports local events; nothing sent here is posted. */
  observer?: AgentEventListener;
}

/** The room's live process and the session it serves. */
interface LiveProcess {
  client: OmpRpcClient;
  sessionId: string;
  /** The session has not taken a prompt yet, so its next one carries the room's history. */
  owesReplay: boolean;
}

/** The turn holding the room. */
interface ActiveTurn {
  cancelled: boolean;
  // Settles when the host cancels, so a wait the turn is stuck in ends early.
  readonly cancellation: Deferred<void>;
  /** Set while the turn's prompt runs on this process. */
  client?: OmpRpcClient;
  readonly tools: TurnTools;
  readonly native: ReturnType<typeof trackNativeActivity>;
  /** The assistant's text, message by message, for the closing reply. */
  readonly texts: string[];
  /** Native tool calls started and not yet ended, by `toolCallId`. */
  readonly calls: Map<string, string>;
  readonly permissions: Set<AbortController>;
  /** Redacted tool records, posted when the turn ends and dropped when it is cancelled. */
  readonly events: Array<{ content: string; messageType: "tool_call" | "tool_result"; metadata: Record<string, unknown> }>;
}

class OmpTurnCancelledError extends Error {}

class OmpTurnTimeoutError extends Error {}

const TURN_CANCELLED = Symbol("turn-cancelled");
const START_SUPERSEDED = "OMP start superseded by stop()";

/**
 * One room's OMP process over its native RPC mode. The process starts on the
 * room's first message, or on `warm()`, and serves one session for its whole
 * life; a process that dies is replaced on the room's next message, and the
 * new session is seeded with the room's history.
 */
export class OmpRoomAgent extends SimpleAdapter<OmpRpcSessionState, TurnTools> {
  protected readonly provider = "omp-rpc";
  private readonly roomId: string;
  private readonly command: string[];
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly customSection?: string;
  private readonly resolvePermission?: OmpRpcAdapterOptions["resolvePermission"];
  private readonly permissionTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly spawnProcess: OmpProcessFactory;
  private readonly logger: Logger;
  private readonly observer: AgentEventListener;
  private readonly hostTools: Map<string, McpToolRegistration>;
  private readonly turns = createRoomTurnLock();
  private activeTurn: ActiveTurn | undefined;
  private live: LiveProcess | null = null;
  private starting: Promise<LiveProcess> | null = null;
  // Bumped by `stop()`, so a start still in flight installs nothing.
  private generation = 0;
  private started = false;
  private systemPrompt = "";
  // The room's history as its first turn saw it. Later turns carry only what
  // this process has recorded since, so a replacement session is seeded from
  // both.
  private bootstrapHistory: OmpRpcSessionState | undefined;

  public constructor(options: OmpRoomAgentOptions) {
    super();
    this.roomId = options.roomId;
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env;
    this.customSection = options.customSection;
    this.resolvePermission = options.resolvePermission;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? spawnOmpProcess;
    this.logger = resolveLogger(options.logger);
    this.observer = options.observer ?? (() => {});
    // The same tools a room's ACP agent gets from its Band MCP server, run
    // here against the turn in flight: OMP calls them as host tools.
    const registrations = buildSingleContextRegistrations(
      resolveSingleRoomTools(() => this.activeTurn?.tools),
      {
        enableMemoryTools: options.enableMemoryTools ?? false,
        enableTaskTools: options.enableTaskTools ?? false,
        enableContactTools: true,
        additionalTools: options.additionalTools,
      },
    );
    this.hostTools = new Map(registrations.map((registration) => [registration.name, registration]));
    if (this.hostTools.size !== registrations.length) {
      throw new ValidationError("OMP host tools must have unique names");
    }
  }

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.started = true;
    this.systemPrompt = renderSystemPrompt({
      agentName,
      agentDescription,
      includeBaseInstructions: false,
      customSection: this.customSection,
    });
  }

  /**
   * Starts the room's process and waits for its `ready`, rather than on the
   * first turn. A process that starts has negotiated {@link OMP_RPC_PROTOCOL_VERSION}.
   */
  public async warm(): Promise<RoomAgentIdentity> {
    await this.ensureProcess();
    return { protocol: "omp-rpc", protocolVersion: OMP_RPC_PROTOCOL_VERSION };
  }

  public async onMessage(
    message: PlatformMessage,
    tools: TurnTools,
    history: OmpRpcSessionState,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (context.isSessionBootstrap) {
      this.bootstrapHistory = history;
    }
    await this.turns.run(context.roomId, async () => {
      const turn: ActiveTurn = {
        cancelled: false,
        cancellation: createDeferred(),
        tools,
        native: trackNativeActivity(tools, new Set(this.hostTools.keys())),
        texts: [],
        calls: new Map(),
        permissions: new Set(),
        events: [],
      };
      this.activeTurn = turn;
      try {
        await this.runTurn(message, turn, participantsMessage, contactsMessage, history);
      } finally {
        turn.native.endAll();
        this.endPermissions(turn, "no-answer");
        // Only `turn` itself goes: `onCleanup` may already have let a newer turn in.
        if (this.activeTurn === turn) {
          this.activeTurn = undefined;
        }
      }
    });
  }

  /**
   * Cancels the room's running turn and keeps its process. A prompt in flight
   * gets OMP's `abort`; the turn still ends only when OMP reports the prompt
   * `aborted` and its session settles, and then posts nothing. The turn's
   * approvals, pending or later, are answered `cancelled`. A turn still
   * starting its process stops waiting and never sends its prompt; the
   * process it starts serves the room's next turn. Resolves false when no
   * turn holds the room.
   */
  public async cancelTurn(_roomId: string): Promise<boolean> {
    const turn = this.activeTurn;
    if (!turn) {
      return false;
    }
    turn.cancelled = true;
    turn.cancellation.resolve();
    this.endPermissions(turn, "turn-cancelled");
    const client = turn.client;
    if (client) {
      try {
        await withTimeout(client.abort(), ABORT_ACK_TIMEOUT_MS, `OMP did not acknowledge abort within ${ABORT_ACK_TIMEOUT_MS}ms`);
      } catch (error) {
        // The prompt still ends on its own result, or fails with the process.
        this.logger.warn("omp_rpc.abort_failed", { roomId: this.roomId, error: asErrorMessage(error) });
      }
    }
    return true;
  }

  public async onCleanup(_roomId: string): Promise<void> {
    const turn = this.activeTurn;
    this.activeTurn = undefined;
    if (turn) this.endPermissions(turn, "room-closed");
    this.turns.release(this.roomId);
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop();
  }

  public async stop(): Promise<void> {
    this.generation += 1;
    this.started = false;
    const turn = this.activeTurn;
    if (turn) this.endPermissions(turn, "adapter-stopped");
    this.turns.clear();
    const live = this.live;
    this.live = null;
    this.starting = null;
    await live?.client.close();
  }

  private async runTurn(
    message: PlatformMessage,
    turn: ActiveTurn,
    participantsMessage: string | null,
    contactsMessage: string | null,
    history: OmpRpcSessionState,
  ): Promise<void> {
    let live: LiveProcess | undefined;
    try {
      live = await this.untilCancelled(turn, this.ensureProcess());
      const messageWithContext = [...systemUpdateParts(participantsMessage, contactsMessage), message.content].join("\n\n");
      const prompt = live.owesReplay
        ? [this.buildSystemContext(message), ...this.seeded(message.id, messageWithContext, history)].join("\n\n")
        : messageWithContext;
      if (turn.cancelled) {
        // Cancelled before its prompt was sent: there is nothing to tell OMP.
        throw new OmpTurnCancelledError();
      }
      turn.client = live.client;
      let outcome: OmpPromptOutcome;
      try {
        outcome = await withTimeout(
          live.client.prompt(prompt, this.promptHandlers(turn)),
          this.turnTimeoutMs,
          () => new OmpTurnTimeoutError(),
        );
      } finally {
        turn.client = undefined;
      }
      if (outcome.status === "aborted" && turn.cancelled) {
        throw new OmpTurnCancelledError();
      }
      await this.postEvents(turn);
      // The session took a prompt, so it has the room's history from here on.
      live.owesReplay = false;
      await relayReply(turn.tools, turn.texts.join("\n\n"), [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
      if (outcome.status !== "completed") {
        await reportTurnFailure(
          turn.tools,
          agentFailure(this.provider, outcome.error?.message ?? `OMP ended the turn as ${outcome.status}.`, outcome.status),
          this.logger,
          { roomId: this.roomId },
        );
      }
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error);
      if (error instanceof OmpTurnCancelledError) {
        // A host's cancel ends the turn quietly: what the agent produced is
        // dropped, and the process stays for the room's next turn.
        turn.tools.turn.settle();
        return;
      }
      await this.postEvents(turn);
      const timedOut = error instanceof OmpTurnTimeoutError;
      if (timedOut && live) {
        // A prompt that never ended leaves the process in an unknown state.
        this.retire(live);
      }
      await reportTurnFailure(
        turn.tools,
        timedOut
          ? agentFailure(this.provider, "OMP turn timed out.", FAILURE_CODE_TIMEOUT)
          : error instanceof OmpRpcError
            ? agentFailure(this.provider, error.message, error.code)
            : agentFailure(this.provider, asErrorMessage(error)),
        this.logger,
        { roomId: this.roomId },
      );
    }
  }

  /** The live message, framed under the room's history when there is any to replay. */
  private seeded(messageId: string, liveMessage: string, history: OmpRpcSessionState): string[] {
    const seen = new Set([messageId]);
    const lines: string[] = [];
    for (const entry of [...(this.bootstrapHistory?.replayMessages ?? []), ...history.replayMessages]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      lines.push(entry.line);
    }
    return lines.length > 0 ? framedReplay(lines, liveMessage) : [liveMessage];
  }

  private buildSystemContext(message: PlatformMessage): string {
    return [
      "[System Context]",
      this.systemPrompt,
      "",
      "## Room Context",
      "You are connected to Band through its band_* tools.",
      "Use the Band tools for any visible room action.",
      "",
      ...roomContextLines(this.roomId, message),
    ].join("\n");
  }

  // A cancel ends the turn's wait, not `operation`: it runs on, so a process
  // it starts stays for the room's next turn.
  private async untilCancelled<T>(turn: ActiveTurn, operation: Promise<T>): Promise<T> {
    const cancelled = turn.cancellation.promise.then((): typeof TURN_CANCELLED => TURN_CANCELLED);
    const winner = await Promise.race([operation, cancelled]);
    if (winner === TURN_CANCELLED) {
      void operation.catch((error: unknown) => {
        this.logger.warn("omp_rpc.cancelled_turn_wait_failed", { roomId: this.roomId, error: asErrorMessage(error) });
      });
      throw new OmpTurnCancelledError();
    }
    return winner;
  }

  private async ensureProcess(): Promise<LiveProcess> {
    if (this.live) {
      return this.live;
    }
    if (!this.started) {
      throw new Error("OmpRpcAdapter was not started");
    }
    if (!this.starting) {
      const starting = this.startProcess().finally(() => {
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private async startProcess(): Promise<LiveProcess> {
    const generation = this.generation;
    let client: OmpRpcClient | undefined;
    try {
      client = await OmpRpcClient.start(this.spawnProcess, { command: this.command, cwd: this.cwd, env: this.env, logger: this.logger });
      const state = await client.request(OMP_COMMAND.getState);
      if (typeof state.sessionId !== "string") {
        throw new OmpProcessError("OMP get_state named no session");
      }
      await client.request(OMP_COMMAND.setHostTools, { tools: this.hostToolDefinitions() });
      if (generation !== this.generation) {
        throw new Error(START_SUPERSEDED);
      }
      const live: LiveProcess = { client, sessionId: state.sessionId, owesReplay: true };
      this.live = live;
      void client.failed.then((error) => {
        // Still live means nothing here retired it: the process failed on its own.
        if (this.live === live) {
          this.live = null;
          this.observer({ type: "room.failed", roomId: this.roomId, error: error.message });
        }
      });
      return live;
    } catch (error) {
      await client?.close().catch((closeError: unknown) => {
        this.logger.warn("omp_rpc.close_after_start_failure", { roomId: this.roomId, error: asErrorMessage(closeError) });
      });
      if (asErrorMessage(error) !== START_SUPERSEDED) {
        this.observer({ type: "room.failed", roomId: this.roomId, error: asErrorMessage(error) });
      }
      throw error;
    }
  }

  private retire(live: LiveProcess): void {
    if (this.live === live) {
      this.live = null;
    }
    void live.client.close().catch((error: unknown) => {
      this.logger.warn("omp_rpc.close_failed", { roomId: this.roomId, error: asErrorMessage(error) });
    });
  }

  private hostToolDefinitions(): OmpHostToolDefinition[] {
    return [...this.hostTools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      parameters: { ...inputSchema },
      loadMode: "essential",
    }));
  }

  private promptHandlers(turn: ActiveTurn): OmpPromptHandlers {
    return {
      onEvent: (event) => this.observeEvent(turn, event),
      onHostTool: (call) => this.runHostTool(turn, call),
      onUiRequest: (request, signal) => this.answerUiRequest(turn, request, signal),
    };
  }

  private observeEvent(turn: ActiveTurn, event: OmpEvent): void {
    switch (event.type) {
      case "message_update": {
        // Streamed for the host only. Reasoning is never posted, and only the
        // deltas are read: a message's encrypted reasoning signature is not.
        const update = event.assistantMessageEvent;
        if (!update?.delta) return;
        if (update.type === "thinking_delta") this.observer({ type: "thought", roomId: this.roomId, text: update.delta });
        else if (update.type === "text_delta") this.observer({ type: "message", roomId: this.roomId, text: update.delta });
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") return;
        const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) turn.texts.push(block.text);
        }
        return;
      }
      case "tool_execution_start":
        return this.startTool(turn, event);
      case "tool_execution_end":
        return this.endTool(turn, event);
      case "auto_compaction_start":
        turn.native.memory(COMPACTION_ACTIVITY);
        return;
      case "auto_compaction_end":
        turn.native.end(COMPACTION_ACTIVITY);
        return;
      default:
        return;
    }
  }

  private startTool(turn: ActiveTurn, event: OmpEvent): void {
    const { toolCallId, toolName } = event;
    if (!toolCallId || !toolName || turn.calls.has(toolCallId)) return;
    turn.calls.set(toolCallId, toolName);
    this.observer({ type: "tool.call", roomId: this.roomId, toolCallId, name: toolName, ...(event.args !== undefined ? { input: event.args } : {}) });
    // A Band tool is the room action itself; only OMP's own tools are reported as work.
    if (this.hostTools.has(toolName)) return;
    turn.native.tool(toolCallId, toolName);
    this.post(turn, toolName, "tool_call", { tool_call_id: toolCallId, raw_input: redacted(event.args ?? {}), status: "in_progress" });
  }

  private endTool(turn: ActiveTurn, event: OmpEvent): void {
    const toolCallId = event.toolCallId;
    const toolName = toolCallId ? turn.calls.get(toolCallId) : undefined;
    if (!toolCallId || toolName === undefined) return;
    turn.calls.delete(toolCallId);
    const status = event.isError ? "failed" : "completed";
    const output = (event.result?.content ?? [])
      .map((block) => typeof block.text === "string" ? block.text : block.type === "image" ? "[image]" : "")
      .join("\n");
    this.observer({ type: "tool.result", roomId: this.roomId, toolCallId, status, output });
    if (this.hostTools.has(toolName)) return;
    turn.native.end(toolCallId);
    this.post(turn, redactCredentialText(output), "tool_result", { tool_call_id: toolCallId, status });
  }

  private post(turn: ActiveTurn, content: string, messageType: "tool_call" | "tool_result", metadata: Record<string, unknown>): void {
    turn.events.push({ content, messageType, metadata });
  }

  /** Posts the turn's tool records in the order they happened. */
  private async postEvents(turn: ActiveTurn): Promise<void> {
    for (const { content, messageType, metadata } of turn.events.splice(0)) {
      await turn.tools.sendEvent(content, messageType, metadata);
    }
  }

  private async runHostTool(turn: ActiveTurn, call: OmpHostToolCall): Promise<OmpToolResult> {
    if (turn.cancelled) {
      return { content: [{ type: "text", text: "The turn was cancelled." }], isError: true };
    }
    const registration = this.hostTools.get(call.toolName);
    if (!registration) {
      return { content: [{ type: "text", text: "Tool is not available in this session" }], isError: true };
    }
    const result = await registration.execute(call.arguments);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }

  private async answerUiRequest(turn: ActiveTurn, request: OmpUIRequest, withdrawn: AbortSignal): Promise<OmpUIResponse> {
    const options = request.options ?? [];
    if (request.method !== SELECT_METHOD || options.length === 0) {
      this.logger.warn("omp_rpc.ui_request_cancelled", { roomId: this.roomId, method: request.method });
      return { cancelled: true };
    }
    if (turn.cancelled) {
      // A cancelled turn approves nothing more; the room's next turn can.
      return { cancelled: true };
    }
    const title = request.title ?? "";
    const toolName = approvalToolName(title);
    const toolCallId = this.approvalCallId(turn, toolName) ?? request.id;
    this.observer({
      type: "approval.requested",
      roomId: this.roomId,
      toolCallId,
      toolName,
      options: options.map((label) => ({ optionId: label, name: label, kind: optionKind(label) })),
    });
    turn.native.wait(request.id);
    let choice: string | undefined;
    try {
      choice = this.resolvePermission
        ? await this.resolveManually(turn, { roomId: this.roomId, sessionId: this.live?.sessionId ?? "", title, options }, withdrawn)
        : options.includes(APPROVE_ONCE) ? APPROVE_ONCE : undefined;
    } finally {
      turn.native.endWait(request.id);
    }
    // Checked again here: an answer that raced the turn's cancel must not approve.
    if (turn.cancelled || withdrawn.aborted) choice = undefined;
    if (choice !== undefined && !options.includes(choice)) {
      this.logger.warn("omp_rpc.permission_choice_not_offered", { roomId: this.roomId, choice, options });
      choice = undefined;
    }
    this.observer(choice === undefined
      ? { type: "approval.resolved", roomId: this.roomId, toolCallId, outcome: "cancelled" }
      : { type: "approval.resolved", roomId: this.roomId, toolCallId, outcome: "selected", optionId: choice });
    return choice === undefined ? { cancelled: true } : { value: choice };
  }

  /** The one running call of the tool an approval names, when exactly one is running. */
  private approvalCallId(turn: ActiveTurn, toolName: string): string | undefined {
    const running = [...turn.calls].filter(([, name]) => name === toolName);
    return running.length === 1 ? running[0][0] : undefined;
  }

  // Races the caller's resolver against the request's single abort channel:
  // the timeout, OMP withdrawing it, or the turn, room or adapter ending.
  private async resolveManually(turn: ActiveTurn, request: OmpPermissionRequest, withdrawn: AbortSignal): Promise<string | undefined> {
    const controller = new AbortController();
    turn.permissions.add(controller);
    const end = (reason: OmpPermissionEndReason): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onWithdrawn = (): void => end("withdrawn");
    withdrawn.addEventListener("abort", onWithdrawn, { once: true });
    const timer = setTimeout(() => end("timeout"), this.permissionTimeoutMs);
    const abandoned = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    try {
      const choice = await Promise.race([
        Promise.resolve()
          .then(() => this.resolvePermission!(request, controller.signal))
          .catch((error: unknown) => {
            this.logger.warn("omp_rpc.resolve_permission_failed", { roomId: this.roomId, error: asErrorMessage(error) });
            return undefined;
          }),
        abandoned,
      ]);
      // An answer landing after the request was given up on is dropped.
      if (controller.signal.aborted) return undefined;
      end(choice !== undefined && request.options.includes(choice) ? "settled" : "no-answer");
      return choice;
    } finally {
      clearTimeout(timer);
      withdrawn.removeEventListener("abort", onWithdrawn);
      turn.permissions.delete(controller);
    }
  }

  private endPermissions(turn: ActiveTurn, reason: OmpPermissionEndReason): void {
    for (const controller of turn.permissions) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }
}

/** The tool an approval title names, or the title's first line when it names none. */
function approvalToolName(title: string): string {
  const first = title.split("\n", 1)[0] ?? "";
  const name = first.startsWith(APPROVAL_TITLE_PREFIX) ? first.slice(APPROVAL_TITLE_PREFIX.length).trim() : first.trim();
  return name || "unknown";
}

/** OMP's approval labels in ACP's option kinds, for hosts that answer by kind. */
function optionKind(label: string): string {
  if (label === APPROVE_ONCE) return "allow_once";
  if (label === DENY) return "reject_once";
  return label.startsWith(`${APPROVE_ONCE} `) ? "allow_always" : "other";
}

/**
 * A copy of `value` for the room: values under credential-shaped keys are
 * withheld and credential-shaped text inside strings is masked. OMP passes
 * tool arguments through unredacted.
 */
function redacted(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED_VALUE;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redacted(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? REDACTED_VALUE : redacted(entry, seen)]));
}

/**
 * Rejects options no room could run with, so a bad config fails when the
 * adapter is built. Returns the command as an argv array.
 */
export function validateOmpRpcOptions(options: OmpRpcAdapterOptions): string[] {
  const command = options.command === undefined ? [...DEFAULT_OMP_RPC_COMMAND] : Array.isArray(options.command) ? [...options.command] : [options.command];
  if (command.length === 0 || typeof command[0] !== "string" || command[0].trim().length === 0) {
    throw new ValidationError("OmpRpcAdapter requires a command");
  }
  if (options.resolvePermission) {
    assertPermissionTimeoutMs(options.permissionTimeoutMs);
  }
  assertTurnTimeoutMs(options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  return command;
}

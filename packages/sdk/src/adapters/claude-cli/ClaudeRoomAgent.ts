import type { ClaudeCliSessionState } from "../../converters/claude-cli";
import type { AgentEventListener, RoomAgentIdentity } from "../../contracts/events";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { createDeferred, type Deferred } from "../../core/deferred";
import { rethrowIfRecoverableTurnFailure, ValidationError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { FAILURE_CODE_TIMEOUT, agentFailure, reportTurnFailure } from "../../core/providerFailure";
import { REDACTED_VALUE, SENSITIVE_KEY_TERMS, redactCredentialText } from "../../core/sensitiveTerms";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { relayReply, type TurnTools } from "../../core/turn";
import { createBandMcpBackend, type BandMcpBackend } from "../../mcp/backends";
import { assertPermissionTimeoutMs } from "../acp/ACPRoomAgent";
import type { McpToolRegistration, McpToolResult } from "../../mcp/registrations";
import { renderSystemPrompt } from "../../runtime/prompts";
import type { PlatformMessage } from "../../runtime/types";
import { trackNativeActivity } from "../../runtime/workingState";
import { MCP_SERVER_NAME } from "../../contracts/toolSchemas";
import { asErrorMessage } from "../shared/coercion";
import { systemUpdateParts } from "../shared/conversationPrompt";
import { framedReplay } from "../shared/historyReplay";
import { roomContextLines } from "../shared/roomContext";
import { createRoomTurnLock } from "../shared/roomTurnLock";
import type { WorkspaceForRoom } from "../shared/roomWorkspace";
import { assertTurnTimeoutMs } from "../shared/turnTimeout";
import { withTimeout } from "../shared/withTimeout";
import {
  ClaudeCliClient,
  ClaudeProcessError,
  spawnClaudeProcess,
  type ClaudeCliStartConfig,
  type ClaudeProcessFactory,
} from "./client";
import {
  CLAUDE_PROTOCOL,
  encodeMcpConfig,
  encodePermissionDecision,
  parsePermissionRequest,
  type ClaudeEvent,
  type ClaudeMcpServerConfig,
  type ClaudePermissionDecision,
  type ClaudePermissionRequest,
  type ClaudeResultFrame,
} from "./protocol";

export const DEFAULT_CLAUDE_CLI_COMMAND = ["claude"] as const;

/**
 * The callback tool the CLI asks when a tool use needs approval. It is served on
 * Band's own MCP server but is never part of Band's tool catalog, and the CLI
 * keeps it from the model; only the CLI calls it.
 */
export const CLAUDE_PERMISSION_TOOL = "band_permission_decision";

/**
 * They list, prompt, or send files to the OS user's other Claude Code sessions;
 * a Band agent talks only through Band tools. `ToolSearch` is excluded so the
 * Band tools are offered directly instead of behind a search round trip.
 */
export const DENIED_CLAUDE_CLI_TOOLS = ["ListAgents", "SendMessage", "SendFile", "ToolSearch"] as const;

/** Flags the transport owns; a host-supplied argument cannot replace them. */
export const RESERVED_CLAUDE_FLAGS = [
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--strict-mcp-config",
  "--mcp-config",
  "--permission-prompts",
  "--permission-prompt-tool",
  "--setting-sources",
  "--resume",
  "--session-id",
  "--no-session-persistence",
  "--disallowedTools",
  "--allowedTools",
  "--model",
  "--effort",
  "--permission-mode",
  "--plugin-dir",
  "--bare",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
  "--tools",
] as const;

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;
// The CLI acknowledging an interrupt; the turn itself ends on its own result frame.
const INTERRUPT_ACK_TIMEOUT_MS = 10_000;
// How long a process gets to leave after its stdin closes before it is killed.
const DRAIN_TIMEOUT_MS = 5_000;
/** Loading no settings source is how a Band agent is kept out of the host's own Claude Code setup. */
const NO_SETTING_SOURCES = "";
/** A generation whose tools are closed answers nothing, however the request arrives. */
const CLOSED_GENERATION = "This turn is closed; the request was refused.";

const SENSITIVE_KEY = new RegExp(`(${SENSITIVE_KEY_TERMS})`, "i");

/** What the adapter asks the host to decide, in the shape the CLI reported. */
export interface ClaudePermissionPrompt extends ClaudePermissionRequest {
  roomId: string;
  sessionId: string;
}

/**
 * Why a permission request's `signal` aborted: given up on (`timeout`, the room
 * or adapter stopping, the process failing, the turn cancelled), answered
 * (`settled`), or ended without a usable answer (`no-answer`).
 */
export type ClaudePermissionEndReason =
  | "timeout"
  | "room-closed"
  | "adapter-stopped"
  | "connection-lost"
  | "turn-cancelled"
  | "settled"
  | "no-answer";

/** What one turn spent, taken from the CLI's latest-turn fields only. */
export interface ClaudeTurnUsage {
  available: boolean;
  /** Per-model usage the CLI attributed to the turn that just ended. */
  byModel: Record<string, unknown> | null;
  /** Why usage is unavailable, when it is: never a zero dressed up as a number. */
  reason: string | null;
}

export interface ClaudeCliAdapterOptions {
  /** Defaults to `claude` on PATH. Must be the installed Claude Code CLI. */
  command?: string | string[];
  cwd?: string;
  /** Replaces the default `<cwd>/.band-workspaces/<roomId>` layout. Cannot combine with `cwd`. */
  workspaceForRoom?: WorkspaceForRoom;
  /** Added to this process's environment for the CLI process. */
  env?: Record<string, string>;
  /** Merged into the first turn's system context. */
  customSection?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The CLI's own permission mode. `manual` is accepted and mapped to `default`. */
  permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "manual";
  /** Directories or archives the CLI loads as plugins for this session. */
  pluginDirs?: string[];
  /** Tools the CLI may use without asking, in the CLI's own rule syntax. */
  allowedTools?: string[];
  /** More tools the model may call, run in this process with the room's tools. */
  additionalTools?: McpToolRegistration[];
  enableMemoryTools?: boolean;
  /** Exposes the room's board and task tools; Band serves them only with the `tasks` capability. */
  enableTaskTools?: boolean;
  /**
   * Set to ask the host about each tool use, native or MCP. Unset, every request
   * is declined: a Band agent never approves its own tool calls by default.
   * `signal` aborts with a {@link ClaudePermissionEndReason}, and an answer
   * arriving after that is discarded.
   */
  resolvePermission?: (prompt: ClaudePermissionPrompt, signal: AbortSignal) => Promise<ClaudePermissionDecision | undefined>;
  /** Only meaningful with `resolvePermission`. Defaults to five minutes. */
  permissionTimeoutMs?: number;
  /** Defaults to an hour; on expiry the turn fails and its process is retired. */
  turnTimeoutMs?: number;
  /** Overrides the CLI version floor, for a host that pins its own CLI. */
  minimumVersion?: string;
  /** Extra MCP servers beside Band's, each under its own name. Never overrides Band's entry. */
  extraMcpServers?: Record<string, ClaudeMcpServerConfig>;
  logger?: Logger;
  /** Starts the CLI process; must start one dedicated to this room's turn. */
  spawnProcess?: ClaudeProcessFactory;
  /** Builds the room's Band MCP backend; replaced in tests that need no network. */
  mcpBackendFactory?: typeof createBandMcpBackend;
  /** Overrides the handshake floor and timeouts in tests that drive a fake process. */
  startConfig?: ClaudeCliStartConfig;
}

/** What one room's engine is built from: the adapter's options, bound to that room. */
export interface ClaudeRoomAgentOptions extends Omit<ClaudeCliAdapterOptions, "command" | "cwd" | "workspaceForRoom"> {
  command: string[];
  /** The room's claimed workspace; its process runs here. */
  cwd: string;
  roomId: string;
  /** Where the room reports local events; nothing sent here is posted. */
  observer?: AgentEventListener;
}

/**
 * One CLI process and the Band access it was given. A generation is bound to
 * exactly one turn, and once closed it answers nothing: a request that arrives
 * late — an MCP call the model queued, or a permission decision a host sat on —
 * is refused rather than run against the next turn's tools.
 */
interface Generation {
  readonly id: number;
  client: ClaudeCliClient;
  backend: BandMcpBackend;
  /** The turn this generation serves; set once, by `bind`. */
  tools?: TurnTools;
  bound: boolean;
  revoked: boolean;
  readonly permissions: Set<AbortController>;
  /** Tool uses this generation has already answered; a second ask is refused. */
  readonly settled: Set<string>;
  endReason: ClaudePermissionEndReason;
  closed: boolean;
}

/** The turn holding the room. */
interface ActiveTurn {
  cancelled: boolean;
  readonly cancellation: Deferred<void>;
  readonly tools: TurnTools;
  readonly native: ReturnType<typeof trackNativeActivity>;
  /** The assistant's text, message by message, for the closing reply. */
  readonly texts: string[];
  /** Native tool calls started and not yet ended, by tool-use id. */
  readonly calls: Map<string, string>;
  /** Redacted tool records, posted when the turn ends and dropped when it is cancelled. */
  readonly events: Array<{ content: string; messageType: "tool_call" | "tool_result"; metadata: Record<string, unknown> }>;
  usage: ClaudeTurnUsage;
  /** The terminal result frame, when the CLI wrote one. */
  result: ClaudeResultFrame | null;
  /** Set only while this turn's prompt is in flight; a cancel interrupts it. */
  client?: ClaudeCliClient;
}

class ClaudeTurnCancelledError extends Error {}

class ClaudeTurnTimeoutError extends Error {}

class ClaudeResumeFailedError extends Error {}

const TURN_CANCELLED = Symbol("turn-cancelled");
const START_SUPERSEDED = "Claude CLI start superseded by stop()";

/**
 * One room's Claude Code session, driven as a sequence of CLI processes: at most
 * one process lives in a room at a time, each turn runs in its own process
 * resumed with `--resume`, and the session id belongs to this engine and
 * workspace alone. A process is never left beside the one the room is using.
 */
export class ClaudeCliRoomAgent extends SimpleAdapter<ClaudeCliSessionState, TurnTools> {
  protected readonly provider = "claude-cli";
  private readonly roomId: string;
  private readonly command: string[];
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly customSection?: string;
  private readonly model?: string;
  private readonly effort?: ClaudeCliAdapterOptions["effort"];
  private readonly permissionMode?: ClaudeCliAdapterOptions["permissionMode"];
  private readonly pluginDirs: readonly string[];
  private readonly allowedTools: readonly string[];
  private readonly additionalTools: readonly McpToolRegistration[];
  private readonly enableMemoryTools: boolean;
  private readonly enableTaskTools: boolean;
  private readonly resolvePermission?: ClaudeCliAdapterOptions["resolvePermission"];
  private readonly permissionTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly minimumVersion?: string;
  private readonly extraMcpServers: Record<string, ClaudeMcpServerConfig>;
  private readonly spawnProcess: ClaudeProcessFactory;
  private readonly mcpBackendFactory: typeof createBandMcpBackend;
  private readonly startConfig: ClaudeCliStartConfig;
  private readonly logger: Logger;
  private readonly observer: AgentEventListener;
  /** Extra tools the host executes; like Band's own, they are not the model's work. */
  private readonly localToolNames: ReadonlySet<string>;
  private readonly turns = createRoomTurnLock();
  private activeTurn: ActiveTurn | undefined;
  private live: Generation | null = null;
  private starting: Promise<Generation> | null = null;
  /** Bumped by `stop()`, so a start still in flight installs nothing. */
  private generation = 0;
  private started = false;
  private systemPrompt = "";
  /** The session this room's engine owns; cleared by a reset, never by another room. */
  private sessionId: string | null = null;
  private owesReplay = true;
  private lastTurnUsage: ClaudeTurnUsage = { available: false, byModel: null, reason: "no turn has run yet" };
  /** The room's history as its first turn saw it; a replacement session is seeded from both. */
  private bootstrapHistory: ClaudeCliSessionState | undefined;

  public constructor(options: ClaudeRoomAgentOptions) {
    super();
    this.roomId = options.roomId;
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env;
    this.customSection = options.customSection;
    this.model = options.model;
    this.effort = options.effort;
    this.permissionMode = options.permissionMode;
    this.pluginDirs = options.pluginDirs ?? [];
    this.allowedTools = options.allowedTools ?? [];
    this.additionalTools = options.additionalTools ?? [];
    this.enableMemoryTools = options.enableMemoryTools ?? false;
    this.enableTaskTools = options.enableTaskTools ?? false;
    this.resolvePermission = options.resolvePermission;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    assertTurnTimeoutMs(turnTimeoutMs);
    this.turnTimeoutMs = turnTimeoutMs;
    this.minimumVersion = options.minimumVersion;
    this.extraMcpServers = options.extraMcpServers ?? {};
    this.spawnProcess = options.spawnProcess ?? spawnClaudeProcess;
    this.mcpBackendFactory = options.mcpBackendFactory ?? createBandMcpBackend;
    this.startConfig = options.startConfig ?? {};
    this.logger = resolveLogger(options.logger);
    this.observer = options.observer ?? (() => {});
    this.localToolNames = new Set([
      ...this.additionalTools.map((registration) => registration.name),
      ...DENIED_CLAUDE_CLI_TOOLS,
    ]);
    assertPermissionTimeoutMs(this.permissionTimeoutMs);
  }

  /** What the last completed turn spent; unavailable, never assumed, until one has. */
  public get usage(): ClaudeTurnUsage {
    return this.lastTurnUsage;
  }

  /** The session this room is continuing, or null before the CLI has named one. */
  public get session(): string | null {
    return this.sessionId;
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
   * Starts a process and initializes it without prompting it, so the room is
   * ready before its first message. Its Band access stays closed until the
   * first turn binds to it, and only ever binds once.
   */
  public async warm(): Promise<RoomAgentIdentity> {
    const generation = await this.ensureGeneration();
    const identity = generation.client.claudeIdentity;
    if (!identity) {
      throw new ClaudeProcessError("the Claude CLI process was started without initializing");
    }
    return { protocol: CLAUDE_PROTOCOL, cliVersion: identity.cliVersion };
  }

  public async onMessage(
    message: PlatformMessage,
    tools: TurnTools,
    history: ClaudeCliSessionState,
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
        native: trackNativeActivity(tools, this.localToolNames),
        texts: [],
        calls: new Map(),
        events: [],
        usage: { available: false, byModel: null, reason: "the turn produced no usage" },
        result: null,
      };
      this.activeTurn = turn;
      try {
        await this.runTurn(message, turn, participantsMessage, contactsMessage, history);
      } finally {
        turn.native.endAll();
        const live = this.live;
        if (live) this.endPermissions(live, live.endReason ?? "no-answer");
        if (this.activeTurn === turn) this.activeTurn = undefined;
      }
    });
  }

  /**
   * Cancels the room's running turn: the turn's Band access is closed first, so
   * nothing it was asked to do runs afterwards; its pending approvals are given
   * up on; the CLI is told to interrupt; and the turn still ends only when the
   * CLI writes its own terminal result. A cancelled turn posts nothing. Resolves
   * false when no turn holds the room.
   */
  public async cancelTurn(_roomId: string): Promise<boolean> {
    const turn = this.activeTurn;
    if (!turn) {
      return false;
    }
    turn.cancelled = true;
    turn.cancellation.resolve();
    const generation = this.live;
    if (generation) {
      this.revoke(generation, "turn-cancelled");
      this.endPermissions(generation, "turn-cancelled");
      if (turn.client) {
        try {
          await withTimeout(
            generation.client.interrupt(),
            INTERRUPT_ACK_TIMEOUT_MS,
            `the Claude CLI did not acknowledge the interrupt within ${INTERRUPT_ACK_TIMEOUT_MS}ms`,
          );
        } catch (error) {
          // The turn still ends on its own result, or fails with the process.
          this.logger.warn("claude_cli.interrupt_failed", { roomId: this.roomId, error: asErrorMessage(error) });
        }
      }
    }
    return true;
  }

  public async onCleanup(_roomId: string): Promise<void> {
    const generation = this.live;
    this.activeTurn = undefined;
    if (generation) this.retire(generation, "room-closed");
    this.turns.release(this.roomId);
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop();
  }

  /** Clears the room's session with its engine: a rejoin starts a new session from the room's history. */
  public async stop(): Promise<void> {
    this.generation += 1;
    this.started = false;
    const generation = this.live;
    this.live = null;
    this.starting = null;
    this.sessionId = null;
    this.owesReplay = true;
    if (generation) this.retire(generation, "adapter-stopped");
    this.turns.clear();
  }

  private async runTurn(
    message: PlatformMessage,
    turn: ActiveTurn,
    participantsMessage: string | null,
    contactsMessage: string | null,
    history: ClaudeCliSessionState,
  ): Promise<void> {
    let generation: Generation | undefined;
    const resuming = this.sessionId !== null;
    const pending = this.ensureGeneration();
    try {
      generation = await this.untilCancelled(turn, pending);
      if (!generation.bound) {
        this.bind(generation, turn);
      }
      const liveMessage = [...systemUpdateParts(participantsMessage, contactsMessage), message.content].join("\n\n");
      const prompt = this.owesReplay
        ? [this.buildSystemContext(message), ...this.seeded(message.id, liveMessage, history)].join("\n\n")
        : liveMessage;
      if (turn.cancelled) {
        // Cancelled before its prompt was sent: there is nothing to tell the CLI.
        throw new ClaudeTurnCancelledError();
      }
      turn.client = generation.client;
      const outcome = await withTimeout(
        generation.client.runTurn(prompt, { onEvent: (event) => this.observeEvent(turn, generation!, event) }),
        this.turnTimeoutMs,
        () => new ClaudeTurnTimeoutError(),
      );
      turn.client = undefined;
      if (outcome.result.sessionId && outcome.result.sessionId !== this.sessionId && this.sessionId !== null) {
        throw new ClaudeResumeFailedError(
          `the Claude CLI answered with a different session (${this.sessionId} then ${outcome.result.sessionId})`,
        );
      }
      this.sessionId = outcome.result.sessionId ?? this.sessionId;
      turn.result = outcome.result;
      turn.usage = readUsage(outcome.result);
      this.lastTurnUsage = turn.usage;
      if (outcome.interrupted || turn.cancelled) {
        throw new ClaudeTurnCancelledError();
      }
      await this.postEvents(turn);
      this.owesReplay = false;
      await relayReply(turn.tools, turn.texts.join("\n\n"), [{ id: message.senderId, handle: message.senderName ?? message.senderType }]);
      if (turn.result.isError || (turn.result.subtype && turn.result.subtype !== "success")) {
        await reportTurnFailure(
          turn.tools,
          agentFailure(
            this.provider,
            turn.result.errors.join(" ") || `the Claude CLI ended the turn as ${turn.result.subtype || "unknown"}.`,
            turn.result.subtype,
          ),
          this.logger,
          { roomId: this.roomId },
        );
      }
    } catch (error) {
      rethrowIfRecoverableTurnFailure(error);
      if (!generation) {
        // A process that finished starting for a turn that already ended must
        // not sit beside the room's next one.
        void pending.then((started) => this.close(started));
      }
      if (error instanceof ClaudeTurnCancelledError) {
        // A host's cancel ends the turn quietly: what the model produced is
        // dropped, and the error-shaped result the CLI wrote is not a failure.
        turn.tools.turn.settle();
        return;
      }
      await this.postEvents(turn);
      if (generation) this.retire(generation, "connection-lost");
      if (error instanceof ClaudeTurnTimeoutError) {
        await reportTurnFailure(
          turn.tools,
          agentFailure(this.provider, "Claude turn timed out.", FAILURE_CODE_TIMEOUT),
          this.logger,
          { roomId: this.roomId },
        );
        return;
      }
      if (error instanceof ClaudeResumeFailedError || (resuming && error instanceof ClaudeProcessError)) {
        // A resume that did not hold is reported, never quietly replaced: the
        // room is told what failed, and only then does the engine fall back to
        // seeding the next turn from the room's history.
        this.sessionId = null;
        this.owesReplay = true;
        this.logger.warn("claude_cli.resume_failed", { roomId: this.roomId, error: asErrorMessage(error) });
        await reportTurnFailure(
          turn.tools,
          agentFailure(this.provider, `resuming this room's Claude session failed: ${asErrorMessage(error)}`, "resume_failed"),
          this.logger,
          { roomId: this.roomId },
        );
        return;
      }
      await reportTurnFailure(turn.tools, agentFailure(this.provider, asErrorMessage(error)), this.logger, { roomId: this.roomId });
    } finally {
      // The turn is over, so its process is too: it is drained and closed, and
      // only its session id outlives it.
      if (generation) await this.close(generation);
    }
  }

  /** The live message, framed under the room's history when there is any to replay. */
  private seeded(messageId: string, liveMessage: string, history: ClaudeCliSessionState): string[] {
    const seen = new Set([messageId]);
    const lines: string[] = [];
    const entries = [...(this.bootstrapHistory?.replayMessages ?? []), ...(history.replayMessages ?? [])];
    for (const entry of entries) {
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

  // A cancel ends the turn's wait, not `operation`: it runs on, so a process it
  // started stays for the room's next turn.
  private async untilCancelled<T>(turn: ActiveTurn, operation: Promise<T>): Promise<T> {
    const cancelled = turn.cancellation.promise.then((): typeof TURN_CANCELLED => TURN_CANCELLED);
    const winner = await Promise.race([operation, cancelled]);
    if (winner === TURN_CANCELLED) {
      void operation.catch((error: unknown) => {
        this.logger.warn("claude_cli.cancelled_turn_wait_failed", { roomId: this.roomId, error: asErrorMessage(error) });
      });
      throw new ClaudeTurnCancelledError();
    }
    return winner;
  }

  /** The room's live process, starting one when the room has none. */
  private async ensureGeneration(): Promise<Generation> {
    if (this.live) {
      return this.live;
    }
    if (!this.started) {
      throw new Error("ClaudeCliAdapter was not started");
    }
    if (!this.starting) {
      const starting = this.startGeneration().finally(() => {
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private async startGeneration(): Promise<Generation> {
    const generationId = this.generation;
    const generation: Generation = {
      id: generationId,
      // Replaced below, once the client and backend exist; both are needed together.
      client: undefined as unknown as ClaudeCliClient,
      backend: undefined as unknown as BandMcpBackend,
      bound: false,
      revoked: false,
      permissions: new Set(),
      settled: new Set(),
      endReason: "no-answer",
      closed: false,
    };
    let client: ClaudeCliClient | undefined;
    let backend: BandMcpBackend | undefined;
    try {
      backend = await this.mcpBackendFactory({
        kind: "http",
        enableMemoryTools: this.enableMemoryTools,
        enableTaskTools: this.enableTaskTools,
        // One resolution path: every call reaches the tools this generation was
        // bound to, and nothing once it is closed.
        getToolsForRoom: () => {
          if (generation.revoked) {
            throw new Error(CLOSED_GENERATION);
          }
          if (!generation.tools) {
            throw new Error("this warm Claude process has no turn bound to it yet");
          }
          return generation.tools;
        },
        additionalTools: [...this.additionalTools, this.permissionRegistration(generation)],
        multiRoom: false,
        // The single chokepoint every MCP call passes, so a closed generation
        // cannot be reached by a request that was already queued.
        execute: async (run) => {
          if (generation.revoked) {
            return { content: [{ type: "text", text: CLOSED_GENERATION }], isError: true };
          }
          return run();
        },
      });
      const url = backendUrl(backend);
      client = await ClaudeCliClient.start(
        this.spawnProcess,
        { command: this.claudeCommand(url, backend), cwd: this.cwd, env: this.env, logger: this.logger },
        this.startConfig,
      );
      if (generationId !== this.generation) {
        throw new Error(START_SUPERSEDED);
      }
      Object.assign(generation, { client, backend });
      this.live = generation;
      void client.failed.then(() => {
        // Still live means nothing here retired it: the process failed on its own.
        if (this.live === generation) {
          this.live = null;
          this.observer({ type: "room.failed", roomId: this.roomId, error: "the Claude CLI process ended" });
        }
      });
      return generation;
    } catch (error) {
      await client?.close({ drainMs: DRAIN_TIMEOUT_MS }).catch((closeError: unknown) => {
        this.logger.warn("claude_cli.close_after_start_failure", { roomId: this.roomId, error: asErrorMessage(closeError) });
      });
      await backend?.stop().catch((stopError: unknown) => {
        this.logger.warn("claude_cli.backend_stop_after_start_failure", { roomId: this.roomId, error: asErrorMessage(stopError) });
      });
      if (asErrorMessage(error) !== START_SUPERSEDED) {
        this.observer({ type: "room.failed", roomId: this.roomId, error: asErrorMessage(error) });
      }
      throw error;
    }
  }

  /** The CLI's argv: the transport flags, then the session's policy, then the host's. */
  private claudeCommand(bandUrl: string, backend: BandMcpBackend): string[] {
    const config = encodeMcpConfig(
      { type: "http", url: bandUrl, headers: { Authorization: `Bearer ${backend.authToken ?? ""}` } },
      this.extraMcpServers,
    );
    const args = [
      ...this.command,
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      // Nothing but what this adapter passes is loaded: no host MCP servers.
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(config),
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      `mcp__band__${CLAUDE_PERMISSION_TOOL}`,
      // No user, project or local settings, commands, plugins or hooks.
      "--setting-sources",
      NO_SETTING_SOURCES,
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.effort) {
      args.push("--effort", this.effort);
    }
    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode === "manual" ? "default" : this.permissionMode);
    }
    for (const dir of this.pluginDirs) {
      args.push("--plugin-dir", dir);
    }
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.allowedTools);
    }
    args.push("--disallowedTools", ...DENIED_CLAUDE_CLI_TOOLS);
    return args;
  }

  /** The callback the CLI asks when a tool use needs approval, on Band's server. */
  private permissionRegistration(generation: Generation): McpToolRegistration {
    return {
      name: CLAUDE_PERMISSION_TOOL,
      description: "Answers the host's permission prompts. Not for the model.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string", description: "The tool the CLI wants to use" },
          input: { type: "object", description: "The arguments it would use" },
          tool_use_id: { type: "string", description: "The tool use being approved" },
        },
        required: ["tool_name", "input", "tool_use_id"],
      },
      execute: (args) => this.decidePermission(generation, args),
    };
  }

  /**
   * One permission request, answered exactly once. A request the generation has
   * already answered — a retry, or a late ask after a cancel — is refused without
   * consulting the host, so Approve can never become a standing grant.
   */
  private async decidePermission(generation: Generation, args: Record<string, unknown>): Promise<McpToolResult> {
    const request = parsePermissionRequest(args);
    if (!request) {
      return refused("The permission request was malformed.");
    }
    if (generation.revoked || generation.settled.has(request.toolUseId)) {
      return refused("This turn is closed; the request was refused.");
    }
    generation.settled.add(request.toolUseId);
    const turn = this.activeTurn;
    if (turn) {
      this.observer({
        type: "approval.requested",
        roomId: this.roomId,
        toolCallId: request.toolUseId,
        toolName: request.toolName,
        options: [
          { optionId: "allow", name: "Approve once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      turn.native.wait(request.toolUseId);
    }
    let decision: ClaudePermissionDecision;
    try {
      decision = await this.askHost(generation, request);
    } finally {
      if (turn) turn.native.endWait(request.toolUseId);
    }
    this.observer({
      type: "approval.resolved",
      roomId: this.roomId,
      toolCallId: request.toolUseId,
      outcome: decision.behavior === "allow" ? "selected" : "cancelled",
      ...(decision.behavior === "allow" ? { optionId: "allow" } : {}),
    });
    return encodePermissionDecision(decision);
  }

  /** The host's answer, bounded by the permission timeout and the turn's end; anything else denies. */
  private async askHost(generation: Generation, request: ClaudePermissionRequest): Promise<ClaudePermissionDecision> {
    if (!this.resolvePermission) {
      // No host to ask: a Band agent does not approve its own tool calls.
      return { behavior: "deny", message: "No permission handler is configured, so this request was declined." };
    }
    const controller = new AbortController();
    generation.permissions.add(controller);
    const end = (reason: ClaudePermissionEndReason): void => {
      if (!controller.signal.aborted) {
        generation.endReason = reason;
        controller.abort(reason);
      }
    };
    const timer = setTimeout(() => end("timeout"), this.permissionTimeoutMs);
    const abandoned = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const prompt: ClaudePermissionPrompt = { ...request, roomId: this.roomId, sessionId: this.sessionId ?? "" };
    try {
      const answer = await Promise.race([
        Promise.resolve()
          .then(() => this.resolvePermission!(prompt, controller.signal))
          .catch((error: unknown) => {
            this.logger.warn("claude_cli.resolve_permission_failed", { roomId: this.roomId, error: asErrorMessage(error) });
            return undefined;
          }),
        abandoned,
      ]);
      // An answer landing after the request was given up on cannot reopen it.
      if (controller.signal.aborted || generation.revoked) {
        return { behavior: "deny", message: "This turn no longer waits for that decision." };
      }
      const decision = answer ?? { behavior: "deny", message: "The permission request was answered with nothing usable." };
      end("settled");
      return decision;
    } finally {
      clearTimeout(timer);
      generation.permissions.delete(controller);
    }
  }

  private bind(generation: Generation, turn: ActiveTurn): void {
    if (generation.bound) {
      throw new ClaudeProcessError("a Claude process serves one turn; this generation was already bound");
    }
    generation.bound = true;
    generation.tools = turn.tools;
  }

  /** Closes the generation's Band access; later calls are refused whatever asks for them. */
  private revoke(generation: Generation, reason: ClaudePermissionEndReason): void {
    generation.revoked = true;
    generation.endReason = reason;
  }

  private endPermissions(generation: Generation, reason: ClaudePermissionEndReason): void {
    generation.endReason = reason;
    for (const controller of generation.permissions) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  /** Ends the generation's access and takes its process down, reporting a drain that had to be forced. */
  private retire(generation: Generation, reason: ClaudePermissionEndReason): void {
    if (this.live === generation) {
      this.live = null;
    }
    this.revoke(generation, reason);
    this.endPermissions(generation, reason);
    void this.close(generation);
  }

  private async close(generation: Generation): Promise<void> {
    if (generation.closed) {
      return;
    }
    generation.closed = true;
    // One process per turn: whatever else happens, this generation is no longer
    // the room's live one, so the next turn starts a fresh process and resumes.
    if (this.live === generation) {
      this.live = null;
    }
    this.revoke(generation, generation.endReason);
    const report = await generation.client.close({ drainMs: DRAIN_TIMEOUT_MS });
    await generation.backend.stop().catch((error: unknown) => {
      this.logger.warn("claude_cli.backend_stop_failed", { roomId: this.roomId, error: asErrorMessage(error) });
    });
    if (!report.drained) {
      this.logger.warn("claude_cli.drain_failed", {
        roomId: this.roomId,
        signal: report.signalCode,
        exitCode: report.exitCode,
        stderr: bounded(report.stderr),
      });
    }
  }

  private observeEvent(turn: ActiveTurn, generation: Generation, event: ClaudeEvent): void {
    switch (event.type) {
      case "system_init":
        // The session the CLI named is this room's; a mismatch is the client's to refuse.
        this.sessionId = event.init.sessionId;
        return;
      case "text":
        if (event.text.trim()) turn.texts.push(event.text);
        this.observer({ type: "message", roomId: this.roomId, text: event.text });
        return;
      case "reasoning":
        // Streamed to the host only. What the CLI puts in a reply is text.
        this.observer({ type: "thought", roomId: this.roomId, text: event.text });
        return;
      case "tool_use":
        return this.startTool(turn, generation, event);
      case "tool_result":
        return this.endTool(turn, event);
      case "notice":
        // The CLI speaking for the host (an interrupted tool use); never a reply.
        this.logger.debug("claude_cli.notice", { roomId: this.roomId, text: event.text });
        return;
    }
  }

  /**
   * Band's registrations are served under the `mcp__band__` prefix, so a call to
   * one is the room action itself (or the permission callback), not work the
   * model did with its own tools.
   */
  private isLocallyExecuted(name: string): boolean {
    return name.startsWith(`mcp__${MCP_SERVER_NAME}__`) || this.localToolNames.has(name);
  }

  private startTool(turn: ActiveTurn, generation: Generation, event: Extract<ClaudeEvent, { type: "tool_use" }>): void {
    if (turn.calls.has(event.id)) return;
    turn.calls.set(event.id, event.name);
    this.observer({ type: "tool.call", roomId: this.roomId, toolCallId: event.id, name: event.name, input: event.input });
    if (this.isLocallyExecuted(event.name)) return;
    // A Band tool is the room action itself, and the permission callback is not
    // the model's work; only the CLI's own tools are reported as such.
    if (this.isLocallyExecuted(event.name)) return;
    turn.native.tool(event.id, event.name);
    this.post(turn, event.name, "tool_call", {
      tool_call_id: event.id,
      raw_input: redacted(event.input),
      status: "in_progress",
    });
  }

  private endTool(turn: ActiveTurn, event: Extract<ClaudeEvent, { type: "tool_result" }>): void {
    const name = turn.calls.get(event.toolUseId);
    if (name === undefined) return;
    turn.calls.delete(event.toolUseId);
    const status = event.isError ? "failed" : "completed";
    const output = textOf(event.content);
    this.observer({ type: "tool.result", roomId: this.roomId, toolCallId: event.toolUseId, status, output });
    if (this.isLocallyExecuted(name)) return;
    turn.native.end(event.toolUseId);
    this.post(turn, redactCredentialText(output), "tool_result", { tool_call_id: event.toolUseId, status });
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
}

/** A permission request that will not be considered: denied, and flagged to the CLI. */
function refused(message: string): McpToolResult {
  return { ...encodePermissionDecision({ behavior: "deny", message }), isError: true };
}

/**
 * The turn's usage, from the CLI's latest-turn field only. `total_cost_usd` and
 * `modelUsage` accumulate across every resumed turn of the session, so reading
 * them per turn would add the same spend again each time.
 */
function readUsage(result: ClaudeResultFrame): ClaudeTurnUsage {
  if (!result.modelUsageSinceLastResult) {
    return { available: false, byModel: null, reason: "the CLI reported no usage for this turn" };
  }
  return { available: true, byModel: result.modelUsageSinceLastResult, reason: null };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = block as Record<string, unknown>;
      return typeof record?.text === "string" ? record.text : record?.type === "image" ? "[image]" : "";
    })
    .join("\n");
}

/** Keeps a dying process's stderr out of the logs whole, and bounded. */
function bounded(value: string, max = 2_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * A copy of `value` for the room: values under credential-shaped keys are
 * withheld and credential-shaped text inside strings is masked.
 */
function redacted(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED_VALUE;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redacted(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? REDACTED_VALUE : redacted(entry, seen)]));
}

function backendUrl(backend: BandMcpBackend): string {
  const server = backend.server as { url?: string | null };
  const url = typeof server?.url === "string" ? server.url : null;
  if (!url) {
    throw new ValidationError("the Band MCP backend did not expose a URL");
  }
  return url;
}

/** Rejects a host argument that would override a flag the transport owns. */
export function validateClaudeArgs(extra: readonly string[] = []): string[] {
  for (const arg of extra) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if ((RESERVED_CLAUDE_FLAGS as readonly string[]).includes(flag)) {
      throw new ValidationError(`"${flag}" is reserved by the Claude CLI adapter and cannot be passed as a custom argument`);
    }
  }
  return [...extra];
}

export { encodePermissionDecision };
export type { ClaudeCliStartConfig };

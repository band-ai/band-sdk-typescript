/**
 * Drives one installed Claude Code CLI process over stream-json: a control
 * handshake, then at most one turn at a time. The CLI is launched directly,
 * with no shell, from the resolved executable the caller names.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { createDeferred, type Deferred } from "../../core/deferred";
import type { Logger } from "../../core/logger";
import { asOptionalRecord } from "../shared/coercion";
import { stopChildProcess } from "../shared/stopChildProcess";
import { withTimeout } from "../shared/withTimeout";
import {
  CLAUDE_CONTROL_SUBTYPE,
  CLAUDE_FRAME,
  CLAUDE_MAX_FRAME_BYTES,
  CLAUDE_MAX_STDERR_TAIL_BYTES,
  CLAUDE_PROTOCOL,
  checkClaudeCliVersion,
  encodeControlError,
  encodeControlRequest,
  encodeUserMessage,
  eventsFromAssistant,
  eventsFromUser,
  parseControlResponse,
  parseInitReport,
  parseInboundRequest,
  parseResult,
  parseSystemInit,
  type ClaudeEvent,
  type ClaudeInitReport,
  type ClaudeResultFrame,
} from "./protocol";

/** How long a starting process has to answer `initialize`. */
export const CLAUDE_START_TIMEOUT_MS = 30_000;
/** How long a process gets to leave on its own after stdin closes, before it is killed. */
export const CLAUDE_DRAIN_TIMEOUT_MS = 5_000;
/** How long a reported exit waits for stdout to end before it is judged anyway. */
export const EXIT_DRAIN_GRACE_MS = 1_000;
/** How many lines of stderr a dying process's diagnostic carries. */
const STDERR_TAIL_LINES = 20;

/** The CLI refused a control request; its process stays usable. */
export class ClaudeCliError extends Error {
  public constructor(
    public readonly subtype: string,
    message: string,
  ) {
    super(`Claude CLI ${subtype}: ${message}`);
    this.name = "ClaudeCliError";
  }
}

/** The process or its stdio can no longer be used: it exited, or broke the protocol. */
export class ClaudeProcessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClaudeProcessError";
  }
}

/** The CLI is not a version this client can drive, so nothing was ever asked of it. */
export class ClaudeVersionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClaudeVersionError";
  }
}

/** How a driven process ended. */
export interface ClaudeExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** One running CLI process as the client drives it. */
export interface ClaudeProcessHandle {
  stdin: Writable;
  stdout: Readable;
  /** Settles once the process has exited. */
  exited: Promise<ClaudeExitInfo>;
  /** Closes stdin so a process waiting for its next input can leave on its own. */
  endStdin(): void;
  /** The last lines the process wrote to stderr, for a diagnostic when it dies. */
  stderrTail(): string;
  /** Escalates from SIGTERM to SIGKILL until the process is gone. */
  stop(): Promise<void>;
}

export interface ClaudeProcessOptions {
  /** The resolved executable and its arguments; the first entry is never a shell. */
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  logger: Logger;
}

/**
 * Starts one CLI process. It must be dedicated to the caller: the adapter gives
 * every room its own, and every turn its own once a room resumes.
 */
export type ClaudeProcessFactory = (options: ClaudeProcessOptions) => Promise<ClaudeProcessHandle>;

/**
 * Spawns the command in the caller's workspace with no shell, so an argument
 * that looks like one is carried as data. The child stays in this process's
 * group, so a host that stops the group stops it too.
 */
export const spawnClaudeProcess: ClaudeProcessFactory = async ({ command, cwd, env, logger }) => {
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  // `once` rejects on the child's `error` event, so a missing executable fails the start.
  await once(child, "spawn");
  child.on("error", (error) => logger.warn("claude_cli.subprocess_error", { error: error.message }));
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    await stopChildProcess(child);
    throw new ClaudeProcessError("the Claude CLI process was started without piped stdio");
  }
  const tail: string[] = [];
  let tailBytes = 0;
  // An unread stderr pipe fills up and blocks the agent, so it is drained to a bound.
  createInterface({ input: stderr, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    tail.push(line);
    tailBytes += Buffer.byteLength(line) + 1;
    while (tail.length > STDERR_TAIL_LINES || (tail.length > 1 && tailBytes > CLAUDE_MAX_STDERR_TAIL_BYTES)) {
      tailBytes -= Buffer.byteLength(tail.shift() ?? "") + 1;
    }
  });
  const exited = new Promise<ClaudeExitInfo>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  });
  return {
    stdin,
    stdout,
    exited,
    endStdin: () => stdin.end(),
    stderrTail: () => tail.join("\n"),
    stop: () => stopChildProcess(child),
  };
};

/** What the process announced about itself during `initialize`. */
export interface ClaudeIdentity {
  protocol: typeof CLAUDE_PROTOCOL;
  cliVersion: string;
}

/** What a turn does with the CLI's events while it runs. */
export interface ClaudeTurnHandlers {
  /** Each frame's events, synchronously and in the order the CLI wrote them. */
  onEvent(event: ClaudeEvent): void;
}

/** How the turn's terminal `result` frame read, plus what this client did to it. */
export interface ClaudeTurnOutcome {
  result: ClaudeResultFrame;
  /** True when this client asked the CLI to interrupt the turn that produced it. */
  interrupted: boolean;
  /** The session the turn ran in, as the CLI reported it. */
  sessionId: string | null;
}

/** What happened when the process was asked to leave. */
export interface ClaudeDrainReport {
  /** True when the process exited after its stdin closed, with no signal needed. */
  drained: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** What the process wrote to stderr, bounded; the diagnostic for a failed drain. */
  stderr: string;
}

/** How a client is started; every field has a default the adapter relies on. */
export interface ClaudeCliStartConfig {
  /** Overrides the version floor, for a test or a caller that pins its own CLI. */
  minimumVersion?: string;
  startTimeoutMs?: number;
  /** Overrides the per-frame bound; a caller that expects large tool results raises it. */
  maxFrameBytes?: number;
}

interface PendingControl {
  subtype: string;
  answer: Deferred<Record<string, unknown> | Error>;
}

interface TurnRun {
  handlers: ClaudeTurnHandlers;
  result?: ClaudeResultFrame;
  interrupted: boolean;
  outcome: Deferred<ClaudeTurnOutcome | Error>;
  settled: boolean;
}

/**
 * One Claude CLI process. Control requests correlate by the `request_id` this
 * client mints, and at most one turn runs at a time: the CLI pipelines what it
 * reads from stdin, so a second turn would run inside the first one's tools.
 */
export class ClaudeCliClient {
  /** Settles with the failure that ended the transport; never rejects. */
  public readonly failed: Promise<ClaudeProcessError>;
  private readonly failure = createDeferred<ClaudeProcessError>();
  private readonly pending = new Map<string, PendingControl>();
  private readonly buffered: Buffer[] = [];
  private turn: TurnRun | null = null;
  /** Turn frames seen while no turn was subscribed; see {@link noteStrayTurnFrame}. */
  private strayTurnFrames = 0;
  private nextId = 0;
  private bufferedBytes = 0;
  private identity: ClaudeIdentity | null = null;
  private init: ClaudeInitReport | null = null;
  private sessionId: string | null = null;
  private error: ClaudeProcessError | null = null;
  private closing = false;
  /**
   * True once a turn's terminal `result` frame has been read, until the next turn
   * starts. A CLI that answers its turn and leaves is the normal one-turn
   * lifecycle, not a dead harness: without this, the process's own exit can be
   * judged before the reader has finished with what the CLI wrote, and the room
   * is told its harness died on a turn that had already been answered.
   */
  private lastTurnEndedWithResult = false;

  private constructor(
    private readonly handle: ClaudeProcessHandle,
    private readonly logger: Logger,
    private readonly maxFrameBytes: number,
  ) {
    this.failed = this.failure.promise;
    // Node can report `exit` while lines the CLI already wrote are still on their
    // way through the pipe, so the exit is judged only once stdout has ended and
    // every delivered frame has been parsed - bounded, so a wedged pipe cannot
    // hold a turn open forever.
    const stdoutSettled = new Promise<void>((resolve) => {
      handle.stdout.once("end", () => resolve());
      handle.stdout.once("close", () => resolve());
    });
    const stdoutDrained = Promise.race([
      stdoutSettled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXIT_DRAIN_GRACE_MS);
        timer.unref();
      }),
    ]);
    handle.stdout.on("data", (data: Buffer) => this.receive(data));
    handle.stdout.on("error", (error) => this.fail(new ClaudeProcessError(`Claude CLI stdout failed: ${error.message}`)));
    handle.stdin.on("error", (error) => this.fail(new ClaudeProcessError(`Claude CLI stdin failed: ${error.message}`)));
    void handle.exited.then(async (exit) => {
      await stdoutDrained;
      if (this.closing || this.lastTurnEndedWithResult || this.error) {
        // Either we asked it to leave, it answered its turn and left the way a
        // finished CLI does, or something else already ended this transport.
        // None of those is a harness that died on the room.
        return;
      }
      this.logger.warn("claude_cli.process_exited", {
        code: exit.code,
        signal: exit.signal,
        stderr: handle.stderrTail(),
      });
      this.fail(new ClaudeProcessError(`the Claude CLI process exited${exit.code === null ? "" : ` with code ${exit.code}`}`));
    });
  }

  /**
   * Starts a process, sends `initialize`, and refuses anything older than the
   * version floor. No turn is ever sent, so a start that fails leaves no
   * session and no process behind: the handle is stopped before the error lands.
   */
  public static async start(
    factory: ClaudeProcessFactory,
    options: ClaudeProcessOptions,
    config: ClaudeCliStartConfig = {},
  ): Promise<ClaudeCliClient> {
    const handle = await factory(options);
    const client = new ClaudeCliClient(handle, options.logger, config.maxFrameBytes ?? CLAUDE_MAX_FRAME_BYTES);
    try {
      const timeoutMs = config.startTimeoutMs ?? CLAUDE_START_TIMEOUT_MS;
      await withTimeout(client.handshake(config.minimumVersion), timeoutMs, () =>
        new ClaudeProcessError(`the Claude CLI did not initialize within ${timeoutMs}ms`),
      );
      return client;
    } catch (error) {
      client.closing = true;
      client.fail(error instanceof ClaudeProcessError ? error : new ClaudeProcessError(String((error as Error).message)));
      await handle.stop();
      throw error;
    }
  }

  /** What the process said about itself during `initialize`; null until it has. */
  public get claudeIdentity(): ClaudeIdentity | null {
    return this.identity;
  }

  /**
   * What `initialize` reported beyond the version: the permission mode the
   * session started in and the capabilities it offers this host. A caller that
   * must not assume either reads them here rather than re-parsing the frame.
   */
  public get initReport(): ClaudeInitReport | null {
    return this.init;
  }

  /** The session this process is running, once the CLI has named one. */
  public get session(): string | null {
    return this.sessionId;
  }

  /** True while a turn awaits its terminal result. */
  public get turnRunning(): boolean {
    return this.turn !== null;
  }

  /**
   * Runs one turn: sends the user envelope and awaits its terminal `result`
   * frame. A turn the CLI ended in error is still an outcome — the result frame
   * says so — while a process that dies first rejects with
   * {@link ClaudeProcessError}.
   */
  public async runTurn(text: string, handlers: ClaudeTurnHandlers): Promise<ClaudeTurnOutcome> {
    if (this.error) {
      throw this.error;
    }
    if (!this.identity) {
      throw new ClaudeProcessError("the Claude CLI process was never initialized");
    }
    if (this.turn) {
      throw new ClaudeProcessError("a turn is already running on this Claude CLI process");
    }
    const run: TurnRun = { handlers, interrupted: false, outcome: createDeferred(), settled: false };
    this.turn = run;
    this.lastTurnEndedWithResult = false;
    try {
      // A frame the CLI never received would otherwise wait for a result that
      // cannot arrive, so the write reports the break instead of swallowing it.
      const refused = this.write(encodeUserMessage(text));
      if (refused) {
        throw refused;
      }
      const outcome = await run.outcome.promise;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    } finally {
      if (this.turn === run) {
        this.turn = null;
      }
    }
  }

  /**
   * Asks the CLI to stop the running turn and resolves once it has accepted the
   * request. The turn itself ends later, with an error-shaped result frame, so
   * callers await {@link runTurn} rather than this to learn the turn is over.
   */
  public async interrupt(): Promise<void> {
    if (this.turn) {
      this.turn.interrupted = true;
    }
    await this.request(CLAUDE_CONTROL_SUBTYPE.interrupt);
  }

  /**
   * Closes stdin so the process can leave, waits `drainMs` for that, then stops
   * it for real. Returns only once the exit has been observed, so a caller never
   * leaves a running process behind, and reports whether the drain was clean.
   */
  public async close(options: { drainMs?: number } = {}): Promise<ClaudeDrainReport> {
    this.closing = true;
    this.handle.endStdin();
    const drained = await Promise.race([
      this.handle.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), options.drainMs ?? CLAUDE_DRAIN_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    await this.handle.stop();
    const exit = await this.handle.exited;
    // A CLI that saw its stdin close, wrote everything it had and left is a
    // transport that finished its work, not one that broke: no failure is recorded
    // for it, so a caller that closes a generation in order never looks to the room
    // like a harness that died. Anything still waiting on the process is released
    // either way; only a process we had to kill is reported as stopped.
    if (drained) {
      this.release(new ClaudeProcessError("the Claude CLI process ended"));
    } else {
      this.fail(new ClaudeProcessError("the Claude CLI process was stopped"));
    }
    return { drained, exitCode: exit.code, signalCode: exit.signal, stderr: this.handle.stderrTail() };
  }

  /** Sends a control request and resolves with its response payload. */
  public async request(subtype: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.error) {
      throw this.error;
    }
    const id = this.newId();
    const answer = createDeferred<Record<string, unknown> | Error>();
    this.pending.set(id, { subtype, answer });
    try {
      // Same window as a turn: a transport that broke during the write owes no answer.
      const refused = this.write(encodeControlRequest(id, { subtype, ...parameters }));
      if (refused) {
        throw refused;
      }
      const result = await answer.promise;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    } finally {
      this.pending.delete(id);
    }
  }

  /** What the CLI answered `initialize` with; the caller has already gated the version. */
  private async handshake(minimumVersion?: string): Promise<void> {
    const response = await this.request(CLAUDE_CONTROL_SUBTYPE.initialize);
    const report: ClaudeInitReport = parseInitReport(response);
    const checked = checkClaudeCliVersion(report.cliVersion, minimumVersion);
    if (!checked.ok) {
      throw new ClaudeVersionError(checked.message);
    }
    this.identity = { protocol: CLAUDE_PROTOCOL, cliVersion: checked.version };
    this.init = report;
    this.logger.debug("claude_cli.initialized", {
      cliVersion: checked.version,
      permissionMode: report.permissionMode,
      capabilities: report.capabilities,
    });
  }

  private newId(): string {
    this.nextId += 1;
    return `band-${this.nextId}`;
  }

  /** Writes one frame, or returns the failure that stopped the transport. */
  private write(frame: Record<string, unknown>): ClaudeProcessError | null {
    if (this.error) {
      return this.error;
    }
    this.handle.stdin.write(`${JSON.stringify(frame)}\n`);
    return null;
  }

  private fail(error: ClaudeProcessError): void {
    if (this.error) {
      return;
    }
    this.error = error;
    this.release(error);
    this.failure.resolve(error);
  }

  /**
   * Releases everything still waiting on the process - a control request that will
   * never be answered, a turn whose terminal frame never arrived - without marking
   * the transport broken. An orderly close has obligations to settle and no
   * failure to report.
   */
  private release(error: ClaudeProcessError): void {
    for (const pending of this.pending.values()) {
      pending.answer.resolve(error);
    }
    this.pending.clear();
    const run = this.turn;
    if (run && !run.settled) {
      run.settled = true;
      run.outcome.resolve(error);
    }
  }

  /**
   * Buffers raw bytes and splits on the newline byte. A multi-byte character
   * split across two chunks stays inside the buffer until its line is whole, so
   * no frame is ever decoded mid-codepoint, and an unterminated line is bounded
   * before it can grow without end.
   */
  private receive(data: Buffer): void {
    let start = 0;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
      this.buffered.push(data.subarray(start, newline));
      const line = Buffer.concat(this.buffered);
      this.buffered.length = 0;
      this.bufferedBytes = 0;
      start = newline + 1;
      if (line.length > this.maxFrameBytes) {
        return this.fail(new ClaudeProcessError(`Claude CLI frame exceeds the ${this.maxFrameBytes} byte limit`));
      }
      if (line.length > 0 && !this.dispatchLine(line)) {
        return;
      }
    }
    const rest = data.subarray(start);
    this.bufferedBytes += rest.length;
    if (this.bufferedBytes > this.maxFrameBytes) {
      return this.fail(new ClaudeProcessError(`Claude CLI frame exceeds the ${this.maxFrameBytes} byte limit`));
    }
    if (rest.length > 0) {
      this.buffered.push(rest);
    }
  }

  /** False once the line has ended the transport. */
  private dispatchLine(line: Buffer): boolean {
    if (this.error) {
      return false;
    }
    let frame: Record<string, unknown> | undefined;
    try {
      frame = asOptionalRecord(JSON.parse(line.toString("utf8")));
    } catch {
      frame = undefined;
    }
    if (!frame || typeof frame.type !== "string") {
      this.fail(new ClaudeProcessError("the Claude CLI wrote a line that is not a JSON object with a type"));
      return false;
    }
    try {
      if (this.noteStrayTurnFrame(frame)) {
        // Dropped as an anomaly, not a transport failure: the stream stays open.
        return !this.error;
      }
      this.dispatch(frame);
    } catch (error) {
      this.fail(
        error instanceof ClaudeProcessError
          ? error
          : new ClaudeProcessError(`Claude CLI frame could not be handled: ${(error as Error).message}`),
      );
      return false;
    }
    return !this.error;
  }

  /**
   * A turn frame is something the CLI only writes while a turn is running: it
   * answers a prompt, carries its assistant output, opens its tool results, or
   * ends it. One arriving while no turn is subscribed is a protocol anomaly — the
   * real CLI cannot produce it — so it is counted and warned about by frame type,
   * and never delivered to a later turn. Additive informational frames (rate
   * limits, partial messages, hooks) are not turn frames and stay ignored.
   */
  private noteStrayTurnFrame(frame: Record<string, unknown>): boolean {
    if (this.turn) {
      return false;
    }
    const type = frame.type;
    const isTurnFrame =
      type === CLAUDE_FRAME.assistant ||
      type === CLAUDE_FRAME.user ||
      type === CLAUDE_FRAME.result ||
      (type === CLAUDE_FRAME.system && parseSystemInit(frame) !== null);
    if (!isTurnFrame) {
      return false;
    }
    this.strayTurnFrames += 1;
    this.logger.warn("claude_cli.stray_turn_frame", { frameType: String(type) });
    return true;
  }

  /** How many turn frames arrived while no turn was subscribed; see {@link noteStrayTurnFrame}. */
  public get strayTurnFrameCount(): number {
    return this.strayTurnFrames;
  }

  private dispatch(frame: Record<string, unknown>): void {
    this.observeSession(frame);
    switch (frame.type) {
      case CLAUDE_FRAME.controlResponse:
        return this.onControlResponse(frame);
      case CLAUDE_FRAME.controlRequest:
        return this.onInboundRequest(frame);
      case CLAUDE_FRAME.system: {
        const init = parseSystemInit(frame);
        if (!init) {
          return;
        }
        this.sessionId = init.sessionId;
        return this.emit({ type: "system_init", init });
      }
      case CLAUDE_FRAME.assistant:
        return this.emitAll(eventsFromAssistant(frame));
      case CLAUDE_FRAME.user:
        return this.emitAll(eventsFromUser(frame));
      case CLAUDE_FRAME.result: {
        const run = this.turn;
        if (!run || run.result) {
          return;
        }
        run.result = parseResult(frame);
        run.settled = true;
        this.lastTurnEndedWithResult = true;
        run.outcome.resolve({ result: run.result, interrupted: run.interrupted, sessionId: this.sessionId });
        return;
      }
      default:
        // Additive informational frames (rate limits, partial messages, hook
        // events) carry no obligation; a newer CLI may add any number of them.
        return;
    }
  }

  private emitAll(events: ClaudeEvent[]): void {
    for (const event of events) {
      this.emit(event);
    }
  }

  private emit(event: ClaudeEvent): void {
    const run = this.turn;
    if (run) {
      run.handlers.onEvent(event);
    }
  }

  /**
   * One process runs one session. A frame naming a different one means the CLI
   * switched transcripts under us, so its turns are no longer the turns this
   * client started: the transport is refused rather than mis-attributed.
   */
  private observeSession(frame: Record<string, unknown>): void {
    const id = typeof frame.session_id === "string" ? frame.session_id : null;
    if (id === null) {
      return;
    }
    if (this.sessionId === null) {
      this.sessionId = id;
    } else if (this.sessionId !== id) {
      throw new ClaudeProcessError(`the Claude CLI switched sessions mid-process (${this.sessionId} then ${id})`);
    }
  }

  private onControlResponse(frame: Record<string, unknown>): void {
    const response = parseControlResponse(frame);
    if (!response) {
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      // A stale or invented id answers nothing we asked. The request it names is
      // still owed, and ending a healthy process over a stray line would be a
      // worse failure than logging one.
      this.logger.warn("claude_cli.unmatched_response", { requestId: response.requestId });
      return;
    }
    if (response.ok) {
      pending.answer.resolve(response.response);
    } else {
      pending.answer.resolve(new ClaudeCliError(pending.subtype, response.error));
    }
  }

  /**
   * A `control_request` this client cannot serve is answered, not dropped: the
   * CLI waits for the answer, so silence would hang the turn instead of
   * surfacing that its host does not support the request.
   */
  private onInboundRequest(frame: Record<string, unknown>): void {
    const request = parseInboundRequest(frame);
    if (!request) {
      return;
    }
    this.logger.warn("claude_cli.unsupported_request", { subtype: request.subtype });
    this.write(encodeControlError(request.requestId, `this host cannot handle ${request.subtype}`));
  }
}

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
  OMP_COMMAND,
  OMP_EVENT_TYPES,
  OMP_FRAME,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_PROTOCOL_VERSION,
  OMP_UI_CANCEL,
  OMP_UI_NOTIFICATIONS,
  type OmpEvent,
  type OmpHostToolCall,
  type OmpPromptOutcome,
  type OmpPromptStatus,
  type OmpReady,
  type OmpToolResult,
  type OmpUIRequest,
  type OmpUIResponse,
} from "./protocol";

/** How long a starting process has to announce `ready` and accept the protocol. */
export const OMP_HANDSHAKE_TIMEOUT_MS = 30_000;
// How much of a dying process's stderr its exit warning carries.
const STDERR_TAIL_LINES = 20;
const PROMPT_STATUSES: ReadonlySet<string> = new Set<OmpPromptStatus>(["completed", "error", "aborted"]);

/** A command the agent refused; its process stays usable. */
export class OmpRpcError extends Error {
  public constructor(
    public readonly command: string,
    message: string,
    public readonly code?: string,
  ) {
    super(`OMP ${command}: ${message}`);
    this.name = "OmpRpcError";
  }
}

/** The process or its stdio can no longer be used: it exited, or broke the protocol. */
export class OmpProcessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OmpProcessError";
  }
}

/** One running OMP process as the client drives it. */
export interface OmpProcessHandle {
  stdin: Writable;
  stdout: Readable;
  /** Settles once the process has exited, with its code when it set one. */
  exited: Promise<number | null>;
  /** The last lines the process wrote to stderr, for a warning when it dies. */
  stderrTail(): string;
  stop(): Promise<void>;
}

export interface OmpProcessOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  logger: Logger;
}

/**
 * Starts one OMP process. Must start a process dedicated to the caller: the
 * adapter gives every room its own.
 */
export type OmpProcessFactory = (options: OmpProcessOptions) => Promise<OmpProcessHandle>;

/**
 * Spawns the command in the room's workspace. It stays in this process's
 * group, so a host that stops the group stops it too.
 */
export const spawnOmpProcess: OmpProcessFactory = async ({ command, cwd, env, logger }) => {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // `once` rejects on the child's `error` event, so a missing binary fails the start.
  await once(child, "spawn");
  child.on("error", (error) => logger.warn("omp_rpc.subprocess_error", { error: error.message }));
  const tail: string[] = [];
  // An unread stderr pipe fills up and blocks the agent.
  createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    tail.push(line);
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
  });
  const exited = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exited,
    stderrTail: () => tail.join("\n"),
    stop: () => stopChildProcess(child),
  };
};

/** What a prompt does with the agent's events and requests while it runs. */
export interface OmpPromptHandlers {
  /** Each agent-loop event, synchronously and in order. */
  onEvent(event: OmpEvent): void;
  /** Runs a host tool. `signal` aborts when the agent withdraws the call. */
  onHostTool(call: OmpHostToolCall, signal: AbortSignal): Promise<OmpToolResult>;
  /** Answers a dialog. `signal` aborts when the agent withdraws it. */
  onUiRequest(request: OmpUIRequest, signal: AbortSignal): Promise<OmpUIResponse>;
}

interface PendingRequest {
  command: string;
  answer: Deferred<Record<string, unknown> | Error>;
}

interface PromptRun {
  id: string;
  handlers: OmpPromptHandlers;
  result?: OmpPromptOutcome;
  outcome: Deferred<OmpPromptOutcome | Error>;
  /** Callbacks in flight, keyed by kind and request id; aborting one withdraws it. */
  callbacks: Map<string, AbortController>;
}

interface Chunks {
  chunkId: string;
  count: number;
  byteLength: number;
  next: number;
  parts: Buffer[];
  received: number;
}

/**
 * One OMP process over its native RPC mode: request/response correlation,
 * and at most one prompt at a time. A prompt ends only when its own
 * `prompt_result` has arrived and the session has then settled; a command's
 * response, `abort`'s included, never ends it.
 */
export class OmpRpcClient {
  /** Settles with the failure that ended the transport; never rejects. */
  public readonly failed: Promise<OmpProcessError>;
  private readonly failure = createDeferred<OmpProcessError>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready = createDeferred<OmpReady | Error>();
  private run: PromptRun | null = null;
  private nextId = 0;
  private maxFrameBytes = OMP_MAX_FRAME_BYTES;
  private maxReassembledBytes = OMP_MAX_REASSEMBLED_FRAME_BYTES;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private chunks: Chunks | null = null;
  private error: OmpProcessError | null = null;
  private closing = false;

  private constructor(
    private readonly handle: OmpProcessHandle,
    private readonly logger: Logger,
  ) {
    this.failed = this.failure.promise;
    handle.stdout.on("data", (data: Buffer) => this.receive(data));
    handle.stdout.on("error", (error) => this.fail(new OmpProcessError(`OMP RPC stdout failed: ${error.message}`)));
    handle.stdin.on("error", (error) => this.fail(new OmpProcessError(`OMP RPC stdin failed: ${error.message}`)));
    void handle.exited.then((code) => {
      if (this.closing) return;
      this.logger.warn("omp_rpc.process_exited", { code, stderr: handle.stderrTail() });
      this.fail(new OmpProcessError(`The OMP agent process exited${code === null ? "" : ` with code ${code}`}`));
    });
  }

  /**
   * Starts a process and waits for its unsolicited `ready`, then moves it to
   * protocol {@link OMP_RPC_PROTOCOL_VERSION}. No prompt is sent.
   */
  public static async start(factory: OmpProcessFactory, options: OmpProcessOptions): Promise<OmpRpcClient> {
    const handle = await factory(options);
    const client = new OmpRpcClient(handle, options.logger);
    try {
      await withTimeout(client.handshake(), OMP_HANDSHAKE_TIMEOUT_MS, `OMP did not become ready within ${OMP_HANDSHAKE_TIMEOUT_MS}ms`);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /** Sends a command and resolves with its `data`; a refusal rejects with {@link OmpRpcError}. */
  public async request(command: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.send(command, parameters, this.newId());
  }

  /**
   * Runs one prompt to its end. Resolves with the prompt's own outcome,
   * `aborted` included; rejects with {@link OmpRpcError} when the agent
   * refuses it, or {@link OmpProcessError} when the process fails under it.
   */
  public async prompt(message: string, handlers: OmpPromptHandlers): Promise<OmpPromptOutcome> {
    if (this.run) {
      throw new Error("An OMP prompt is already running on this process");
    }
    const run: PromptRun = { id: this.newId(), handlers, outcome: createDeferred(), callbacks: new Map() };
    this.run = run;
    try {
      const accepted = await this.send(OMP_COMMAND.prompt, { message }, run.id);
      // A local command (a slash command) runs no agent and owes no result.
      if (accepted.agentInvoked === false) {
        run.outcome.resolve({ status: "completed" });
      }
      const outcome = await run.outcome.promise;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } finally {
      for (const controller of run.callbacks.values()) controller.abort();
      if (this.run === run) this.run = null;
    }
  }

  /**
   * Asks the agent to end its running prompt, resolving once it agrees. The
   * prompt itself ends later, when its `prompt_result` reports `aborted`.
   */
  public async abort(): Promise<void> {
    await this.request(OMP_COMMAND.abort);
  }

  /** Stops the process; requests and a prompt still waiting fail. */
  public async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.fail(new OmpProcessError("The OMP agent process was stopped"));
    }
    await this.handle.stop();
  }

  private async handshake(): Promise<void> {
    const ready = await Promise.race([this.ready.promise, this.failure.promise]);
    if (ready instanceof Error) throw ready;
    if (!ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION)) {
      throw new OmpProcessError(`OMP RPC protocol v${OMP_RPC_PROTOCOL_VERSION} is required; this OMP offers ${ready.supportedProtocolVersions.join(", ")}`);
    }
    const negotiated = await this.request(OMP_COMMAND.negotiateProtocol, { protocolVersion: OMP_RPC_PROTOCOL_VERSION });
    if (negotiated.protocolVersion !== OMP_RPC_PROTOCOL_VERSION) {
      throw new OmpProcessError(`OMP did not accept RPC protocol v${OMP_RPC_PROTOCOL_VERSION}`);
    }
  }

  private newId(): string {
    this.nextId += 1;
    return `band-${this.nextId}`;
  }

  private async send(command: string, parameters: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
    if (this.error) throw this.error;
    const answer = createDeferred<Record<string, unknown> | Error>();
    this.pending.set(id, { command, answer });
    try {
      this.write({ ...parameters, id, type: command });
      const result = await answer.promise;
      if (result instanceof Error) throw result;
      return result;
    } finally {
      this.pending.delete(id);
    }
  }

  private write(frame: Record<string, unknown>): void {
    if (this.error) return;
    this.handle.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private receive(data: Buffer): void {
    let start = 0;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
      this.buffered.push(data.subarray(start, newline));
      const line = Buffer.concat(this.buffered);
      this.buffered = [];
      this.bufferedBytes = 0;
      start = newline + 1;
      if (line.length + 1 > this.maxFrameBytes) {
        return this.fail(new OmpProcessError("OMP RPC frame exceeds the announced limit"));
      }
      if (line.length > 0 && !this.dispatchLine(line)) return;
    }
    const rest = data.subarray(start);
    this.bufferedBytes += rest.length;
    if (this.bufferedBytes + 1 > this.maxFrameBytes) {
      return this.fail(new OmpProcessError("OMP RPC frame exceeds the announced limit"));
    }
    if (rest.length > 0) this.buffered.push(rest);
  }

  /** False once the line has ended the transport. */
  private dispatchLine(line: Buffer): boolean {
    if (this.error) return false;
    let frame: Record<string, unknown> | undefined;
    try {
      frame = asOptionalRecord(JSON.parse(line.toString("utf8")));
    } catch {
      frame = undefined;
    }
    if (!frame || typeof frame.type !== "string") {
      this.fail(new OmpProcessError("OMP RPC sent a frame that is not a JSON object with a type"));
      return false;
    }
    try {
      const whole = this.reassemble(frame);
      if (whole) this.dispatch(whole);
    } catch (error) {
      this.fail(error instanceof OmpProcessError ? error : new OmpProcessError(`OMP RPC frame could not be handled: ${(error as Error).message}`));
      return false;
    }
    return !this.error;
  }

  /** The frame, or the frame a completed `rpc_chunk` sequence carried; null while one is incomplete. */
  private reassemble(frame: Record<string, unknown>): Record<string, unknown> | null {
    if (frame.type !== OMP_FRAME.chunk) {
      if (this.chunks) throw new OmpProcessError("OMP RPC chunk sequence was interrupted");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !isCount(index) || !isCount(count) || !isCount(byteLength) || typeof data !== "string"
      || index >= count || byteLength > this.maxReassembledBytes) {
      throw new OmpProcessError("OMP RPC sent an invalid chunk");
    }
    if (!this.chunks) {
      if (index !== 0) throw new OmpProcessError("OMP RPC chunks must start at index zero");
      this.chunks = { chunkId, count, byteLength, next: 0, parts: [], received: 0 };
    }
    const chunks = this.chunks;
    if (chunks.chunkId !== chunkId || chunks.count !== count || chunks.byteLength !== byteLength || chunks.next !== index) {
      throw new OmpProcessError("OMP RPC chunk sequence does not match");
    }
    const part = Buffer.from(data, "base64");
    chunks.parts.push(part);
    chunks.received += part.length;
    chunks.next += 1;
    if (chunks.received > chunks.byteLength) throw new OmpProcessError("OMP RPC chunks exceed their declared length");
    if (chunks.next < chunks.count) return null;
    this.chunks = null;
    if (chunks.received !== chunks.byteLength) throw new OmpProcessError("OMP RPC chunks fall short of their declared length");
    const whole = asOptionalRecord(JSON.parse(Buffer.concat(chunks.parts).toString("utf8")));
    if (!whole || typeof whole.type !== "string" || whole.type === OMP_FRAME.chunk) {
      throw new OmpProcessError("OMP RPC chunks did not carry one frame");
    }
    return whole;
  }

  private dispatch(frame: Record<string, unknown>): void {
    const run = this.run;
    switch (frame.type) {
      case OMP_FRAME.ready:
        return this.onReady(frame);
      case OMP_FRAME.frameError:
        throw new OmpProcessError(`OMP RPC reported a frame it could not take: ${String(frame.error)}`);
      case OMP_FRAME.response:
        return this.onResponse(frame);
      case OMP_FRAME.promptResult:
        if (run && frame.id === run.id && !run.result) {
          if (typeof frame.status !== "string" || !PROMPT_STATUSES.has(frame.status)) {
            throw new OmpProcessError("OMP RPC sent a prompt_result with an unknown status");
          }
          const error = asOptionalRecord(frame.error);
          run.result = {
            status: frame.status as OmpPromptStatus,
            ...(error && typeof error.message === "string" ? { error: { message: error.message } } : {}),
          };
        }
        return;
      case OMP_FRAME.sessionSettled:
        // The single end of a prompt: only a settle after its result counts.
        if (run?.result) run.outcome.resolve(run.result);
        return;
      case OMP_FRAME.hostToolCall:
        return this.onHostToolCall(frame);
      case OMP_FRAME.hostToolCancel:
        if (typeof frame.targetId === "string") this.withdraw(`tool:${frame.targetId}`);
        return;
      case OMP_FRAME.uiRequest:
        return this.onUiRequest(frame);
      default:
        if (run && OMP_EVENT_TYPES.has(frame.type as string)) {
          run.handlers.onEvent(frame as unknown as OmpEvent);
        }
    }
  }

  private onReady(frame: Record<string, unknown>): void {
    const { protocolVersion, supportedProtocolVersions, maxFrameBytes, maxReassembledFrameBytes } = frame;
    if (typeof protocolVersion !== "number" || !Array.isArray(supportedProtocolVersions)
      || !isCount(maxFrameBytes) || maxFrameBytes === 0 || maxFrameBytes > OMP_MAX_FRAME_BYTES
      || !isCount(maxReassembledFrameBytes) || maxReassembledFrameBytes === 0 || maxReassembledFrameBytes > OMP_MAX_REASSEMBLED_FRAME_BYTES) {
      throw new OmpProcessError("OMP RPC sent an invalid ready frame");
    }
    this.maxFrameBytes = maxFrameBytes;
    this.maxReassembledBytes = maxReassembledFrameBytes;
    this.ready.resolve({
      type: "ready",
      protocolVersion,
      supportedProtocolVersions: supportedProtocolVersions.filter((version): version is number => typeof version === "number"),
      maxFrameBytes,
      maxReassembledFrameBytes,
    });
  }

  private onResponse(frame: Record<string, unknown>): void {
    const pending = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
    if (!pending) {
      this.logger.debug("omp_rpc.unmatched_response", { command: frame.command });
      return;
    }
    if (frame.command !== pending.command) {
      throw new OmpProcessError(`OMP RPC answered ${pending.command} as ${String(frame.command)}`);
    }
    if (frame.success === true) {
      pending.answer.resolve(asOptionalRecord(frame.data) ?? {});
    } else {
      const message = typeof frame.error === "string" && frame.error ? frame.error : "command failed";
      pending.answer.resolve(new OmpRpcError(pending.command, message, typeof frame.code === "string" ? frame.code : undefined));
    }
  }

  private onHostToolCall(frame: Record<string, unknown>): void {
    const { id, toolCallId, toolName } = frame;
    if (typeof id !== "string" || typeof toolCallId !== "string" || typeof toolName !== "string") {
      throw new OmpProcessError("OMP RPC sent an invalid host_tool_call");
    }
    const call: OmpHostToolCall = { id, toolCallId, toolName, arguments: asOptionalRecord(frame.arguments) ?? {} };
    const run = this.run;
    if (!run) {
      this.writeToolResult(id, { content: [{ type: "text", text: "No turn is running." }], isError: true });
      return;
    }
    this.answer(run, `tool:${id}`, (signal) => run.handlers.onHostTool(call, signal), (result) => this.writeToolResult(id, result),
      (error) => this.writeToolResult(id, { content: [{ type: "text", text: error.message }], isError: true }));
  }

  private onUiRequest(frame: Record<string, unknown>): void {
    const { id, method } = frame;
    if (typeof id !== "string" || typeof method !== "string") {
      throw new OmpProcessError("OMP RPC sent an invalid extension_ui_request");
    }
    if (OMP_UI_NOTIFICATIONS.has(method)) return;
    if (method === OMP_UI_CANCEL) {
      if (typeof frame.targetId === "string") this.withdraw(`ui:${frame.targetId}`);
      return;
    }
    const request: OmpUIRequest = {
      id,
      method,
      ...(typeof frame.title === "string" ? { title: frame.title } : {}),
      ...(Array.isArray(frame.options) ? { options: frame.options.filter((option): option is string => typeof option === "string") } : {}),
      ...(typeof frame.message === "string" ? { message: frame.message } : {}),
    };
    const run = this.run;
    const cancelled = (): void => this.write({ type: OMP_FRAME.uiResponse, id, cancelled: true });
    if (!run) {
      cancelled();
      return;
    }
    this.answer(run, `ui:${id}`, (signal) => run.handlers.onUiRequest(request, signal),
      (response) => this.write({ type: OMP_FRAME.uiResponse, id, ...response }), cancelled);
  }

  /**
   * Runs one callback of `run`. Its answer is written only while the agent
   * still waits for it: a withdrawn request, or one outliving its prompt, is
   * answered by nobody.
   */
  private answer<T>(run: PromptRun, key: string, work: (signal: AbortSignal) => Promise<T>, reply: (value: T) => void, refuse: (error: Error) => void): void {
    if (run.callbacks.has(key)) {
      throw new OmpProcessError("OMP RPC reused a request id");
    }
    const controller = new AbortController();
    run.callbacks.set(key, controller);
    const live = (): boolean => run.callbacks.get(key) === controller && !controller.signal.aborted;
    void work(controller.signal).then(
      (value) => { if (live()) reply(value); },
      (error: unknown) => { if (live()) refuse(error instanceof Error ? error : new Error(String(error))); },
    ).finally(() => {
      if (run.callbacks.get(key) === controller) run.callbacks.delete(key);
    });
  }

  private withdraw(key: string): void {
    const controller = this.run?.callbacks.get(key);
    if (controller) {
      this.run!.callbacks.delete(key);
      controller.abort();
    }
  }

  private writeToolResult(id: string, result: OmpToolResult): void {
    const { isError, content } = result;
    this.write({ type: OMP_FRAME.hostToolResult, id, result: { content }, ...(isError ? { isError: true } : {}) });
  }

  private fail(error: OmpProcessError): void {
    if (this.error) return;
    this.error = error;
    this.ready.resolve(error);
    for (const { answer } of this.pending.values()) answer.resolve(error);
    if (this.run) {
      for (const controller of this.run.callbacks.values()) controller.abort();
      this.run.outcome.resolve(error);
    }
    this.failure.resolve(error);
    if (!this.closing) void this.handle.stop();
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

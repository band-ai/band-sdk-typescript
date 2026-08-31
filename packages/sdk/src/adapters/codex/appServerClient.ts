import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { BandSdkError, RuntimeStateError, ValidationError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type {
  DynamicToolCallResponse,
  InitializeParams,
  RequestId,
} from "./appServerProtocol";

type JsonRpcPayload = Record<string, unknown>;

export interface CodexRpcRequestEvent {
  kind: "request";
  id: RequestId;
  method: string;
  params: unknown;
}

export interface CodexRpcNotificationEvent {
  kind: "notification";
  method: string;
  params: unknown;
}

export type CodexRpcEvent = CodexRpcRequestEvent | CodexRpcNotificationEvent;

export interface CodexClientLike {
  connect(): Promise<void>;
  initialize(params: InitializeParams): Promise<void>;
  request<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  respond(requestId: RequestId, result: Record<string, unknown> | DynamicToolCallResponse): Promise<void>;
  respondError(requestId: RequestId, code: number, message: string, data?: unknown): Promise<void>;
  recvEvent(timeoutMs?: number): Promise<CodexRpcEvent>;
  close(): Promise<void>;
}

interface PendingEventWaiter {
  resolve(event: CodexRpcEvent): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

/** Thrown when the Codex app-server answers a JSON-RPC request with an error object. */
export class CodexJsonRpcError extends BandSdkError {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(`Codex JSON-RPC error ${code}: ${message}`);
    this.name = "CodexJsonRpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * JSON-RPC client for a Codex app-server subprocess spoken to over stdio. Handles the
 * request/response correlation, notification fan-out, and process lifecycle that
 * {@link CodexAdapter} runs on.
 */
export class CodexAppServerStdioClient implements CodexClientLike {
  private readonly command: readonly string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly logger: Logger;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadLineInterface | null = null;
  private events: CodexRpcEvent[] = [];
  private waiters: PendingEventWaiter[] = [];
  private pending = new Map<RequestId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextRequestId = 0;
  private closed = false;

  public constructor(options?: {
    command?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    logger?: Logger;
  }) {
    this.command = options?.command ?? ["codex", "app-server", "--listen", "stdio://"];
    this.cwd = options?.cwd;
    if (options?.env) {
      const mergedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") {
          mergedEnv[key] = value;
        }
      }
      for (const [key, value] of Object.entries(options.env)) {
        mergedEnv[key] = value;
      }
      this.env = mergedEnv;
    } else {
      this.env = undefined;
    }
    this.logger = options?.logger ?? new NoopLogger();
  }

  public async connect(): Promise<void> {
    if (this.process) {
      return;
    }

    const [bin, ...args] = this.command;
    if (!bin) {
      throw new ValidationError("Codex app-server command is empty");
    }

    this.closed = false;
    this.process = spawn(bin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdoutLines = createInterface({
      input: this.process.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    this.stdoutLines.on("line", (line) => {
      void this.handleLine(line);
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString().trim();
      if (!text) {
        return;
      }
      this.logger.debug("codex_app_server.stderr", { text });
    });

    this.process.on("error", (error) => {
      this.failAll(`Codex app-server failed to start: ${error.message}`);
    });

    this.process.on("close", (code, signal) => {
      this.failAll(
        `Codex app-server closed${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
      );
    });
  }

  public async initialize(params: InitializeParams): Promise<void> {
    await this.request("initialize", toJsonRpcParams(params));
    await this.notify("initialized", {});
  }

  public async request<TResult>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    const id = ++this.nextRequestId;
    const response = await new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.sendJson({ id, method, params: params ?? {} }).catch((error) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new BandSdkError(String(error), error));
      });
    });
    return response;
  }

  public async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.sendJson({ method, params: params ?? {} });
  }

  public async respond(
    requestId: RequestId,
    result: Record<string, unknown> | DynamicToolCallResponse,
  ): Promise<void> {
    await this.sendJson({ id: requestId, result });
  }

  public async respondError(
    requestId: RequestId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    await this.sendJson({
      id: requestId,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  public async recvEvent(timeoutMs?: number): Promise<CodexRpcEvent> {
    if (this.events.length > 0) {
      return this.events.shift() as CodexRpcEvent;
    }

    return await new Promise<CodexRpcEvent>((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? null
        : setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new RuntimeStateError("Timed out waiting for Codex app-server event"));
        }, timeoutMs);

      const waiter: PendingEventWaiter = { resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    const proc = this.process;
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.failAll("Codex app-server closed by client.");

    if (!proc) {
      return;
    }

    proc.stdin.end();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
      }, 500);

      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async sendJson(payload: JsonRpcPayload): Promise<void> {
    const proc = this.process;
    if (!proc) {
      throw new RuntimeStateError("Codex app-server is not connected");
    }

    const line = `${JSON.stringify(payload)}\n`;
    await new Promise<void>((resolve, reject) => {
      proc.stdin.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this.logger.warn("codex_app_server.invalid_json", {
        line,
        error,
      });
      return;
    }

    const message = asObject(payload);
    if (!message) {
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    const id = parseRequestId(message.id);
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");

    if (method && id !== null) {
      this.pushEvent({
        kind: "request",
        id,
        method,
        params: message.params,
      });
      return;
    }

    if (method) {
      if (hasId) {
        this.logger.warn("codex_app_server.invalid_request_id", {
          method,
          id: message.id,
        });
        return;
      }
      this.pushEvent({
        kind: "notification",
        method,
        params: message.params,
      });
      return;
    }

    if (id === null) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    const errorRecord = asObject(message.error);
    if (errorRecord) {
      pending.reject(new CodexJsonRpcError(
        typeof errorRecord.code === "number" ? errorRecord.code : -32000,
        typeof errorRecord.message === "string" ? errorRecord.message : "Unknown JSON-RPC error",
        errorRecord.data,
      ));
      return;
    }

    pending.resolve(message.result);
  }

  private pushEvent(event: CodexRpcEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(event);
      return;
    }

    this.events.push(event);
  }

  private removeWaiter(target: PendingEventWaiter): void {
    const index = this.waiters.indexOf(target);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }

  private failAll(reason: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.process = null;

    const error = new RuntimeStateError(reason);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as PendingEventWaiter;
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(error);
    }

    this.events.push({
      kind: "notification",
      method: "transport/closed",
      params: {
        reason,
      },
    });
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseRequestId(value: unknown): RequestId | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function toJsonRpcParams(value: unknown): Record<string, unknown> {
  const record = asObject(value);
  if (!record) {
    throw new ValidationError("JSON-RPC params must be an object");
  }
  return record;
}

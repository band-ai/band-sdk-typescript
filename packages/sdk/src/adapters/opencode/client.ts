import { createServer } from "node:net";
import { BandSdkError, RuntimeStateError, UnsupportedFeatureError } from "../../core/errors";
import { NoopLogger, type Logger } from "../../core/logger";
import { asNonEmptyString, isRecord } from "../shared/coercion";

export interface OpencodeClientLike {
  createSession(input?: { title?: string }): Promise<Record<string, unknown>>;
  getSession(sessionId: string): Promise<Record<string, unknown>>;
  promptAsync(
    sessionId: string,
    input: {
      parts: Array<Record<string, unknown>>;
      system?: string;
      model?: Record<string, string>;
      agent?: string;
      variant?: string;
    },
  ): Promise<void>;
  replyPermission(
    sessionId: string,
    permissionId: string,
    input: { response: string },
  ): Promise<void>;
  replyQuestion(
    requestId: string,
    input: { answers: string[][] },
  ): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  registerMcpServer(input: { name: string; url: string }): Promise<Record<string, unknown>>;
  deregisterMcpServer(name: string): Promise<void>;
  iterEvents(): AsyncIterable<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface HttpOpencodeClientOptions {
  baseUrl: string;
  directory?: string;
  workspace?: string;
  timeoutMs?: number;
  /** Destination for best-effort cleanup diagnostics. Defaults to a no-op logger. */
  logger?: Logger;
}

interface ManagedOpencodeClientOptions {
  directory?: string;
  workspace?: string;
  startupTimeoutMs?: number;
  /** Destination for best-effort cleanup diagnostics. Defaults to a no-op logger. */
  logger?: Logger;
}

interface RequestResultLike<TData = unknown> {
  data?: TData;
  error?: unknown;
  request: Request;
  response: Response;
}

interface OpencodeEventStream {
  stream: AsyncIterable<unknown>;
}

interface OpencodeSdkClientLike {
  session: {
    create(parameters?: Record<string, unknown>): Promise<RequestResultLike>;
    get(parameters: Record<string, unknown>): Promise<RequestResultLike>;
    promptAsync(parameters: Record<string, unknown>): Promise<RequestResultLike>;
    abort(parameters: Record<string, unknown>): Promise<RequestResultLike>;
  };
  permission: {
    reply(parameters: Record<string, unknown>): Promise<RequestResultLike>;
  };
  question: {
    reply(parameters: Record<string, unknown>): Promise<RequestResultLike>;
    reject(parameters: Record<string, unknown>): Promise<RequestResultLike>;
  };
  mcp: {
    add(parameters: Record<string, unknown>): Promise<RequestResultLike>;
    disconnect(parameters: Record<string, unknown>): Promise<RequestResultLike>;
  };
  event: {
    subscribe(
      parameters?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<OpencodeEventStream>;
  };
}

interface OpencodeServerHandle {
  url: string;
  close(): void;
}

interface LoadedOpencodeSdk {
  createClient(config: Record<string, unknown>): OpencodeSdkClientLike;
  createServer(options: Record<string, unknown>): Promise<OpencodeServerHandle>;
}

interface ClientRuntime {
  baseUrl: string;
  client: OpencodeSdkClientLike;
  close(): void;
}

const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";
const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 5_000;

let cachedSdkPromise: Promise<LoadedOpencodeSdk> | null = null;

/** Thrown when the Opencode server answers with a non-2xx status; carries the status and body. */
export class HttpStatusError extends BandSdkError {
  public readonly status: number;
  public readonly body: unknown;

  public constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
  }
}

abstract class SdkOpencodeClientBase implements OpencodeClientLike {
  private readonly runtimePromise: Promise<ClientRuntime>;
  private readonly eventsAbortController = new AbortController();
  private closed = false;

  protected readonly directory?: string;
  protected readonly workspace?: string;
  protected readonly logger: Logger;

  protected constructor(options: { directory?: string; workspace?: string; logger?: Logger }) {
    this.directory = asNonEmptyString(options.directory) ?? undefined;
    this.workspace = asNonEmptyString(options.workspace) ?? undefined;
    this.logger = options.logger ?? new NoopLogger();
    this.runtimePromise = this.createRuntime();
  }

  /**
   * Runs a best-effort cleanup step. Failures are reported and swallowed: these run on
   * teardown paths where a throw would mask the caller's real work.
   */
  protected async bestEffort(operation: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.debug(`Opencode ${operation} failed (best-effort)`, { error });
    }
  }

  public async createSession(input?: { title?: string }): Promise<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    const result = await runtime.client.session.create({
      ...this.scope(),
      ...(input?.title ? { title: input.title } : {}),
    });
    return expectRecord(result);
  }

  public async getSession(sessionId: string): Promise<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    const result = await runtime.client.session.get({
      ...this.scope(),
      sessionID: sessionId,
    });
    return expectRecord(result);
  }

  public async promptAsync(
    sessionId: string,
    input: {
      parts: Array<Record<string, unknown>>;
      system?: string;
      model?: Record<string, string>;
      agent?: string;
      variant?: string;
    },
  ): Promise<void> {
    const runtime = await this.getRuntime();
    await expectVoid(runtime.client.session.promptAsync({
      ...this.scope(),
      sessionID: sessionId,
      parts: input.parts as unknown[],
      ...(input.system ? { system: input.system } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    }));
  }

  public async replyPermission(
    _sessionId: string,
    permissionId: string,
    input: { response: string },
  ): Promise<void> {
    const runtime = await this.getRuntime();
    await expectVoid(runtime.client.permission.reply({
      ...this.scope(),
      requestID: permissionId,
      reply: input.response,
    }));
  }

  public async replyQuestion(
    requestId: string,
    input: { answers: string[][] },
  ): Promise<void> {
    const runtime = await this.getRuntime();
    await expectVoid(runtime.client.question.reply({
      ...this.scope(),
      requestID: requestId,
      answers: input.answers,
    }));
  }

  public async rejectQuestion(requestId: string): Promise<void> {
    const runtime = await this.getRuntime();
    await expectVoid(runtime.client.question.reject({
      ...this.scope(),
      requestID: requestId,
    }));
  }

  public async abortSession(sessionId: string): Promise<void> {
    const runtime = await this.getRuntime();
    await expectVoid(runtime.client.session.abort({
      ...this.scope(),
      sessionID: sessionId,
    }));
  }

  public async registerMcpServer(input: { name: string; url: string }): Promise<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    await this.bestEffort("registerMcpServer:deleteExisting", () => this.deleteMcpServer(input.name));
    const result = await runtime.client.mcp.add({
      ...this.scope(),
      name: input.name,
      config: { type: "remote", url: input.url },
    });
    return expectRecord(result);
  }

  public async deregisterMcpServer(name: string): Promise<void> {
    const runtime = await this.getRuntime();
    await this.bestEffort("deregisterMcpServer:disconnect", () => expectVoid(runtime.client.mcp.disconnect({
      ...this.scope(),
      name,
    })));
    await this.bestEffort("deregisterMcpServer:delete", () => this.deleteMcpServer(name));
  }

  public async *iterEvents(): AsyncIterable<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    const events = await runtime.client.event.subscribe(
      this.scope(),
      { signal: this.eventsAbortController.signal },
    );

    for await (const event of events.stream) {
      if (isRecord(event)) {
        yield event;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.eventsAbortController.abort();

    const runtime = await this.runtimePromise.catch((error: unknown) => {
      this.logger.debug("Opencode runtime never became available; nothing to close", { error });
      return null;
    });
    runtime?.close();
  }

  protected abstract createRuntime(): Promise<ClientRuntime>;

  protected async loadSdk(): Promise<LoadedOpencodeSdk> {
    if (!cachedSdkPromise) {
      cachedSdkPromise = Promise.all([
        import("@opencode-ai/sdk/v2/client"),
        import("@opencode-ai/sdk/server"),
      ]).then(([clientModule, serverModule]) => {
        const createClient = clientModule.createOpencodeClient;
        const createServer = serverModule.createOpencodeServer;

        if (typeof createClient !== "function" || typeof createServer !== "function") {
          throw new UnsupportedFeatureError("Installed `@opencode-ai/sdk` package is missing required exports.");
        }

        return {
          createClient: createClient as (config: Record<string, unknown>) => OpencodeSdkClientLike,
          createServer: createServer as (options: Record<string, unknown>) => Promise<OpencodeServerHandle>,
        };
      }).catch((error: unknown) => {
        cachedSdkPromise = null;
        throw new UnsupportedFeatureError(
          "OpenCode support requires the optional peer dependency `@opencode-ai/sdk`.",
          error,
        );
      });
    }

    return cachedSdkPromise;
  }

  protected createSdkClient(
    sdk: LoadedOpencodeSdk,
    baseUrl: string,
  ): OpencodeSdkClientLike {
    return sdk.createClient({
      baseUrl,
      responseStyle: "fields",
      throwOnError: false,
    });
  }

  private async getRuntime(): Promise<ClientRuntime> {
    if (this.closed) {
      throw new RuntimeStateError("OpenCode client is closed.");
    }

    return this.runtimePromise;
  }

  private scope(): Record<string, string> {
    return {
      ...(this.directory ? { directory: this.directory } : {}),
      ...(this.workspace ? { workspace: this.workspace } : {}),
    };
  }

  private async deleteMcpServer(name: string): Promise<void> {
    const runtime = await this.getRuntime();
    const url = new URL(`/mcp/${encodeURIComponent(name)}`, runtime.baseUrl);
    if (this.directory) {
      url.searchParams.set("directory", this.directory);
    }
    if (this.workspace) {
      url.searchParams.set("workspace", this.workspace);
    }

    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new HttpStatusError(response.status, await readResponseBody(response));
    }
  }
}

/** Opencode client that talks to an Opencode server the host already runs, at a given base URL. */
export class HttpOpencodeClient extends SdkOpencodeClientBase {
  private readonly baseUrl: string;

  public constructor(options: HttpOpencodeClientOptions) {
    super(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  protected override async createRuntime(): Promise<ClientRuntime> {
    const sdk = await this.loadSdk();
    return {
      baseUrl: this.baseUrl,
      client: this.createSdkClient(sdk, this.baseUrl),
      close: () => undefined,
    };
  }
}

/** Opencode client that starts and owns its own local Opencode server on a free port. */
export class ManagedOpencodeClient extends SdkOpencodeClientBase {
  private readonly startupTimeoutMs: number;

  public constructor(options: ManagedOpencodeClientOptions = {}) {
    super(options);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SERVER_STARTUP_TIMEOUT_MS;
  }

  protected override async createRuntime(): Promise<ClientRuntime> {
    const sdk = await this.loadSdk();
    const port = await findAvailablePort();
    const server = await sdk.createServer({
      hostname: DEFAULT_SERVER_HOSTNAME,
      port,
      timeout: this.startupTimeoutMs,
    });

    return {
      baseUrl: server.url,
      client: this.createSdkClient(sdk, server.url),
      close: () => {
        server.close();
      },
    };
  }
}

function getResultBody(result: RequestResultLike): unknown {
  return result.error ?? result.data ?? null;
}

function expectRecord(result: RequestResultLike): Record<string, unknown> {
  if (!result.response.ok) {
    throw new HttpStatusError(result.response.status, getResultBody(result));
  }

  return isRecord(result.data) ? result.data : {};
}

async function expectVoid(resultPromise: Promise<RequestResultLike>): Promise<void> {
  const result = await resultPromise;
  if (!result.response.ok) {
    throw new HttpStatusError(result.response.status, getResultBody(result));
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();

    server.on("error", reject);
    server.listen(0, DEFAULT_SERVER_HOSTNAME, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new RuntimeStateError("Failed to determine an available OpenCode port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  return await response.text();
}

/**
 * An OpenCode server on a local port, speaking the HTTP routes and SSE event
 * stream `@opencode-ai/sdk` uses, so the adapter's real `HttpOpencodeClient`
 * does every request and parses every event as it would against `opencode
 * serve`. Each prompt runs the next scripted agent turn.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createDeferred, type Deferred } from "../../../src/core/deferred";
import { CallHolds, TrafficLog, type HeldCall } from "../../testUtils";

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
}

type Event = { type: string; properties: Record<string, unknown> };

/** A route's canned failure: the status, and the body sent with it. */
interface Failure {
  status: number;
  body: string | Record<string, unknown>;
}

/** What a scripted agent turn can do while OpenCode works on a prompt. */
export class OpencodeTurn {
  private parts = 0;

  public constructor(
    private readonly server: FakeOpencodeServer,
    public readonly sessionId: string,
    public readonly prompt: Record<string, unknown>,
  ) {}

  /** Streams `text` as one assistant message: the text part first, then each delta. */
  public reply(text: string, ...deltas: string[]): string {
    const messageId = `msg_${this.server.nextId()}`;
    const partId = `prt_${++this.parts}`;
    this.emit("message.updated", { info: { id: messageId, role: "assistant", sessionID: this.sessionId } });
    this.emit("message.part.updated", { part: { id: partId, messageID: messageId, sessionID: this.sessionId, type: "text", text } });
    for (const delta of deltas) {
      this.emit("message.part.delta", { sessionID: this.sessionId, messageID: messageId, partID: partId, field: "text", delta });
    }
    return messageId;
  }

  public emit(type: string, properties: Record<string, unknown>): void {
    this.server.broadcast({ type, properties });
  }

  /** Raises a permission ask and resolves with the reply OpenCode receives for it. */
  public askPermission(properties: Record<string, unknown> = {}): { id: string; reply: Promise<Record<string, unknown>> } {
    const id = typeof properties.id === "string" ? properties.id : `per_${this.server.nextId()}`;
    const reply = this.server.awaitRequest("POST", `/permission/${id}/reply`);
    this.emit("permission.asked", { sessionID: this.sessionId, permission: "bash", patterns: ["npm test"], ...properties, id });
    return { id, reply: reply.then((request) => request.body) };
  }

  /** Raises a question and resolves with the answers, or "rejected". */
  public askQuestion(questions: Array<Record<string, unknown>>, id = `que_${this.server.nextId()}`): { id: string; reply: Promise<string[][] | "rejected"> } {
    const reply = Promise.race([
      this.server.awaitRequest("POST", `/question/${id}/reply`).then((request) => request.body.answers as string[][]),
      this.server.awaitRequest("POST", `/question/${id}/reject`).then(() => "rejected" as const),
    ]);
    this.emit("question.asked", { sessionID: this.sessionId, questions, id });
    return { id, reply };
  }

  /** Calls one of the MCP tools the adapter registered, as OpenCode's model would. */
  public async callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
    const result = await (await this.server.mcpClient()).callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    return { isError: result.isError === true ? true : undefined, text: content.map((part) => part.text ?? "").join("") };
  }

  public idle(): void {
    this.emit("session.idle", { sessionID: this.sessionId });
  }

  public error(error: unknown): void {
    this.emit("session.error", { sessionID: this.sessionId, error });
  }
}

type Script = (turn: OpencodeTurn) => Promise<void> | void;

export class FakeOpencodeServer implements AsyncDisposable {
  public readonly requests: Request[] = [];
  private readonly traffic = new TrafficLog();
  private readonly scripts: Script[] = [];
  private readonly sessions = new Set<string>();
  private readonly streams = new Set<ServerResponse>();
  private readonly waiters: Array<{ method: string; path: string; request: Deferred<Request> }> = [];
  private readonly failures = new Map<string, Failure[]>();
  private readonly holds = new CallHolds<[route: string]>();
  private ids = 0;
  private port = 0;
  private mcp: Promise<Client> | null = null;

  private readonly http: Server = createServer((req, res) => void this.handle(req, res));

  public static async start(): Promise<FakeOpencodeServer> {
    const server = new FakeOpencodeServer();
    await new Promise<void>((resolve) => server.http.listen(0, "127.0.0.1", resolve));
    server.port = (server.http.address() as AddressInfo).port;
    return server;
  }

  /** Kept past disposal, so a client can be pointed at a server that is gone. */
  public get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public nextId(): string {
    return String(++this.ids).padStart(4, "0");
  }

  /** Queues the script the next `prompt_async` runs. */
  public onPrompt(script: Script): void {
    this.scripts.push(script);
  }

  /** Makes the next request to `route` (e.g. "POST /session/:id/abort") fail with `failure`. */
  public failNext(route: string, failure: Failure): void {
    this.failures.set(route, [...(this.failures.get(route) ?? []), failure]);
  }

  /** Keeps the next request to `route` unanswered until released. */
  public hold(route: string): HeldCall<[route: string]> {
    return this.holds.hold((candidate) => candidate === route);
  }

  /** Ends every open event stream, as a restarting server would. */
  public dropEventStreams(): void {
    this.streams.forEach((stream) => stream.destroy());
    this.streams.clear();
  }

  /** Forgets every session, as a server that lost its state would. */
  public forgetSessions(): void {
    this.sessions.clear();
  }

  public broadcast(event: Event): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    this.streams.forEach((stream) => stream.write(frame));
  }

  public requestsTo(method: string, pattern: RegExp): Request[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  public until(predicate: () => boolean): Promise<void> {
    return this.traffic.until(predicate);
  }

  public awaitRequest(method: string, path: string): Promise<Request> {
    const request = createDeferred<Request>();
    this.waiters.push({ method, path, request });
    return request.promise;
  }

  /** An MCP client for the tools server the adapter registered, with the headers it registered. */
  public mcpClient(): Promise<Client> {
    this.mcp ??= (async () => {
      const [registration] = this.requestsTo("POST", /^\/mcp$/).slice(-1);
      const config = registration!.body.config as { url: string; headers?: Record<string, string> };
      const client = new Client({ name: "fake-opencode", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      return client;
    })();
    return this.mcp;
  }

  public get eventStreamCount(): number {
    return this.requestsTo("GET", /^\/event$/).length;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await (await this.mcp?.catch(() => null))?.close();
    this.dropEventStreams();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const request: Request = { method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body: await readJson(req), headers: req.headers };
    this.requests.push(request);
    this.traffic.record();
    const route = `${request.method} ${request.path.replace(/\/(ses|per|que)_[^/]+/, "/$1_:id")}`;
    this.settleWaiters(request);

    await this.holds.pass(route);
    const failure = this.failures.get(route)?.shift();
    if (failure) {
      return send(res, failure.status, failure.body);
    }
    if (request.method === "GET" && request.path === "/event") {
      return this.openEventStream(res);
    }
    return this.route(request, res);
  }

  private route(request: Request, res: ServerResponse): void {
    const { method, path, body } = request;
    const session = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (method === "POST" && path === "/session") {
      const id = `ses_${this.nextId()}`;
      this.sessions.add(id);
      return send(res, 200, { id, title: body.title });
    }
    if (session && !this.sessions.has(session[1]!)) {
      return send(res, 404, { name: "NotFoundError", data: { message: `Session not found: ${session[1]}` } });
    }
    if (session && method === "GET" && !session[2]) {
      return send(res, 200, { id: session[1] });
    }
    if (session && method === "POST" && session[2] === "/prompt_async") {
      send(res, 204);
      const script = this.scripts.shift();
      if (script) {
        void Promise.resolve(script(new OpencodeTurn(this, session[1]!, body)));
      }
      return;
    }
    // Permission and question replies, aborts and MCP registration all simply succeed.
    return send(res, 200, true);
  }

  private openEventStream(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    this.streams.add(res);
    res.on("close", () => this.streams.delete(res));
  }

  private settleWaiters(request: Request): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.method === request.method && waiter.path === request.path) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.request.resolve(request);
      }
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = typeof body === "string";
  res.writeHead(status, { "content-type": text ? "text/plain" : "application/json" });
  res.end(text ? body : JSON.stringify(body));
}

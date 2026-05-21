import type { AdapterToolsProtocol } from "../contracts/protocols";
import type {
  BuildRegistrationsOptions,
  McpToolRegistration,
} from "./registrations";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
} from "./registrations";
import { buildZodShape } from "./zod";

export interface BandMcpServerOptions {
  /** Single tools instance (no room scoping) or a resolver function for room-scoped tools. */
  tools: AdapterToolsProtocol | ((roomId: string) => AdapterToolsProtocol | undefined);
  /** Server name advertised to MCP clients. */
  name?: string;
  /** Port to listen on. Defaults to auto-selecting from 50000-60000. */
  port?: number;
  /** Enable memory tools. */
  enableMemoryTools?: boolean;
  /** Enable contact tools. */
  enableContactTools?: boolean;
  /** Additional MCP tool registrations to expose alongside the built-in tools. */
  additionalTools?: McpToolRegistration[];
}

const PORT_RANGE_START = 50000;
const PORT_RANGE_END = 60000;
const MCP_SERVER_VERSION = "1.0.0";
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

interface SessionRecord {
  mcpServer: InstanceType<typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>;
  transport: import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Standalone MCP server that exposes Band agent tools over Streamable HTTP.
 *
 * Uses `@modelcontextprotocol/server` (optional peer dependency) and `express`.
 * Install with: `npm install @modelcontextprotocol/server express`
 */
export class BandMcpServer {
  private readonly options: BandMcpServerOptions;
  private readonly registrations: McpToolRegistration[];
  private httpServer: import("node:http").Server | null = null;
  private actualPort: number | null = null;
  private readonly sessions = new Map<string, SessionRecord>();
  private sessionSweepTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(options: BandMcpServerOptions) {
    this.options = options;

    const regOptions: BuildRegistrationsOptions = {
      enableMemoryTools: options.enableMemoryTools,
      enableContactTools: options.enableContactTools,
      additionalTools: options.additionalTools,
    };

    if (typeof options.tools === "function") {
      this.registrations = buildRoomScopedRegistrations(options.tools, regOptions);
    } else {
      this.registrations = buildSingleContextRegistrations(options.tools, regOptions);
    }
  }

  /** Port the server is listening on. Null if not started. */
  public get port(): number | null {
    return this.actualPort;
  }

  /** MCP endpoint URL. Null if not started. */
  public get url(): string | null {
    if (this.actualPort === null) {
      return null;
    }
    return `http://127.0.0.1:${this.actualPort}/mcp`;
  }

  /** Tool names registered on this server. */
  public get toolNames(): string[] {
    return this.registrations.map((r) => r.name);
  }

  public async start(): Promise<void> {
    // Lazy imports — these are optional peer dependencies.
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { isInitializeRequest } = await import("@modelcontextprotocol/sdk/types.js");
    const expressModule = await import("express");
    const express = expressModule.default ?? expressModule;
    const http = await import("node:http");
    const { randomUUID } = await import("node:crypto");
    const { z } = await import("zod");

    const serverName = this.options.name ?? "thenvoi";

    const app = express();
    app.use(express.json());

    app.get("/healthz", (_req, res) => {
      res.json({ status: "ok" });
    });

    const handleMcpRequest = async (
      req: import("express").Request,
      res: import("express").Response,
    ): Promise<void> => {
      try {
        const sessionId = getSessionIdHeader(req.headers["mcp-session-id"]);
        let session = sessionId ? this.sessions.get(sessionId) : undefined;

        if (!session) {
          if (req.method !== "POST" || sessionId || !isInitializeRequest(req.body)) {
            sendMcpError(res, sessionId ? 404 : 400, sessionId ? "Session not found" : "Bad Request: No valid session ID provided");
            return;
          }

          session = await this.createSession({
            McpServer,
            StreamableHTTPServerTransport,
            serverName,
            sessionIdGenerator: randomUUID,
            z,
          });
        }

        session.lastSeenAt = Date.now();
        await session.transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent) {
          sendMcpError(res, 500, "Internal server error");
        }
      }
    };

    app.post("/mcp", async (req, res) => {
      await handleMcpRequest(req, res);
    });

    app.get("/mcp", async (req, res) => {
      await handleMcpRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      await handleMcpRequest(req, res);
    });

    const port = this.options.port ?? await findAvailablePort(http);

    return new Promise<void>((resolve, reject) => {
      const server = http.createServer(app);
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.httpServer = server;
        this.actualPort = port;
        this.startSessionSweep();
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    this.stopSessionSweep();
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(activeSessions.map(async (session) => {
      await session.transport.close();
    }));

    if (!this.httpServer) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.close((error) => {
        this.httpServer = null;
        this.actualPort = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async createSession(input: {
    McpServer: typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
    StreamableHTTPServerTransport: typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
    serverName: string;
    sessionIdGenerator: () => string;
    z: typeof import("zod").z;
  }): Promise<SessionRecord> {
    const createdAt = Date.now();
    const mcpServer = new input.McpServer({ name: input.serverName, version: MCP_SERVER_VERSION });
    registerTools(mcpServer, input.z, this.registrations);

    let record: SessionRecord | null = null;
    const transport = new input.StreamableHTTPServerTransport({
      sessionIdGenerator: input.sessionIdGenerator,
      onsessioninitialized: (sessionId) => {
        if (!record) {
          return;
        }
        this.sessions.set(sessionId, record);
      },
      onsessionclosed: (sessionId) => {
        this.sessions.delete(sessionId);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.sessions.delete(sessionId);
      }
    };

    await mcpServer.connect(transport);
    record = {
      mcpServer,
      transport,
      createdAt,
      lastSeenAt: createdAt,
    };
    return record;
  }

  private startSessionSweep(): void {
    if (this.sessionSweepTimer) {
      return;
    }

    this.sessionSweepTimer = setInterval(() => {
      void this.closeIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.sessionSweepTimer.unref?.();
  }

  private stopSessionSweep(): void {
    if (!this.sessionSweepTimer) {
      return;
    }

    clearInterval(this.sessionSweepTimer);
    this.sessionSweepTimer = null;
  }

  private async closeIdleSessions(): Promise<void> {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    const idleSessions = [...this.sessions.values()].filter((session) => session.lastSeenAt < cutoff);

    await Promise.all(idleSessions.map(async (session) => {
      await session.transport.close();
    }));
  }
}

export { BandMcpServer as ThenvoiMcpServer };
export type { BandMcpServerOptions as ThenvoiMcpServerOptions };

function getSessionIdHeader(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }

  return null;
}

function sendMcpError(
  res: import("express").Response,
  status: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function registerTools(
  mcpServer: InstanceType<typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>,
  z: typeof import("zod").z,
  registrations: McpToolRegistration[],
): void {
  for (const reg of registrations) {
    const zodShape = buildZodShape(z, reg.inputSchema.properties, new Set(reg.inputSchema.required));

    mcpServer.registerTool(
      reg.name,
      {
        description: reg.description,
        inputSchema: z.object(zodShape),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK handler signature is complex; our McpToolResult is compatible
      async (args: Record<string, unknown>): Promise<any> => reg.execute(args),
    );
  }
}

async function findAvailablePort(http: typeof import("node:http")): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
    const available = await checkPort(http, port);
    if (available) {
      return port;
    }
  }

  // Fallback: let the OS assign a port
  return 0;
}

function checkPort(http: typeof import("node:http"), port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

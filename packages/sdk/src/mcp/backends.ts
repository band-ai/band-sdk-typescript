import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { Logger } from "../core/logger";
import { mcpToolNames } from "../contracts/toolSchemas";
import { buildBridgeRegistrations, type BuildRegistrationsOptions, type McpToolRegistration } from "./registrations";
import { generateAuthToken } from "./auth";
import { BandMcpStdioServer } from "./stdio";
import { BandMcpServer } from "./server";
import { BandMcpSseServer } from "./sse";
import type { BandSdkMcpServer } from "./sdk";

export type BandMcpBackendKind = "sdk" | "http" | "sse" | "stdio";

export interface BandMcpBackend {
  kind: BandMcpBackendKind;
  server: unknown;
  allowedTools: string[];
  /** Bearer token callers must present to reach `server`. Set for "http"/"sse", which listen on a loopback network port. */
  authToken?: string;
  stop(): Promise<void>;
}

export interface CreateBandMcpBackendOptions {
  /** @internal HTTP registration execution boundary. */
  execute?: BuildRegistrationsOptions["execute"];
  kind: BandMcpBackendKind;
  enableMemoryTools: boolean;
  enableTaskTools?: boolean;
  /** Advertise `operation_id` on keyed-operation tools; see `BuildRegistrationsOptions.enableOperationIds`. */
  enableOperationIds?: boolean;
  /**
   * Returns the tools for a given room. In single-room mode (`multiRoom: false`),
   * called once during init with `""` — must return the tools instance regardless of the argument.
   * Otherwise see `McpToolRegistration.execute` for what host tools need from it.
   */
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
  multiRoom?: boolean;
  /** See `BandMcpServerOptions.admissionGuard`. */
  admissionGuard?: () => boolean;
  /** See `BandMcpServerOptions.logger`. */
  logger?: Logger;
}

export async function createBandMcpBackend(
  options: CreateBandMcpBackendOptions,
): Promise<BandMcpBackend> {
  const registrationOptions = {
    enableMemoryTools: options.enableMemoryTools,
    enableTaskTools: options.enableTaskTools,
    enableOperationIds: options.enableOperationIds,
    enableContactTools: true,
    additionalTools: options.additionalTools,
  };

  // SDK builds its own registrations and allowedTools internally — delegate entirely.
  if (options.kind === "sdk") {
    const { createBandSdkMcpServer } = await import("./sdk");
    const server = createBandSdkMcpServer({
      getToolsForRoom: options.getToolsForRoom,
      multiRoom: options.multiRoom,
      enableMemoryTools: options.enableMemoryTools,
      enableTaskTools: options.enableTaskTools,
      enableOperationIds: options.enableOperationIds,
      additionalTools: options.additionalTools,
      admissionGuard: options.admissionGuard,
      logger: options.logger,
    });

    return {
      kind: "sdk",
      server,
      allowedTools: server.allowedTools,
      stop: async () => undefined,
    };
  }

  // The bridges stand the raw room resolver, not a pre-resolved proxy: a keyed
  // call's origin resolves at the raw call, pinning the tools of the turn the
  // call stood on.
  const multiRoom = options.multiRoom !== false;

  const { registrations } = buildBridgeRegistrations(options.getToolsForRoom, multiRoom, registrationOptions);

  const allowedTools = mcpToolNames(new Set(registrations.map((registration) => registration.name)));

  if (options.kind === "stdio") {
    const server = new BandMcpStdioServer({
      tools: options.getToolsForRoom,
      multiRoom,
      enableMemoryTools: options.enableMemoryTools,
      enableTaskTools: options.enableTaskTools,
      enableOperationIds: options.enableOperationIds,
      enableContactTools: true,
      additionalTools: options.additionalTools,
      admissionGuard: options.admissionGuard,
      logger: options.logger,
    });
    await server.start();

    return {
      kind: "stdio",
      server,
      allowedTools,
      stop: async () => {
        await server.stop();
      },
    };
  }

  // "http" and "sse" are the only kinds that listen on a loopback network port,
  // so both need a bearer token to authenticate requests to it.
  const authToken = generateAuthToken();

  if (options.kind === "sse") {
    const server = new BandMcpSseServer({
      tools: options.getToolsForRoom,
      multiRoom,
      enableMemoryTools: options.enableMemoryTools,
      enableTaskTools: options.enableTaskTools,
      enableOperationIds: options.enableOperationIds,
      enableContactTools: true,
      additionalTools: options.additionalTools,
      authToken,
      admissionGuard: options.admissionGuard,
      logger: options.logger,
    });
    await server.start();

    return {
      kind: "sse",
      server,
      allowedTools,
      authToken,
      stop: async () => {
        await server.stop();
      },
    };
  }

  const server = new BandMcpServer({
    execute: options.execute,
    tools: options.getToolsForRoom,
    multiRoom,
    enableMemoryTools: options.enableMemoryTools,
    enableTaskTools: options.enableTaskTools,
    enableOperationIds: options.enableOperationIds,
    enableContactTools: true,
    additionalTools: options.additionalTools,
    authToken,
    admissionGuard: options.admissionGuard,
    logger: options.logger,
  });
  await server.start();

  return {
    kind: "http",
    server,
    allowedTools,
    authToken,
    stop: async () => {
      await server.stop();
    },
  };
}

export function getBandSdkMcpServerConfig(
  backend: BandMcpBackend,
): BandSdkMcpServer["serverConfig"] {
  if (backend.kind !== "sdk") {
    throw new Error(`Expected sdk MCP backend, received ${backend.kind}`);
  }

  return (backend.server as BandSdkMcpServer).serverConfig;
}

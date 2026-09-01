import type { AdapterToolsProtocol } from "../contracts/protocols";
import { mcpToolNames } from "../runtime/tools/schemas";
import type { McpToolRegistration } from "./registrations";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  resolveSingleRoomTools,
} from "./registrations";
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
  kind: BandMcpBackendKind;
  enableMemoryTools: boolean;
  /**
   * Returns the tools for a given room. In single-room mode (`multiRoom: false`),
   * called once during init with `""` — must return the tools instance regardless of the argument.
   */
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
  multiRoom?: boolean;
}

export async function createBandMcpBackend(
  options: CreateBandMcpBackendOptions,
): Promise<BandMcpBackend> {
  const registrationOptions = {
    enableMemoryTools: options.enableMemoryTools,
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
      additionalTools: options.additionalTools,
    });

    return {
      kind: "sdk",
      server,
      allowedTools: server.allowedTools,
      stop: async () => undefined,
    };
  }

  // Resolve tools once so non-SDK servers and registration building share the same instance.
  const resolvedTools = options.multiRoom === false
    ? resolveSingleRoomTools(options.getToolsForRoom)
    : options.getToolsForRoom;

  const registrations = options.multiRoom === false
    ? buildSingleContextRegistrations(resolvedTools as AdapterToolsProtocol, registrationOptions)
    : buildRoomScopedRegistrations(resolvedTools as (roomId: string) => AdapterToolsProtocol | undefined, registrationOptions);

  const allowedTools = mcpToolNames(new Set(registrations.map((registration) => registration.name)));

  if (options.kind === "stdio") {
    const server = new BandMcpStdioServer({
      tools: resolvedTools,
      enableMemoryTools: options.enableMemoryTools,
      enableContactTools: true,
      additionalTools: options.additionalTools,
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
      tools: resolvedTools,
      enableMemoryTools: options.enableMemoryTools,
      enableContactTools: true,
      additionalTools: options.additionalTools,
      authToken,
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
    tools: resolvedTools,
    enableMemoryTools: options.enableMemoryTools,
    enableContactTools: true,
    additionalTools: options.additionalTools,
    authToken,
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

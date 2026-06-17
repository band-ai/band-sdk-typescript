import type { AdapterToolsProtocol } from "../contracts/protocols";
import { mcpToolNames } from "../runtime/tools/schemas";
import type { McpToolRegistration } from "./registrations";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  resolveSingleRoomTools,
} from "./registrations";
import { ThenvoiMcpStdioServer } from "./stdio";
import { ThenvoiMcpServer } from "./server";
import { ThenvoiMcpSseServer } from "./sse";
import type { ThenvoiSdkMcpServer } from "./sdk";

export type ThenvoiMcpBackendKind = "sdk" | "http" | "sse" | "stdio";

export interface ThenvoiMcpBackend {
  kind: ThenvoiMcpBackendKind;
  server: unknown;
  allowedTools: string[];
  stop(): Promise<void>;
}

export interface CreateThenvoiMcpBackendOptions {
  kind: ThenvoiMcpBackendKind;
  enableMemoryTools: boolean;
  /**
   * Returns the tools for a given room. In single-room mode (`multiRoom: false`),
   * called once during init with `""` — must return the tools instance regardless of the argument.
   */
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
  multiRoom?: boolean;
}

export async function createThenvoiMcpBackend(
  options: CreateThenvoiMcpBackendOptions,
): Promise<ThenvoiMcpBackend> {
  const registrationOptions = {
    enableMemoryTools: options.enableMemoryTools,
    enableContactTools: true,
    additionalTools: options.additionalTools,
  };

  // SDK builds its own registrations and allowedTools internally — delegate entirely.
  if (options.kind === "sdk") {
    const { createThenvoiSdkMcpServer } = await import("./sdk");
    const server = createThenvoiSdkMcpServer({
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
    const server = new ThenvoiMcpStdioServer({
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

  if (options.kind === "sse") {
    const server = new ThenvoiMcpSseServer({
      tools: resolvedTools,
      enableMemoryTools: options.enableMemoryTools,
      enableContactTools: true,
      additionalTools: options.additionalTools,
    });
    await server.start();

    return {
      kind: "sse",
      server,
      allowedTools,
      stop: async () => {
        await server.stop();
      },
    };
  }

  const server = new ThenvoiMcpServer({
    tools: resolvedTools,
    enableMemoryTools: options.enableMemoryTools,
    enableContactTools: true,
    additionalTools: options.additionalTools,
  });
  await server.start();

  return {
    kind: "http",
    server,
    allowedTools,
    stop: async () => {
      await server.stop();
    },
  };
}

export function getThenvoiSdkMcpServerConfig(
  backend: ThenvoiMcpBackend,
): ThenvoiSdkMcpServer["serverConfig"] {
  if (backend.kind !== "sdk") {
    throw new Error(`Expected sdk MCP backend, received ${backend.kind}`);
  }

  return (backend.server as ThenvoiSdkMcpServer).serverConfig;
}

import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { onTestFinished } from "vitest";

import type { AdapterToolsProtocol } from "../../src/contracts/protocols";
import type { BandMcpBackend } from "../../src/mcp/backends";
import { createBandMcpBackend } from "../../src/mcp/backends";
import type { McpToolRegistration } from "../../src/mcp/registrations";
import { createBandSdkMcpServer } from "../../src/mcp/sdk";
import { BandMcpStdioServer } from "../../src/mcp/stdio";

/** A connected client of a network backend, authorized with its token. */
export async function connectClient(backend: BandMcpBackend, name: string): Promise<Client> {
  const server = backend.server as { url?: string; sseUrl?: string };
  let transport: Transport;
  if (backend.kind === "http") {
    transport = new StreamableHTTPClientTransport(new URL(server.url!), {
      requestInit: { headers: { authorization: `Bearer ${backend.authToken}` } },
    });
  } else {
    transport = new SSEClientTransport(new URL(server.sseUrl!), {
      requestInit: { headers: { authorization: `Bearer ${backend.authToken}` } },
    });
  }
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export type BridgeKind = "http" | "sse" | "stdio" | "sdk";

export const BRIDGE_KINDS: readonly BridgeKind[] = ["http", "sse", "stdio", "sdk"];

export interface BridgeOptions {
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  multiRoom?: boolean;
  enableOperationIds?: boolean;
  admissionGuard?: () => boolean;
  additionalTools?: McpToolRegistration[];
}

/** A connected client of a real bridge of `kind`, each over its own transport; stopped when the test ends. */
export async function openBridge(kind: BridgeKind, options: BridgeOptions): Promise<Client> {
  const client = new Client({ name: `bridge-${kind}`, version: "1.0.0" });
  if (kind === "stdio") {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new BandMcpStdioServer({ ...options, tools: options.getToolsForRoom, multiRoom: options.multiRoom ?? true, stdin, stdout });
    await server.start();
    onTestFinished(() => server.stop());
    await client.connect(new StdioServerTransport(stdout, stdin));
    return client;
  }
  if (kind === "sdk") {
    const server = createBandSdkMcpServer({ ...options, enableMemoryTools: false });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.serverConfig.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  const backend = await createBandMcpBackend({ ...options, kind, enableMemoryTools: false });
  onTestFinished(() => backend.stop());
  return connectClient(backend, `bridge-${kind}`);
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** An MCP client connected to an in-process server, so calls go through its listing and validation. */
export async function connectMcpClient(server: { connect(transport: Transport): Promise<void> }): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "band-tools-probe", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

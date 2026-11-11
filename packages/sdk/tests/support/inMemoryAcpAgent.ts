import { AgentSideConnection, ClientSideConnection, ndJsonStream, type Agent, type Client } from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * A connection factory serving `served` over in-memory pipes, to the adapter's own client.
 * `exit` closes the pipes from the agent's side, as its process exiting on its own would.
 */
export function inMemoryAgent(served: (peer: AgentSideConnection, exit: () => void) => Agent, onStop: () => void = () => {}) {
  return async (client: Client) => {
    let closeOutgoing!: () => void;
    let closeIncoming!: () => void;
    const outgoing = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeOutgoing = () => controller.terminate(); } });
    const incoming = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeIncoming = () => controller.terminate(); } });
    const exit = () => { closeOutgoing(); closeIncoming(); };
    const peer = new AgentSideConnection((connection) => served(connection, exit), ndJsonStream(incoming.writable, outgoing.readable));
    const connection = new ClientSideConnection(() => client, ndJsonStream(outgoing.writable, incoming.readable));
    return { connection, stop: async () => {
      onStop(); exit();
      await Promise.all([connection.closed, peer.closed]);
    } };
  };
}

/**
 * A connection factory for an ACP agent that, on each prompt, connects to the
 * Band MCP server the adapter offered its session and runs `script` against it.
 */
export function bandMcpAgent(script: (band: McpClient) => Promise<void>) {
  let access: { url: string; authorization: string } | undefined;
  return inMemoryAgent((peer): Agent => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }),
    authenticate: async () => ({}),
    newSession: async ({ mcpServers }) => {
      const band = mcpServers.find((server) => "url" in server);
      const authorization = band && "headers" in band ? band.headers.find((header) => header.name === "Authorization")?.value : undefined;
      access = band && authorization ? { url: band.url, authorization } : undefined;
      return { sessionId: "session-1" };
    },
    cancel: async () => {},
    prompt: async ({ sessionId }) => {
      if (!access) throw new Error("The session was offered no Band MCP server");
      const transport = new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { authorization: access.authorization } } });
      const band = new McpClient({ name: "band-mcp-agent", version: "1.0.0" });
      await band.connect(transport);
      try {
        await script(band);
      } finally {
        await transport.close();
      }
      await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    },
  }));
}

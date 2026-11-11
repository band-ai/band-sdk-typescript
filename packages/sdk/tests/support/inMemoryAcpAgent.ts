import { AgentSideConnection, ClientSideConnection, ndJsonStream, type Agent, type Client } from "@agentclientprotocol/sdk";

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

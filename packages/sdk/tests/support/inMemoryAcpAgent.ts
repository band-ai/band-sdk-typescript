import { AgentSideConnection, ClientSideConnection, ndJsonStream, type Agent, type Client } from "@agentclientprotocol/sdk";

/** A connection factory serving `served` over in-memory pipes, to the adapter's own client. */
export function inMemoryAgent(served: (peer: AgentSideConnection) => Agent, onStop: () => void = () => {}) {
  return async (client: Client) => {
    let closeOutgoing!: () => void;
    let closeIncoming!: () => void;
    const outgoing = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeOutgoing = () => controller.terminate(); } });
    const incoming = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeIncoming = () => controller.terminate(); } });
    const peer = new AgentSideConnection(served, ndJsonStream(incoming.writable, outgoing.readable));
    const connection = new ClientSideConnection(() => client, ndJsonStream(outgoing.writable, incoming.readable));
    return { connection, stop: async () => {
      onStop(); closeOutgoing(); closeIncoming();
      await Promise.all([connection.closed, peer.closed]);
    } };
  };
}

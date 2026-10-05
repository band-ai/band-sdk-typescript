/**
 * Band's REST identity endpoint on a local port: `GET /api/v1/agent/me` answers
 * for the agents it knows by API key and refuses any other key with 401, so the
 * plugin's real REST client runs end to end.
 */
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const AGENT_ME_PATH = "/api/v1/agent/me";
const API_KEY_HEADER = "x-api-key";

export interface PeerAgent {
  readonly id: string;
  readonly apiKey: string;
  readonly name: string;
  readonly handle: string | null;
}

export class BandRestPeer implements AsyncDisposable {
  private constructor(private readonly server: Server) {}

  public static async start(agents: readonly PeerAgent[]): Promise<BandRestPeer> {
    const server = createServer((request, response) => {
      const agent = agents.find((candidate) => candidate.apiKey === request.headers[API_KEY_HEADER]);
      if (request.url !== AGENT_ME_PATH) {
        respond(response, 404, { error: "not_found" });
      } else if (!agent) {
        respond(response, 401, { error: "unauthorized" });
      } else {
        respond(response, 200, { data: { id: agent.id, name: agent.name, description: null, handle: agent.handle, owner_uuid: null } });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return new BandRestPeer(server);
  }

  /** The WebSocket URL an agent of this peer is configured with; its REST URL derives from it. */
  public get wsUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/api/v1/socket`;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    // The REST client keeps its connection alive.
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

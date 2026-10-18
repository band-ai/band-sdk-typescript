import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { BandClient } from "@band-ai/rest-client";
import { FernRestAdapter } from "../../src/client/rest/FernRestAdapter";
import { RestFacade } from "../../src/client/rest/RestFacade";
import { FakeTransport, RecordLog } from "../testUtils";

export interface ActivityRequest {
  request: IncomingMessage;
  response: ServerResponse;
  body: Record<string, unknown>;
}

export async function activityPeer(handle: (request: ActivityRequest) => void | Promise<void>) {
  const requests = new RecordLog<ActivityRequest>();
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const entry = { request, response, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    requests.record(entry);
    await handle(entry);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No activity peer port");
  const origin = `http://127.0.0.1:${address.port}`;
  const rest = new RestFacade({ api: new FernRestAdapter(new BandClient({ apiKey: "secret-test-key", baseUrl: origin })) });
  return {
    origin, rest, requests,
    linkOptions: { agentId: "agent", apiKey: "secret-test-key", restUrl: origin, restApi: rest, transport: new FakeTransport() },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

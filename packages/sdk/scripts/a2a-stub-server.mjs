#!/usr/bin/env node
/** Minimal stub so A2AAdapter.createClient() can connect during example smoke runs. */
import http from "node:http";

const port = Number(process.env.A2A_STUB_PORT ?? "10000");

const agentCard = JSON.stringify({
  name: "stub-a2a-agent",
  description: "Local stub for band-sdk example smoke",
  url: `http://127.0.0.1:${port}`,
  version: "0.0.1",
  capabilities: {},
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [],
});

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.includes("agent-card") || url.includes(".well-known")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(agentCard);
    return;
  }
  if (req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          kind: "task",
          id: "stub-task",
          contextId: "stub-ctx",
          status: { state: "completed", message: { parts: [{ kind: "text", text: "stub ok" }] } },
        },
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[a2a-stub] listening on http://127.0.0.1:${port}`);
});

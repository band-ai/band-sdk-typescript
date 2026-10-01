// Minimal ACP agent over stdio, for tests that need a real subprocess:
// `command: [process.execPath, fakeAcpAgentPath]`. Every prompt is answered
// with one `ok` chunk. `FAKE_ACP_STDERR_BYTES` writes that much to stderr
// before serving, synchronously, so an undrained pipe blocks it for real.
import { writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const STDERR_LINE = `${"x".repeat(1023)}\n`;

const stderrBytes = Number(process.env.FAKE_ACP_STDERR_BYTES ?? 0);
for (let written = 0; written < stderrBytes; written += STDERR_LINE.length) {
  writeSync(2, STDERR_LINE);
}

let nextSession = 0;
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => ({
  initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
  authenticate: async () => ({}),
  newSession: async () => ({ sessionId: `session-${++nextSession}` }),
  prompt: async ({ sessionId }) => {
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    return { stopReason: "end_turn" };
  },
  cancel: async () => undefined,
}), stream);

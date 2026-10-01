// Minimal ACP agent over stdio, for tests that need a real subprocess:
// `command: [process.execPath, fakeAcpAgentPath]`. Every prompt is answered
// with one chunk naming this process and where it runs, as
// `pid=<pid> cwd=<process cwd> session=<session cwd>`. `FAKE_ACP_PID_FILE`
// names a file, relative to its working directory, that it writes its pid to as
// soon as it starts, so a test can find a process that never got to answer.
// `FAKE_ACP_STDERR_BYTES` writes
// that much to stderr before serving, synchronously, so an undrained pipe
// blocks it for real.
import { writeFileSync, writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const STDERR_LINE = `${"x".repeat(1023)}\n`;

if (process.env.FAKE_ACP_PID_FILE) {
  writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
}

const stderrBytes = Number(process.env.FAKE_ACP_STDERR_BYTES ?? 0);
for (let written = 0; written < stderrBytes; written += STDERR_LINE.length) {
  writeSync(2, STDERR_LINE);
}

const sessionCwds = new Map();
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => ({
  initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
  authenticate: async () => ({}),
  newSession: async ({ cwd }) => {
    const sessionId = `session-${sessionCwds.size + 1}`;
    sessionCwds.set(sessionId, cwd);
    return { sessionId };
  },
  prompt: async ({ sessionId }) => {
    const text = `pid=${process.pid} cwd=${process.cwd()} session=${sessionCwds.get(sessionId)}`;
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    return { stopReason: "end_turn" };
  },
  cancel: async () => undefined,
}), stream);

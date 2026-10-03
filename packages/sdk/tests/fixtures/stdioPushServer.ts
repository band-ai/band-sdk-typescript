// Stands in for a stdio plugin process (e.g. the Claude Code channel): it serves
// Band tools on real stdin/stdout and pushes a numbered notification from the
// moment it starts, before any client has connected, like a backlog replay. It
// keeps pushing until the server stops, then exits 0; a crash exits non-zero.
import { setTimeout as sleep } from "node:timers/promises";

import { BandMcpStdioServer } from "../../src/mcp/stdio";
import { FakeAgentTools } from "../../src/testing/FakeAgentTools";

export const PUSH_METHOD = "notifications/test/push";
export const PUSH_CAPABILITY = "test/push";
export const PUSH_INSTRUCTIONS = "Reply through the Band tools.";
/** Bytes of filler per push, so a client that stops reading fills the pipe. */
export const PAYLOAD_BYTES_ENV = "PUSH_PAYLOAD_BYTES";
/** Written to stderr when a push is still waiting on a full pipe. */
export const BACKPRESSURED = "push waiting on a full pipe";
const PUSH_INTERVAL_MS = 10;

async function main(): Promise<void> {
  const filler = "x".repeat(Number(process.env[PAYLOAD_BYTES_ENV] ?? 0));
  const server = new BandMcpStdioServer({
    tools: new FakeAgentTools(),
    capabilities: { experimental: { [PUSH_CAPABILITY]: {} } },
    instructions: PUSH_INSTRUCTIONS,
  });
  await server.start();

  for (let seq = 0; ; seq += 1) {
    const sent = server.notify(PUSH_METHOD, { seq, filler });
    const settled = sent.then(() => true, () => true);
    if (!(await Promise.race([settled, sleep(PUSH_INTERVAL_MS, false)]))) {
      process.stderr.write(`${BACKPRESSURED}\n`);
    }
    try {
      await sent;
    } catch {
      return;
    }
    await sleep(PUSH_INTERVAL_MS);
  }
}

if (process.argv[1] === import.meta.filename) {
  await main();
}

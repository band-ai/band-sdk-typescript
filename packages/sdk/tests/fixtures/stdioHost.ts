// Stands in for a plugin host (e.g. the Claude Code channel): it serves Band
// tools on real stdin/stdout while a long-lived resource, like its Band socket,
// keeps the process alive. Once the server stops it releases that resource and
// exits 0; if the server never reports stopping, it exits NEVER_RELEASED_EXIT_CODE.
import { BandMcpStdioServer } from "../../src/mcp/stdio";
import { FakeAgentTools } from "../../src/testing/FakeAgentTools";

const NEVER_RELEASED_EXIT_CODE = 3;
// Well past a client's handshake and tool listing, well inside a test's timeout.
const HOLD_LIMIT_MS = 15_000;

const resource = setTimeout(() => process.exit(NEVER_RELEASED_EXIT_CODE), HOLD_LIMIT_MS);
const server = new BandMcpStdioServer({ tools: new FakeAgentTools() });
await server.start();

await server.stopped;
clearTimeout(resource);
// Exit as the plugin does, rather than waiting for its stdio handles to close.
process.exit(0);

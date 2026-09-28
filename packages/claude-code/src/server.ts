import { BandLink, loadAgentConfigFromEnv } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { AgentRuntime } from "@band-ai/sdk/runtime";

import { AckTracker, wrapToolsForAck } from "./ack.js";
import { parseAllowedSenders } from "./gating.js";
import { createMessageHandler } from "./handler.js";
import { LastSenderTracker, wrapToolsForMentionFallback } from "./mentions.js";
import { buildInstructions } from "./prompt.js";

/**
 * All logging must go to stderr: stdout is the MCP protocol pipe to Claude
 * Code, and anything else written there corrupts the stdio transport.
 */
function stderrLog(level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  process.stderr.write(`[band] ${level}: ${message}${suffix}\n`);
}

const stderrLogger: Logger = {
  debug: (message, context) => stderrLog("debug", message, context),
  info: (message, context) => stderrLog("info", message, context),
  warn: (message, context) => stderrLog("warn", message, context),
  error: (message, context) => stderrLog("error", message, context),
};

async function main(): Promise<void> {
  const credentials = loadAgentConfigFromEnv();
  const link = new BandLink({
    agentId: credentials.agentId,
    apiKey: credentials.apiKey,
    wsUrl: credentials.wsUrl,
    restUrl: credentials.restUrl,
    logger: stderrLogger,
  });

  // `runtimeRef.current` is set once AgentRuntime is constructed below; the
  // tool resolver is only ever invoked from an MCP tool call, which cannot
  // happen before both `server.start()` and `runtime.start()` have completed.
  const runtimeRef: { current?: AgentRuntime } = {};
  const ackTracker = new AckTracker(link, stderrLogger);
  const lastSenderTracker = new LastSenderTracker();

  const server = new BandMcpStdioServer({
    tools: (roomId) => {
      const tools = runtimeRef.current?.getOrCreateContext(roomId).getTools();
      if (!tools) return undefined;
      const withMentionFallback = wrapToolsForMentionFallback(tools, roomId, {
        listParticipants: (id) => link.rest.listChatParticipants(id),
        selfId: selfAgentId,
        lastSenderTracker,
        logger: stderrLogger,
      });
      return wrapToolsForAck(withMentionFallback, roomId, ackTracker);
    },
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    // Task #12 threads the real AgentToolsCapabilities (enable_contacts/
    // enable_memory) through here instead of this empty stub.
    instructions: buildInstructions(),
  });

  await server.start();
  await link.connect();

  const me = await link.rest.getAgentMe();
  const selfAgentId = me.id;
  const ownerId = me.ownerUuid ?? null;
  const allowedSenderIds = parseAllowedSenders(process.env.BAND_ALLOWED_SENDERS);
  const self = { id: selfAgentId, name: me.name, handle: me.handle };

  const onExecute = createMessageHandler({
    self,
    ownerId,
    allowedSenderIds,
    listParticipants: (roomId) => link.rest.listChatParticipants(roomId),
    ackTracker,
    lastSenderTracker,
    notify: (content, meta) => server.notify("notifications/claude/channel", { content, meta }),
    logger: stderrLogger,
  });

  const runtime = new AgentRuntime({
    link,
    agentId: selfAgentId,
    logger: stderrLogger,
    agentConfig: { autoSubscribeExistingRooms: true },
    onExecute,
    onError: (error, event) => {
      stderrLogger.error("fatal runtime error", {
        room_id: event.roomId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  runtimeRef.current = runtime;

  await runtime.start();
  stderrLogger.info("connected to Band", { agent_id: selfAgentId });
}

main().catch((error: unknown) => {
  stderrLogger.error("fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

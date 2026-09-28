import { BandLink, loadAgentConfigFromEnv, type PlatformEvent } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { AgentRuntime } from "@band-ai/sdk/runtime";

import { BAND_INSTRUCTIONS } from "./prompt.js";

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

  const server = new BandMcpStdioServer({
    tools: (roomId) => runtimeRef.current?.getOrCreateContext(roomId).getTools(),
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: BAND_INSTRUCTIONS,
  });

  await server.start();
  await link.connect();

  const me = await link.rest.getAgentMe();
  const selfAgentId = me.id;

  const runtime = new AgentRuntime({
    link,
    agentId: selfAgentId,
    logger: stderrLogger,
    agentConfig: { autoSubscribeExistingRooms: true },
    onExecute: async (context, event: PlatformEvent) => {
      if (event.type !== "message_created") return;

      const payload = event.payload;
      if (payload.sender_id === selfAgentId) return;
      if (payload.message_type !== "text") return;

      // Sender/mention gating (task #4) and the processing->processed ack
      // lifecycle (task #5) land in follow-up commits; every message that
      // reaches here is currently pushed unconditionally.
      try {
        await server.notify("notifications/claude/channel", {
          content: payload.content,
          meta: {
            room_id: context.roomId,
            sender_id: payload.sender_id,
            sender_name: payload.sender_name ?? "",
            message_id: payload.id,
          },
        });
      } catch (error) {
        stderrLogger.error("failed to push notifications/claude/channel", {
          room_id: context.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
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

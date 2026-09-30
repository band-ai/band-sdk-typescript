import { BandLink } from "@band-ai/sdk";
import {
  BAND_HUMAN_PLATFORM_ORIGIN,
  createBandHumanAuth,
  createSystemCredentialStore,
} from "@band-ai/sdk/auth";
import type { Logger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { AgentRuntime } from "@band-ai/sdk/runtime";

import { AckTracker, wrapToolsForAck } from "./ack.js";
import { capabilitiesToPromptList, parseCapabilitiesFromEnv } from "./capabilities.js";
import { PrivilegedCommandAuthorizer } from "./commandAuthorization.js";
import {
  BandConnectionController,
  type ActiveBandRuntime,
} from "./connection.js";
import { parseAllowedSenders } from "./gating.js";
import { createMessageHandler } from "./handler.js";
import { LastSenderTracker, wrapToolsForMentionFallback } from "./mentions.js";
import { buildInstructions } from "./prompt.js";
import {
  PluginStateStore,
  pluginDataRoot,
  resolveClaudeSessionContext,
} from "./state.js";

/**
 * All logging must go to stderr: stdout is the MCP protocol pipe to Claude
 * Code, and anything else written there corrupts the stdio transport.
 */
function stderrLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
): void {
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  process.stderr.write(`[band] ${level}: ${message}${suffix}\n`);
}

const stderrLogger: Logger = {
  debug: (message, context) => stderrLog("debug", message, context),
  info: (message, context) => stderrLog("info", message, context),
  warn: (message, context) => stderrLog("warn", message, context),
  error: (message, context) => stderrLog("error", message, context),
};

interface RuntimeResources {
  runtime: AgentRuntime;
  link: BandLink;
  agentId: string;
  ackTracker: AckTracker;
  lastSenderTracker: LastSenderTracker;
}

async function main(): Promise<void> {
  const capabilities = parseCapabilitiesFromEnv();
  const enabledPromptCapabilities = capabilitiesToPromptList(capabilities);
  const context = await resolveClaudeSessionContext();
  const state = new PluginStateStore(pluginDataRoot());
  const credentials = createSystemCredentialStore({ service: "ai.band.claude-code" });
  const auth = await createBandHumanAuth({
    store: credentials,
    platformUrl: process.env.BAND_PLATFORM_URL || BAND_HUMAN_PLATFORM_ORIGIN,
  });
  const runtimeRef: { current?: RuntimeResources } = {};

  const startRuntime = async (input: {
    scope: string;
    agentId: string;
    apiKey: string;
    platformOrigin: string;
  }): Promise<ActiveBandRuntime> => {
    const link = new BandLink({
      agentId: input.agentId,
      apiKey: input.apiKey,
      wsUrl: process.env.BAND_WS_URL || websocketUrl(input.platformOrigin),
      restUrl: input.platformOrigin,
      logger: stderrLogger,
      capabilities,
    });
    const ackTracker = new AckTracker(link, stderrLogger);
    const lastSenderTracker = new LastSenderTracker();
    try {
      await link.connect();
      const me = await link.rest.getAgentMe();
      if (me.id.toLowerCase() !== input.agentId.toLowerCase()) {
        throw new Error("Stored credential belongs to another Band agent");
      }
      const selfAgentId = me.id;
      const ownerId = me.ownerUuid ?? null;
      const commandAuthorizer = new PrivilegedCommandAuthorizer({
        ownerId: ownerId ?? "",
        profile: {
          scope: input.scope,
          projectRoot: context.projectRoot,
          agentId: selfAgentId,
        },
        state,
        host: {
          supportsFormElicitation: () =>
            server.clientCapabilities?.elicitation?.form !== undefined,
          elicitInput: (params) => server.elicitInput(params),
        },
        logger: stderrLogger,
      });
      const onExecute = createMessageHandler({
        self: { id: selfAgentId, name: me.name, handle: me.handle },
        ownerId,
        allowedSenderIds: parseAllowedSenders(process.env.BAND_ALLOWED_SENDERS),
        listParticipants: (roomId) => link.rest.listChatParticipants(roomId),
        commandAuthorizer,
        sendMessage: (roomId, message) => link.rest.createChatMessage(roomId, message),
        ackTracker,
        lastSenderTracker,
        notify: (content, meta) =>
          server.notify("notifications/claude/channel", { content, meta }),
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
      await runtime.start();
      runtimeRef.current = { runtime, link, agentId: selfAgentId, ackTracker, lastSenderTracker };
      stderrLogger.info("connected to Band", { agent_id: selfAgentId });
      return {
        async stop() {
          if (runtimeRef.current?.runtime === runtime) runtimeRef.current = undefined;
          try {
            await runtime.stop();
          } finally {
            await link.disconnect();
          }
        },
      };
    } catch (error) {
      runtimeRef.current = undefined;
      await link.disconnect().catch(() => undefined);
      throw error;
    }
  };

  const controller = new BandConnectionController({
    auth,
    credentials,
    state,
    context,
    startRuntime,
    logger: stderrLogger,
  });
  const server = new BandMcpStdioServer({
    tools: (roomId) => {
      const resources = runtimeRef.current;
      const tools = resources?.runtime.getOrCreateContext(roomId).getTools();
      if (resources === undefined || tools === undefined) return undefined;
      const withMentionFallback = wrapToolsForMentionFallback(tools, roomId, {
        listParticipants: (id) => resources.link.rest.listChatParticipants(id),
        selfId: resources.agentId,
        lastSenderTracker: resources.lastSenderTracker,
        logger: stderrLogger,
      });
      return wrapToolsForAck(withMentionFallback, roomId, resources.ackTracker);
    },
    enableContactTools: capabilities.contacts,
    enableMemoryTools: capabilities.memory,
    additionalTools: controller.registrations(),
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    onInitialized: () => {
      void controller.promptForAuthentication();
    },
    instructions:
      "Use band_connection_status before Band work. If disconnected, authenticate, list identities, and connect this Claude transcript first.\n\n" +
      buildInstructions(enabledPromptCapabilities),
  });


  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await controller.stop();
      await server.stop();
    } finally {
      state.close();
    }
  };
  const requestStop = (): void => {
    void stop().catch((error: unknown) => {
      stderrLogger.error("failed to stop Band plugin", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.stdin.once("end", requestStop);

  controller.attachHost({
    supportsUrlElicitation: () =>
      server.clientCapabilities?.elicitation?.url !== undefined,
    elicitInput: (params) => server.elicitInput(params),
    createElicitationCompletionNotifier: (elicitationId) =>
      server.createElicitationCompletionNotifier(elicitationId),
  });
  await server.start();
  await controller.initialize();
}

function websocketUrl(platformOrigin: string): string {
  const url = new URL(platformOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/socket";
  return url.toString().replace(/\/$/, "");
}

main().catch((error: unknown) => {
  stderrLogger.error("fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

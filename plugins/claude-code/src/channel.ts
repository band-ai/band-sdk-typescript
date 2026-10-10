import { DeliveryFailedError, type Logger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import type { Readable, Writable } from "node:stream";

import { AgentResources } from "./agentResources";
import { AgentSession, type LinkFactory } from "./agentSession";
import { bandChannelOn } from "./channelFlag";
import { AGENT_SELECT_ENV, type Env } from "./config";
import { CHANNEL_INSTRUCTIONS, CHANNEL_OFF_INSTRUCTIONS } from "./prompt";
import { SESSION_TEXT, SessionStatusFile } from "./sessions";
import { connectTool } from "./tools";

/** The experimental capability that makes Claude Code register the server as a channel. */
export const CHANNEL_CAPABILITY = "claude/channel";
/** The Claude Code notification that injects a channel event into the session. */
export const CHANNEL_METHOD = "notifications/claude/channel";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** Stands in for `interrupted` outside a process that can be signalled. */
const NEVER = new Promise<void>(() => undefined);

export interface RunChannelOptions {
  /** The command line of the process that started the server: Claude Code's, saying whether Band's channel is on. */
  readonly parentArgs: readonly string[] | undefined;
  /** The server's environment, as Claude Code sets it for the plugin. */
  readonly env: Env;
  /** Overrides for each connection's link, such as a test platform's transport and REST API. */
  readonly link?: LinkFactory;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  /** Settles when the process is told to stop (SIGINT or SIGTERM), as Claude Code stops its servers. */
  readonly interrupted?: Promise<void>;
  readonly logger: Logger;
}

/**
 * Serves one Claude Code session until either side leaves, and resolves with the process exit code.
 * Without Band's channel it lists nothing; with it, the agent the user picks.
 */
export async function runChannel(options: RunChannelOptions): Promise<number> {
  const channelOn = bandChannelOn(options.parentArgs, options.env);
  const status = SessionStatusFile.open(options.env, channelOn ? SESSION_TEXT.notPicked : SESSION_TEXT.noChannel, options.logger);
  try {
    await (channelOn ? serveChannel(options, status) : serveOff(options));
    status?.remove();
    return EXIT_OK;
  } catch (error) {
    options.logger.error("Band channel stopped", { error });
    return EXIT_FAILED;
  }
}

/** No tools and no connection to Band: Claude only learns how to restart with the channel. */
async function serveOff({ stdin, stdout, interrupted = NEVER }: RunChannelOptions): Promise<void> {
  const server = new BandMcpStdioServer({ instructions: CHANNEL_OFF_INSTRUCTIONS, stdin, stdout });
  await server.start();
  await Promise.race([server.stopped, interrupted]);
  await server.stop();
}

async function serveChannel({ env, link, stdin, stdout, interrupted = NEVER, logger }: RunChannelOptions, status: SessionStatusFile | undefined): Promise<void> {
  // Listed from the start: Claude Code asks for the tools as soon as it connects.
  const resources = new AgentResources();
  const connect = connectTool(() => agentSession.ask());
  const server: BandMcpStdioServer = new BandMcpStdioServer({
    additionalTools: [connect],
    resources,
    capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } },
    instructions: CHANNEL_INSTRUCTIONS,
    stdin,
    stdout,
  });
  const agentSession = new AgentSession({
    server,
    connectTool: connect,
    resources,
    env,
    status,
    link,
    logger,
    push: async (push) => {
      try {
        await server.notify(CHANNEL_METHOD, push);
      } catch (error) {
        throw new DeliveryFailedError(error);
      }
    },
  });

  await server.start();
  try {
    void start(server, agentSession, env[AGENT_SELECT_ENV]).catch((error: unknown) => {
      logger.error("Band channel couldn't pick an agent", { error });
    });
    // Claude Code leaving, or stopping the process, ends the session.
    await Promise.race([server.stopped, interrupted]);
  } finally {
    const cleanup = await Promise.allSettled([agentSession.close(), server.stop()]);
    const errors = cleanup.flatMap((result): unknown[] => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Band channel cleanup failed");
    }
  }
}

/**
 * Connects as the agent `BAND_AGENT` names, or asks once Claude Code has listed the tools. Claude Code cancels a
 * question that arrives before it has processed the listings, so the `connect` tool stays as the sure way to it.
 */
async function start(server: BandMcpStdioServer, agentSession: AgentSession, selected: string | undefined): Promise<void> {
  if (selected) {
    await agentSession.connectAs(selected);
    return;
  }
  await server.toolsListed;
  await agentSession.ask();
}

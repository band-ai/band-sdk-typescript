import type { PlatformRuntimeOptions } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import type { Logger } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import { PlatformRuntime } from "@band-ai/sdk/runtime";
import type { Readable, Writable } from "node:stream";

import { ChannelAdapter } from "./adapter";
import { CHANNEL_INSTRUCTIONS } from "./prompt";

/** The experimental capability that makes Claude Code register the server as a channel. */
export const CHANNEL_CAPABILITY = "claude/channel";
/** The Claude Code notification that injects a channel event into the session. */
export const CHANNEL_METHOD = "notifications/claude/channel";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

// Once the session ends, the runtime stops at the turn in flight rather than draining the backlog
// into a server that can't push it; what it didn't start waits on the platform for the next session.
const STOP_WITHOUT_DRAINING_MS = 0;

export interface RunChannelOptions {
  readonly credentials: AgentCredentials;
  /** Overrides for the runtime's own link, such as a test platform's transport and REST API. */
  readonly link?: PlatformRuntimeOptions["linkOptions"];
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly logger: Logger;
}

/**
 * Serves one Claude Code session as the Band agent until either side leaves,
 * and resolves with the process exit code.
 */
export async function runChannel({ credentials, link, stdin, stdout, logger }: RunChannelOptions): Promise<number> {
  const runtime = new PlatformRuntime({
    ...credentials,
    logger,
    // Without "reject" the platform hands the agent to the newest session and silently drops the one already serving it.
    linkOptions: { conflictPolicy: "reject", ...link },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
  await runtime.initialize();
  const { ownerUuid } = await runtime.link.rest.getAgentMe();

  const adapter = new ChannelAdapter({ ownerUuid, push: (push) => server.notify(CHANNEL_METHOD, push) });
  const server: BandMcpStdioServer = new BandMcpStdioServer({
    tools: (roomId) => adapter.toolsFor(roomId),
    capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } },
    instructions: CHANNEL_INSTRUCTIONS,
    stdin,
    stdout,
  });

  await server.start();
  const serve = async (): Promise<number> => {
    // Messages waiting on the platform are pushed only once Claude Code can receive them.
    await server.initialized;
    await runtime.start(adapter);
    await runtime.runForever();
    return EXIT_OK;
  };
  try {
    // Claude Code leaving settles first, whichever phase it interrupts.
    return await Promise.race([server.stopped.then(() => EXIT_OK), serve()]);
  } catch (error) {
    logger.error("Band channel stopped", { error });
    return EXIT_FAILED;
  } finally {
    // stop() rethrows the error a superseded runtime failed with, which is already logged.
    await Promise.allSettled([runtime.stop(STOP_WITHOUT_DRAINING_MS), server.stop()]);
  }
}

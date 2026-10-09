import type { PlatformRuntimeOptions } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import { DeliveryFailedError, WebSocketDisconnectError, type Logger, type WebSocketDisconnectReason } from "@band-ai/sdk/core";
import { BandMcpStdioServer } from "@band-ai/sdk/mcp";
import type { AgentIdentity } from "@band-ai/sdk/rest";
import { PlatformRuntime } from "@band-ai/sdk/runtime";
import type { Readable, Writable } from "node:stream";

import { ChannelAdapter } from "./adapter";
import { USE_HINT } from "./config";
import { MessageMemory } from "./messages";
import { handleOf } from "./names";
import { CHANNEL_INSTRUCTIONS } from "./prompt";
import { sessionLocation, type SessionStatus, type SessionStatusFile } from "./sessions";
import { bandTools, type ToolContext } from "./tools";
import { WorkingIndicator } from "./working";

/** The experimental capability that makes Claude Code register the server as a channel. */
export const CHANNEL_CAPABILITY = "claude/channel";
/** The Claude Code notification that injects a channel event into the session. */
export const CHANNEL_METHOD = "notifications/claude/channel";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

// Once the session ends, the runtime stops at the turn in flight rather than draining the backlog
// into a server that can't push it; what it didn't start waits on the platform for the next session.
const STOP_WITHOUT_DRAINING_MS = 0;

/** Stands in for `interrupted` outside a process that can be signalled. */
const NEVER = new Promise<void>(() => undefined);

/** The platform's answer when another session already holds the agent. */
const CONNECTION_CONFLICT: Extract<WebSocketDisconnectReason, { source: "upgrade" }>["code"] = "connection_conflict";

export interface RunChannelOptions {
  /** The name the agent is saved under. */
  readonly agentName: string;
  readonly credentials: AgentCredentials;
  /** Where the session's state is kept for `/band:agents`; none outside Claude Code. */
  readonly status?: SessionStatusFile;
  /** Overrides for the runtime's own link, such as a test platform's transport and REST API. */
  readonly link?: PlatformRuntimeOptions["linkOptions"];
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  /** Settles when the process is told to stop (SIGINT or SIGTERM), as Claude Code stops its servers. */
  readonly interrupted?: Promise<void>;
  readonly logger: Logger;
}

/**
 * Serves one Claude Code session as the Band agent until either side leaves,
 * and resolves with the process exit code.
 */
export async function runChannel(options: RunChannelOptions): Promise<number> {
  try {
    await serveChannel(options);
    options.status?.remove();
    return EXIT_OK;
  } catch (error) {
    reportFailure(error, options);
    return EXIT_FAILED;
  }
}

async function serveChannel({ credentials, status, link, stdin, stdout, interrupted = NEVER, logger }: RunChannelOptions): Promise<void> {
  // Known before any network call, so the session shows as holding its agent from the start.
  status?.record({ agentId: credentials.agentId });
  const runtime = new PlatformRuntime({
    ...credentials,
    logger,
    // Without "reject" the platform hands the agent to the newest session and silently drops the one already serving it.
    linkOptions: { conflictPolicy: "reject", ...link },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
  // Nothing is connected yet, so a stop before Band answers just ends the session.
  const identity = await Promise.race([identify(runtime), interrupted.then(() => null)]);
  if (!identity) {
    return;
  }
  status?.record({ handle: identity.handle ?? null });

  const context: ToolContext = {
    link: runtime.link,
    self: { id: identity.id, handle: handleOf(identity) },
    memory: new MessageMemory(),
    working: new WorkingIndicator(runtime.link.rest, logger),
    logger,
  };

  const adapter = new ChannelAdapter({
    ownerUuid: identity.ownerUuid,
    memory: context.memory,
    working: context.working,
    push: async (push) => {
      try {
        await server.notify(CHANNEL_METHOD, push);
      } catch (error) {
        throw new DeliveryFailedError(error);
      }
    },
  });
  const server: BandMcpStdioServer = new BandMcpStdioServer({
    additionalTools: bandTools(context),
    capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } },
    instructions: CHANNEL_INSTRUCTIONS,
    stdin,
    stdout,
  });

  await server.start();
  const serve = async (): Promise<void> => {
    // Messages waiting on the platform are pushed only once Claude Code can receive them.
    await server.initialized;
    await runtime.start(adapter);
    status?.record({ state: "connected" });
    await runtime.runForever();
  };
  let servingFailed = false;
  try {
    // Claude Code leaving, or stopping the process, settles first, whichever phase it interrupts.
    await Promise.race([server.stopped, interrupted, serve()]);
  } catch (error) {
    servingFailed = true;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([context.working.stopAll(), runtime.stop(STOP_WITHOUT_DRAINING_MS), server.stop()]);
    const errors = cleanup.flatMap((result): unknown[] => result.status === "rejected" ? [result.reason] : []);
    if (!servingFailed && errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Band channel cleanup failed");
    }
  }
}

/** Who the agent is, once the runtime has checked its credentials with Band. */
async function identify(runtime: PlatformRuntime): Promise<AgentIdentity> {
  await runtime.initialize();
  return runtime.link.rest.getAgentMe();
}

function reportFailure(error: unknown, { agentName, credentials, status, logger }: RunChannelOptions): void {
  if (isConnectionConflict(error)) {
    const message = conflictMessage(agentName, status?.holder(credentials.agentId));
    status?.record({ state: "refused", error: message });
    logger.error(message, { error });
    return;
  }
  status?.failed(error);
  logger.error("Band channel stopped", { error });
}

function isConnectionConflict(error: unknown): boolean {
  return error instanceof WebSocketDisconnectError && error.reason.source === "upgrade" && error.reason.code === CONNECTION_CONFLICT;
}

function conflictMessage(agentName: string, holder: SessionStatus | undefined): string {
  const location = holder && sessionLocation(holder);
  return `Band agent "${agentName}" is already connected from another session${location ? ` (${location})` : ""}. Pick another with ${USE_HINT}.`;
}

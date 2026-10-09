import type { PlatformRuntimeOptions } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import { WebSocketDisconnectError, type Logger } from "@band-ai/sdk/core";
import type { BandMcpStdioServer, McpToolRegistration } from "@band-ai/sdk/mcp";
import type { AgentIdentity } from "@band-ai/sdk/rest";
import { ensureHandlePrefix, PlatformRuntime } from "@band-ai/sdk/runtime";

import { ChannelAdapter, type ChannelPush } from "./adapter";
import { agentCredentials, pluginDataDir, readSavedAgents, type Env, type SavedAgent } from "./config";
import { MessageMemory } from "./messages";
import { agentLabel, handleOf } from "./names";
import { agentQuestion, pickedAgent } from "./question";
import { liveSessions, SESSION_TEXT, type SessionChange, type SessionStatusFile } from "./sessions";
import { bandErrorText, bandTools, CONNECT_TOOL, type ToolContext } from "./tools";
import { WorkingIndicator } from "./working";

/** The longest timeout a request takes: the SDK's 60 s default would drop a pick while the question is still open. */
export const MAX_ELICIT_TIMEOUT_MS = 2 ** 31 - 1;

// Once the session ends, the runtime stops at the turn in flight rather than draining the backlog
// into a server that can't push it; what it didn't start waits on the platform for the next session.
const STOP_WITHOUT_DRAINING_MS = 0;

/** Band's reason when another connection took the agent over. */
const TAKEN_OVER = "session.already_connected";

/** Overrides for each connection's own link, such as a test platform's transport and REST API. */
export type LinkFactory = (credentials: AgentCredentials) => PlatformRuntimeOptions["linkOptions"];

export interface AgentSessionOptions {
  readonly server: BandMcpStdioServer;
  /** Listed while no agent is connected. */
  readonly connectTool: McpToolRegistration;
  /** The server's environment: where the agents are saved, and the Band they connect to. */
  readonly env: Env;
  readonly push: (push: ChannelPush) => Promise<void>;
  readonly status?: SessionStatusFile;
  readonly link?: LinkFactory;
  readonly logger: Logger;
}

/** The agent this server is connected as, picked by the user; the last pick of an agent wins on Band. */
export class AgentSession {
  private sentence: string = SESSION_TEXT.notPicked;
  private asking?: Promise<string>;
  /** The connection, or the attempt at one. */
  private runtime?: PlatformRuntime;
  private working?: WorkingIndicator;
  private closed = false;

  public constructor(private readonly options: AgentSessionOptions) {}

  /** Asks the user which saved agent to connect as, once at a time; resolves with the session's sentence. */
  public ask(): Promise<string> {
    this.asking ??= this.askOnce().finally(() => {
      this.asking = undefined;
    });
    return this.asking;
  }

  /** Connects as the saved agent `name`, as `BAND_AGENT` names it. */
  public connectAs(name: string): Promise<string> {
    const agent = readSavedAgents(pluginDataDir(this.options.env))[name];
    return agent ? this.connect(name, agent) : Promise.resolve(this.off(SESSION_TEXT.unsavedAgent(name)));
  }

  /** Ends the connection, or the attempt at one. */
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.working?.stopAll(), this.runtime?.stop(STOP_WITHOUT_DRAINING_MS)]);
  }

  private async askOnce(): Promise<string> {
    const dataDir = pluginDataDir(this.options.env);
    const saved = readSavedAgents(dataDir);
    if (Object.keys(saved).length === 0) {
      return this.off(SESSION_TEXT.noAgent);
    }
    this.off(SESSION_TEXT.asking);
    let picked: string | undefined;
    try {
      picked = pickedAgent(await this.options.server.elicitInput(agentQuestion(saved, liveSessions(dataDir)), { timeout: MAX_ELICIT_TIMEOUT_MS }));
    } catch (error) {
      this.options.logger.debug("The agent question failed", { error });
      return this.off(SESSION_TEXT.noElicitation);
    }
    const agent = picked === undefined ? undefined : saved[picked];
    return agent ? this.connect(picked!, agent) : this.off(SESSION_TEXT.notPicked);
  }

  /** A new runtime per attempt: a transport keeps its terminal error. */
  private async connect(name: string, agent: SavedAgent): Promise<string> {
    const { server, env, link, logger } = this.options;
    const credentials = agentCredentials(agent, env);
    const runtime = new PlatformRuntime({
      ...credentials,
      logger,
      linkOptions: { conflictPolicy: "supersede", ...link?.(credentials) },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    this.runtime = runtime;
    let identity: AgentIdentity;
    let context: ToolContext;
    try {
      identity = await identify(runtime);
      context = {
        link: runtime.link,
        self: { id: identity.id, handle: handleOf(identity) },
        memory: new MessageMemory(),
        working: new WorkingIndicator(runtime.link.rest, logger),
        logger,
      };
      // Messages waiting on the platform are pushed only once Claude Code can receive them.
      await server.initialized;
      await runtime.start(new ChannelAdapter({ ownerUuid: identity.ownerUuid, memory: context.memory, working: context.working, push: this.options.push }));
    } catch (error) {
      return this.closed ? this.sentence : this.failed(runtime, name, error);
    }
    this.working = context.working;
    // Recorded first, so a client that sees the tools change finds the status already says why.
    const sentence = this.record({ state: "connected", agent: name, agentId: identity.id, handle: identity.handle ?? null, sentence: SESSION_TEXT.connected(agentLabel(name, identity.handle)) });
    const tools = bandTools(context);
    server.removeTools([CONNECT_TOOL]);
    await server.addTools(tools);
    void this.serve(runtime, name, ensureHandlePrefix(identity.handle) ?? name, tools);
    return sentence;
  }

  /** Until the connection ends, which only `close()` does without an error. */
  private async serve(runtime: PlatformRuntime, name: string, handle: string, tools: readonly McpToolRegistration[]): Promise<void> {
    try {
      await runtime.runForever();
    } catch (error) {
      if (this.closed) {
        return;
      }
      await Promise.all([this.working?.stopAll(), stopQuietly(runtime, this.options.logger)]);
      this.working = undefined;
      this.runtime = undefined;
      this.off(isTakenOver(error) ? SESSION_TEXT.takenOver(handle) : SESSION_TEXT.ended(name, bandErrorText(error)));
      this.options.server.removeTools(tools.map((tool) => tool.name));
      await this.options.server.addTools([this.options.connectTool]);
    }
  }

  private async failed(runtime: PlatformRuntime, name: string, error: unknown): Promise<string> {
    this.runtime = undefined;
    await stopQuietly(runtime, this.options.logger);
    return this.off(SESSION_TEXT.connectFailed(name, bandErrorText(error)));
  }

  private off(sentence: string): string {
    return this.record({ state: "off", sentence });
  }

  private record(change: SessionChange): string {
    this.sentence = change.sentence;
    this.options.status?.record(change);
    return change.sentence;
  }
}

/** Who the agent is, once Band has checked its credentials over REST: a rejected key shows Band's reason. */
async function identify(runtime: PlatformRuntime): Promise<AgentIdentity> {
  await runtime.initialize();
  return runtime.link.rest.getAgentMe();
}

/** Stops a runtime that already failed, whose stop may report that failure again. */
async function stopQuietly(runtime: PlatformRuntime, logger: Logger): Promise<void> {
  try {
    await runtime.stop(STOP_WITHOUT_DRAINING_MS);
  } catch (error) {
    logger.debug("Stopping a failed Band connection failed", { error });
  }
}

function isTakenOver(error: unknown): boolean {
  return error instanceof WebSocketDisconnectError && error.reason.source === "agent_control" && error.reason.code === TAKEN_OVER;
}

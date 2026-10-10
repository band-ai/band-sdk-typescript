import type { PlatformRuntimeOptions } from "@band-ai/sdk";
import type { AgentCredentials } from "@band-ai/sdk/config";
import { WebSocketDisconnectError, type Logger } from "@band-ai/sdk/core";
import type { BandMcpStdioServer, McpToolRegistration } from "@band-ai/sdk/mcp";
import { ensureHandlePrefix, PlatformRuntime, supportsCapability } from "@band-ai/sdk/runtime";

import { ChannelAdapter, type ChannelPush } from "./adapter";
import { agentCredentials, pluginDataDir, readSavedAgents, type Env, type SavedAgent } from "./config";
import { MessageMemory } from "./messages";
import { agentLabel, handleOf } from "./names";
import { agentQuestion, pickedAgent } from "./question";
import { CONNECTED_STATE, OFF_STATE, sessionHints, SESSION_TEXT, type SessionChange, type SessionStatusFile } from "./sessions";
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
  /** The one attempt at an agent in flight, asked or named. */
  private attempt?: Promise<string>;
  /** The connection, or the attempt at one. */
  private runtime?: PlatformRuntime;
  private working?: WorkingIndicator;
  private closed = false;

  public constructor(private readonly options: AgentSessionOptions) {}

  /** Asks the user which saved agent to connect as; resolves with the session's sentence. */
  public ask(): Promise<string> {
    return this.once(() => this.askOnce());
  }

  /** Connects as the saved agent `name`, as `BAND_AGENT` names it. */
  public connectAs(name: string): Promise<string> {
    return this.once(async () => {
      const agent = readSavedAgents(pluginDataDir(this.options.env))[name];
      return agent ? this.connect(name, agent) : this.off(SESSION_TEXT.unsavedAgent(name));
    });
  }

  /** Ends the connection, or the attempt at one. */
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.working?.stopAll(), this.runtime?.stop(STOP_WITHOUT_DRAINING_MS)]);
  }

  /** Runs `attempt` unless one is in flight, which every caller then waits on instead. */
  private once(attempt: () => Promise<string>): Promise<string> {
    this.attempt ??= attempt().finally(() => {
      this.attempt = undefined;
    });
    return this.attempt;
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
      picked = pickedAgent(await this.options.server.elicitInput(agentQuestion(saved, sessionHints(dataDir, this.options.logger)), { timeout: MAX_ELICIT_TIMEOUT_MS }));
    } catch (error) {
      // Stopping the server also fails a question still open.
      if (this.closed) {
        return this.sentence;
      }
      this.options.logger.debug("The agent question failed", { error });
      return this.off(SESSION_TEXT.noElicitation);
    }
    if (picked === undefined || !saved[picked]) {
      return this.off(SESSION_TEXT.notPicked);
    }
    return this.connect(picked, saved[picked]);
  }

  /** A new runtime per attempt: a transport keeps its terminal error. */
  private async connect(name: string, agent: SavedAgent): Promise<string> {
    const { server, env, link, logger } = this.options;
    const credentials = agentCredentials(agent, env);
    const runtime = new PlatformRuntime({
      ...credentials,
      logger,
      linkOptions: { ...link?.(credentials), conflictPolicy: "supersede", capabilities: { tasks: true } },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    this.runtime = runtime;
    let sentence: string;
    let handle: string;
    let listed: readonly McpToolRegistration[] = [];
    try {
      await runtime.initialize();
      const identity = await runtime.link.rest.getAgentMe();
      handle = ensureHandlePrefix(identity.handle) ?? name;
      const context: ToolContext = {
        link: runtime.link,
        self: { id: identity.id, handle: handleOf(identity) },
        board: supportsCapability(identity.featureFlags, "tasks"),
        memory: new MessageMemory(),
        working: new WorkingIndicator(runtime.link.rest, logger),
        logger,
      };
      this.working = context.working;
      // Nothing is listed or pushed until Claude Code can receive it.
      await server.initialized;
      // Recorded first, so a client that sees the tools change finds the status already says why.
      sentence = this.record({ state: CONNECTED_STATE, agent: name, agentId: identity.id, handle: identity.handle ?? null, sentence: SESSION_TEXT.connected(agentLabel(name, identity.handle)) });
      // Listed before delivery starts, which pushes as each room is ready, so Claude can answer every message.
      const tools = bandTools(context);
      server.removeTools([CONNECT_TOOL]);
      await server.addTools(tools);
      listed = tools;
      await runtime.start(new ChannelAdapter({ ownerUuid: identity.ownerUuid, memory: context.memory, working: context.working, push: this.options.push }));
    } catch (error) {
      if (this.closed) {
        return this.sentence;
      }
      logger.warn(`Band connection as ${name} failed`, { error });
      return this.release(runtime, listed, SESSION_TEXT.connectFailed(name, bandErrorText(error)));
    }
    if (this.closed) {
      return this.sentence;
    }
    this.serve(runtime, name, handle, listed).catch((error: unknown) => {
      logger.warn("Band couldn't list connect again after the connection ended", { error });
    });
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
      this.options.logger.warn(`Band connection as ${name} ended`, { error });
      await this.release(runtime, tools, isTakenOver(error) ? SESSION_TEXT.takenOver(handle) : SESSION_TEXT.ended(name, bandErrorText(error)));
    }
  }

  /** Ends a connection or a failed attempt at one: clears its working indicator, goes off, and lists `connect` in place of its tools. */
  private async release(runtime: PlatformRuntime, tools: readonly McpToolRegistration[], sentence: string): Promise<string> {
    await Promise.all([this.working?.stopAll(), stopQuietly(runtime, this.options.logger)]);
    if (this.closed) {
      return this.sentence;
    }
    this.working = undefined;
    this.runtime = undefined;
    this.off(sentence);
    if (tools.length > 0) {
      this.options.server.removeTools(tools.map((tool) => tool.name));
      await this.options.server.addTools([this.options.connectTool]);
    }
    return sentence;
  }

  private off(sentence: string): string {
    return this.record({ state: OFF_STATE, sentence });
  }

  private record(change: SessionChange): string {
    this.sentence = change.sentence;
    this.options.status?.record(change);
    return change.sentence;
  }
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

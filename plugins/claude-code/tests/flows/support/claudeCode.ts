/**
 * Claude Code's side of a flow test: a real MCP client on the plugin's stdio,
 * as Claude Code connects to the server it spawns, started with Band's channel
 * and the flow test agent saved unless the test says otherwise.
 */
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { NoopLogger, StderrLogger } from "@band-ai/sdk/core";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { ChannelPush } from "../../../src/adapter";
import type { LinkFactory } from "../../../src/agentSession";
import { runChannel, type RunChannelOptions } from "../../../src/channel";
import { AGENT_SELECT_ENV } from "../../../src/config";
import { TOOL } from "../../../src/tools";
import { AGENT_API_KEY, AGENT_HANDLE, AGENT_ID, type BandPlatform } from "../../../../../packages/sdk/tests/flows/support/bandPlatform";
import { callTool, ChannelClient, type ToolReply } from "../../support/channelClient";
import { ClaudeCodeDirs } from "../../support/claudeCodeDirs";

/** The name the flow test agent is saved under. */
export const AGENT_NAME = "main";
/** The flow test agent, as `/band:agents add` saves it. */
export const SAVED_AGENT = { agentId: AGENT_ID, apiKey: AGENT_API_KEY, handle: AGENT_HANDLE } as const;
/** How the README starts Claude Code with Band's channel. */
export const BAND_LAUNCH = "claude --channels plugin:band@band-ai";
export const SESSION_ID = "session-1";

/** Connections reach `platform`, which refuses any key but the flow test agent's. */
export function linkTo(platform: BandPlatform): LinkFactory {
  return (credentials) => platform.linkFor(credentials);
}

/**
 * How the session starts. By default: Claude Code's command line carries Band's channel, the flow test agent is
 * saved in fresh directories, and `BAND_AGENT` names it, so the session connects without asking.
 */
export interface SessionOptions {
  readonly commandLine?: string;
  /** Shared by the sessions of one machine; the session's own by default. */
  readonly dirs?: ClaudeCodeDirs;
  readonly sessionId?: string;
  /** What `BAND_AGENT` names; null leaves it unset, so the session asks. */
  readonly agent?: string | null;
  /** More of the server's environment, such as the plugin's Band URL. */
  readonly env?: Readonly<Record<string, string>>;
  /** Whether Claude Code can show the agent question; true by default. */
  readonly elicitation?: boolean;
  readonly logger?: RunChannelOptions["logger"];
}

export class ClaudeCodeSession implements AsyncDisposable {
  /** The plugin's exit code. */
  public readonly exited: Promise<number>;
  public readonly dirs: ClaudeCodeDirs;
  private readonly sessionId: string;
  private readonly ownsDirs: boolean;
  private readonly channel: ChannelClient;
  private readonly toPlugin = new PassThrough();
  private signalled!: () => void;
  private readonly interrupted = new Promise<void>((resolve) => {
    this.signalled = resolve;
  });

  /** Starts the plugin against a platform; Claude Code connects with `connect()`. */
  public constructor(
    link: LinkFactory | undefined,
    { commandLine = BAND_LAUNCH, dirs, sessionId = SESSION_ID, agent = AGENT_NAME, env, elicitation, logger }: SessionOptions = {},
  ) {
    this.sessionId = sessionId;
    this.ownsDirs = !dirs;
    this.dirs = dirs ?? new ClaudeCodeDirs();
    if (this.ownsDirs) {
      this.dirs.save({ [AGENT_NAME]: SAVED_AGENT });
    }
    const fromPlugin = new PassThrough();
    this.exited = runChannel({
      parentCommandLine: commandLine,
      env: { ...this.dirs.env(sessionId), ...(agent ? { [AGENT_SELECT_ENV]: agent } : {}), ...env },
      link,
      stdin: this.toPlugin,
      stdout: fromPlugin,
      interrupted: this.interrupted,
      logger: logger ?? (process.env.FLOW_DEBUG ? new StderrLogger() : new NoopLogger()),
    });
    this.channel = new ChannelClient(fromPlugin, this.toPlugin, this.exited, "test", { elicitation });
  }

  /** Starts the plugin and completes Claude Code's handshake; with `BAND_AGENT` set, resolves once the Band tools are listed. */
  public static async connect(link: LinkFactory | undefined, options: SessionOptions = {}): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(link, options);
    await session.connect();
    if (options.agent !== null) {
      await session.connected();
    }
    return session;
  }

  public connect(): Promise<void> {
    return this.channel.connect();
  }

  /** Resolves with the Band tools once they are listed. */
  public connected(): Promise<string[]> {
    return this.toolNamesWhen((names) => names.includes(TOOL.reply));
  }

  /** See {@link ChannelClient.toolNamesWhen}. */
  public toolNamesWhen(matches: (names: readonly string[]) => boolean): Promise<string[]> {
    return this.channel.toolNamesWhen(matches);
  }

  /** See {@link ChannelClient.holdInitialized}. */
  public holdInitialized(): ReturnType<ChannelClient["holdInitialized"]> {
    return this.channel.holdInitialized();
  }

  /** Queues the user's answer to the next agent question. */
  public answer(result: ElicitResult): void {
    this.channel.answer(result);
  }

  /** Resolves with the next agent question from the `from`th on. */
  public question(from?: number): Promise<ElicitRequestFormParams> {
    return this.channel.question(from);
  }

  public get questions(): ChannelClient["questions"] {
    return this.channel.questions;
  }

  public get pushes(): ChannelClient["pushes"] {
    return this.channel.pushes;
  }

  public get capabilities() {
    return this.channel.client.getServerCapabilities();
  }

  public get instructions(): string | undefined {
    return this.channel.client.getInstructions();
  }

  public async tools() {
    return (await this.channel.client.listTools()).tools;
  }

  public async toolNames(): Promise<string[]> {
    return (await this.tools()).map((tool) => tool.name);
  }

  public callTool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    return callTool(this.channel.client, name, args);
  }

  /** Runs `/band:agents status` in this session, as the skill does. */
  public status(): Promise<string> {
    return this.dirs.agents("status", this.sessionId);
  }

  /** Resolves with the push for `messageId` once Claude Code has it; rejects if the plugin exits first. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return this.channel.pushOf(messageId);
  }

  /** Claude Code exits; resolves once the plugin has seen it go, before the plugin has finished exiting. */
  public async departed(): Promise<void> {
    // Listeners run in order, so the plugin's own stdin `end` listener has run by the time this one does.
    const seen = once(this.toPlugin, "end");
    this.channel.leave();
    await seen;
  }

  /** Claude Code exits; resolves with the plugin's exit code. */
  public async leave(): Promise<number> {
    this.channel.leave();
    return this.exited;
  }

  /** Claude Code stops the server with a signal, as it does on exit; resolves with the plugin's exit code. */
  public async interrupt(): Promise<number> {
    this.signalled();
    return this.exited;
  }

  /** Only ends Claude Code's side: a test that cares how the plugin exits awaits `leave()`. */
  public async [Symbol.asyncDispose](): Promise<void> {
    this.channel.leave();
    if (this.ownsDirs) {
      await this.exited;
      this.dirs[Symbol.dispose]();
    }
  }
}

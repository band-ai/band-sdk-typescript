/**
 * Claude Code's side of a flow test: a real MCP client on the plugin's stdio,
 * as Claude Code connects to the server it spawns.
 */
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { NoopLogger, StderrLogger } from "@band-ai/sdk/core";

import type { ChannelPush } from "../../../src/adapter";
import { runChannel, type RunChannelOptions } from "../../../src/channel";
import { AGENT_API_KEY, AGENT_ID } from "../../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ChannelClient } from "../../support/channelClient";

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

/** The name the flow test agent is saved under. */
export const AGENT_NAME = "main";

/** How the plugin is set up for the session: the flow test agent, under its saved name, with no status kept, unless overridden. */
export interface SessionOptions {
  readonly credentials?: Partial<RunChannelOptions["credentials"]>;
  readonly agentName?: string;
  readonly status?: RunChannelOptions["status"];
}

export class ClaudeCodeSession implements AsyncDisposable {
  /** The plugin's exit code. */
  public readonly exited: Promise<number>;
  private readonly channel: ChannelClient;
  private readonly toPlugin = new PassThrough();

  /** Starts the plugin against a platform; Claude Code connects with `connect()`. */
  public constructor(link: RunChannelOptions["link"], { credentials, agentName = AGENT_NAME, status }: SessionOptions = {}) {
    const fromPlugin = new PassThrough();
    this.exited = runChannel({
      agentName,
      credentials: { agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...credentials },
      status,
      link,
      stdin: this.toPlugin,
      stdout: fromPlugin,
      logger: process.env.FLOW_DEBUG ? new StderrLogger() : new NoopLogger(),
    });
    this.channel = new ChannelClient(fromPlugin, this.toPlugin, this.exited, "test");
  }

  public static async connect(link: RunChannelOptions["link"], options?: SessionOptions): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(link, options);
    await session.connect();
    return session;
  }

  public connect(): Promise<void> {
    return this.channel.connect();
  }

  /** See {@link ChannelClient.holdInitialized}. */
  public holdInitialized(): ReturnType<ChannelClient["holdInitialized"]> {
    return this.channel.holdInitialized();
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

  public async callTool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = await this.channel.client.callTool({ name, arguments: args });
    const [first] = result.content as Array<{ text: string }>;
    return { text: first?.text ?? "", isError: result.isError === true };
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

  /** Only ends Claude Code's side: a test that cares how the plugin exits awaits `leave()`. */
  public async [Symbol.asyncDispose](): Promise<void> {
    this.channel.leave();
  }
}

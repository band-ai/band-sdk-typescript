/**
 * Claude Code's side of a flow test: a real MCP client on the plugin's stdio,
 * as Claude Code connects to the server it spawns.
 */
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { NoopLogger, StderrLogger } from "@band-ai/sdk/core";

import type { ChannelPush } from "../../../src/adapter";
import { runChannel, type RunChannelOptions } from "../../../src/channel";
import { AGENT_API_KEY, AGENT_ID } from "../../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ChannelClient } from "../../support/channelClient";

// A plugin that never exits fails the test that awaits it; teardown must not hang the suite on it too.
const TEARDOWN_GRACE_MS = 2_000;

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

export class ClaudeCodeSession implements AsyncDisposable {
  /** The plugin's exit code. */
  public readonly exited: Promise<number>;
  private readonly channel: ChannelClient;

  /** Starts the plugin against a platform; Claude Code connects with `connect()`. */
  public constructor(link: RunChannelOptions["link"], credentials?: Partial<RunChannelOptions["credentials"]>) {
    const toPlugin = new PassThrough();
    const fromPlugin = new PassThrough();
    this.exited = runChannel({
      credentials: { agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...credentials },
      link,
      stdin: toPlugin,
      stdout: fromPlugin,
      logger: process.env.FLOW_DEBUG ? new StderrLogger() : new NoopLogger(),
    });
    this.channel = new ChannelClient(fromPlugin, toPlugin, this.exited, "test");
  }

  public static async connect(
    link: RunChannelOptions["link"],
    credentials?: Partial<RunChannelOptions["credentials"]>,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(link, credentials);
    await session.connect();
    return session;
  }

  public connect(): Promise<void> {
    return this.channel.connect();
  }

  public get pushes(): ChannelClient["pushes"] {
    return this.channel.pushes;
  }

  public get capabilities() {
    return this.channel.client.getServerCapabilities();
  }

  public async toolNames(): Promise<string[]> {
    return (await this.channel.client.listTools()).tools.map((tool) => tool.name);
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

  /** Claude Code exits; resolves with the plugin's exit code. */
  public async leave(): Promise<number> {
    this.channel.leave();
    return this.exited;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await Promise.race([this.leave(), sleep(TEARDOWN_GRACE_MS)]);
  }
}

/**
 * Claude Code's side of a flow test: a real MCP client on the plugin's stdio,
 * as Claude Code connects to the server it spawns.
 */
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { NoopLogger, StderrLogger } from "@band-ai/sdk/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CHANNEL_METHOD, type ChannelPush } from "../../../src/adapter";
import { runChannel, type RunChannelOptions } from "../../../src/channel";
import { AGENT_ID } from "../../../../../packages/sdk/tests/flows/support/bandPlatform";
import { RecordLog } from "../../../../../packages/sdk/tests/testUtils";

// A plugin that never exits fails the test that awaits it; teardown must not hang the suite on it too.
const TEARDOWN_GRACE_MS = 2_000;

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

export class ClaudeCodeSession implements AsyncDisposable {
  public readonly pushes = new RecordLog<ChannelPush>();
  /** The plugin's exit code. */
  public readonly exited: Promise<number>;
  private readonly client = new Client({ name: "claude-code", version: "test" });
  private readonly toPlugin = new PassThrough();
  private readonly fromPlugin = new PassThrough();

  /** Starts the plugin against a platform; Claude Code connects with `connect()`. */
  public constructor(link: RunChannelOptions["link"], credentials?: Partial<RunChannelOptions["credentials"]>) {
    this.exited = runChannel({
      credentials: { agentId: AGENT_ID, apiKey: "flow-test-key", ...credentials },
      link,
      stdin: this.toPlugin,
      stdout: this.fromPlugin,
      logger: process.env.FLOW_DEBUG ? new StderrLogger() : new NoopLogger(),
    });
    this.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === CHANNEL_METHOD) {
        this.pushes.record(notification.params as unknown as ChannelPush);
      }
    };
  }

  public static async connect(
    link: RunChannelOptions["link"],
    credentials?: Partial<RunChannelOptions["credentials"]>,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(link, credentials);
    await session.connect();
    return session;
  }

  // The SDK's stdio transport takes any stream pair, so it also serves as the client end.
  public async connect(): Promise<void> {
    await this.client.connect(new StdioServerTransport(this.fromPlugin, this.toPlugin));
  }

  public get capabilities() {
    return this.client.getServerCapabilities();
  }

  public async toolNames(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((tool) => tool.name);
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = await this.client.callTool({ name, arguments: args });
    const [first] = result.content as Array<{ text: string }>;
    return { text: first?.text ?? "", isError: result.isError === true };
  }

  /** Resolves with the push for `messageId` once Claude Code has it. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return this.pushes.next((push) => push.meta.message_id === messageId);
  }

  /** Claude Code exits: its end of the pipe closes. */
  public async leave(): Promise<number> {
    this.toPlugin.end();
    return this.exited;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await Promise.race([this.leave(), sleep(TEARDOWN_GRACE_MS)]);
  }
}

/**
 * Claude Code's end of the plugin's stdio: a real MCP client that records every
 * channel push, shared by the in-process flow harness and the spawned live one.
 */
import type { Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ChannelPush } from "../../src/adapter";
import { CHANNEL_METHOD } from "../../src/channel";
import { RecordLog } from "../../../../packages/sdk/tests/testUtils";

export class ChannelClient {
  public readonly client: Client;
  public readonly pushes = new RecordLog<ChannelPush>();

  public constructor(
    private readonly fromPlugin: Readable,
    private readonly toPlugin: Writable,
    /** Settles once the plugin has exited, with what it exited with. */
    private readonly exited: Promise<unknown>,
    version: string,
  ) {
    this.client = new Client({ name: "claude-code", version });
    this.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === CHANNEL_METHOD) {
        this.pushes.record(notification.params as unknown as ChannelPush);
      }
    };
  }

  // The SDK's stdio transport takes any stream pair, so it also serves as the client end.
  public connect(): Promise<void> {
    return this.client.connect(new StdioServerTransport(this.fromPlugin, this.toPlugin));
  }

  /** Resolves with the push for `messageId` once Claude Code has it; rejects if the plugin exits first. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return Promise.race([
      this.pushes.next((push) => push.meta.message_id === messageId),
      this.exited.then((exit): never => {
        throw new Error(`plugin exited (${JSON.stringify(exit)}) before the push of ${messageId}`);
      }),
    ]);
  }

  /** Claude Code exits: its end of the pipe closes. */
  public leave(): void {
    this.toPlugin.end();
  }
}

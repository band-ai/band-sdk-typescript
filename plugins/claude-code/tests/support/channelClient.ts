/**
 * Claude Code's end of the plugin's stdio: a real MCP client that records every
 * channel push, shared by the in-process flow harness and the spawned live one.
 */
import type { Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { ChannelPush } from "../../src/adapter";
import { CHANNEL_METHOD } from "../../src/channel";
import { CallHolds, RecordLog, type HeldCall } from "../../../../packages/sdk/tests/testUtils";

const INITIALIZED_METHOD = "notifications/initialized";

/** A tool call's text and whether it was an error, as Claude reads it. */
export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

/** Calls `name` on the plugin's server as Claude Code would. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ text: string }>;
  return { text: first?.text ?? "", isError: result.isError === true };
}

// The SDK's stdio transport takes any stream pair, so it also serves as the client end.
class ClientEnd extends StdioServerTransport {
  public constructor(
    fromPlugin: Readable,
    toPlugin: Writable,
    private readonly outgoing: CallHolds<[JSONRPCMessage]>,
  ) {
    super(fromPlugin, toPlugin);
  }

  public override async send(message: JSONRPCMessage): Promise<void> {
    await this.outgoing.pass(message);
    await super.send(message);
  }
}

export class ChannelClient {
  public readonly client: Client;
  public readonly pushes = new RecordLog<ChannelPush>();
  private readonly outgoing = new CallHolds<[JSONRPCMessage]>();

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

  /** Completes Claude Code's handshake; rejects if the plugin exits first. */
  public connect(): Promise<void> {
    return this.unlessExited(this.client.connect(new ClientEnd(this.fromPlugin, this.toPlugin, this.outgoing)), "the handshake");
  }

  /**
   * Keeps Claude Code's `notifications/initialized` from the plugin until released: once it is
   * sending, the plugin has answered `initialize` but Claude Code has not confirmed the session.
   */
  public holdInitialized(): HeldCall<[JSONRPCMessage]> {
    return this.outgoing.hold((message) => "method" in message && message.method === INITIALIZED_METHOD);
  }

  /** Resolves with the push for `messageId` once Claude Code has it; rejects if the plugin exits first. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return this.unlessExited(this.pushes.next((push) => push.meta.message_id === messageId), `the push of ${messageId}`);
  }

  /** Claude Code exits: its end of the pipe closes. */
  public leave(): void {
    this.toPlugin.end();
  }

  private unlessExited<T>(work: Promise<T>, awaited: string): Promise<T> {
    return Promise.race([
      work,
      this.exited.then((exit): never => {
        throw new Error(`plugin exited (${JSON.stringify(exit)}) before ${awaited}`);
      }),
    ]);
  }
}

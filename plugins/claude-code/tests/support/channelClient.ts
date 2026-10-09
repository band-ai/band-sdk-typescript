/**
 * Claude Code's end of the plugin's stdio: a real MCP client that records every
 * channel push and agent question, answers each question from a queue the test
 * fills, and lists the tools on connecting as Claude Code does. Shared by the
 * in-process flow harness and the spawned live one.
 */
import type { Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ElicitRequestSchema,
  type ElicitRequestFormParams,
  type ElicitResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

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

/** A pick of the agent saved as `name`, as the user answers the question. */
export function pick(name: string): ElicitResult {
  return { action: "accept", content: { agent: name } };
}

/** The question closed, as with Esc: the same answer Claude Code gives a question it cancels. */
export const CLOSED: ElicitResult = { action: "cancel" };

export interface ChannelClientOptions {
  /** Whether the client can show a form question, as Claude Code can and `claude -p` can't; true by default. */
  readonly elicitation?: boolean;
}

export class ChannelClient {
  public readonly client: Client;
  public readonly pushes = new RecordLog<ChannelPush>();
  /** Every agent question the plugin asked, in order. */
  public readonly questions = new RecordLog<ElicitRequestFormParams>();
  private readonly answers = new RecordLog<ElicitResult>();
  /** The tool names Claude Code re-listed after each `tools/list_changed`, in order. */
  private readonly toolRelists = new RecordLog<string[]>();
  private readonly outgoing = new CallHolds<[JSONRPCMessage]>();

  public constructor(
    private readonly fromPlugin: Readable,
    private readonly toPlugin: Writable,
    /** Settles once the plugin has exited, with what it exited with. */
    private readonly exited: Promise<unknown>,
    version: string,
    { elicitation = true }: ChannelClientOptions = {},
  ) {
    this.client = new Client({ name: "claude-code", version }, {
      capabilities: elicitation ? { elicitation: { form: {} } } : {},
      // Re-lists on each change, as Claude Code does; no debounce, so each re-list follows its notification without a timer.
      listChanged: { tools: { debounceMs: 0, onChanged: (_error, tools) => this.toolRelists.record((tools ?? []).map((tool) => tool.name)) } },
    });
    this.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === CHANNEL_METHOD) {
        this.pushes.record(notification.params as unknown as ChannelPush);
      }
    };
    if (elicitation) {
      this.client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
        const index = this.questions.entries.length;
        this.questions.record(params as ElicitRequestFormParams);
        return this.answers.next(() => true, index);
      });
    }
  }

  /** Completes Claude Code's handshake and lists the tools, as Claude Code does; rejects if the plugin exits first. */
  public async connect(): Promise<void> {
    await this.unlessExited(this.client.connect(new ClientEnd(this.fromPlugin, this.toPlugin, this.outgoing)), "the handshake");
    await this.client.listTools();
  }

  /** Queues the answer to the next question still unanswered. */
  public answer(result: ElicitResult): void {
    this.answers.record(result);
  }

  /** Resolves with the next question from the `from`th on; rejects if the plugin exits first. */
  public question(from = 0): Promise<ElicitRequestFormParams> {
    return this.unlessExited(this.questions.next(() => true, from), "a question");
  }

  /** The listed tool names once they match, now or after a later re-list; rejects if the plugin exits first. */
  public async toolNamesWhen(matches: (names: readonly string[]) => boolean): Promise<string[]> {
    const seen = this.toolRelists.entries.length;
    const names = (await this.client.listTools()).tools.map((tool) => tool.name);
    return matches(names) ? names : this.unlessExited(this.toolRelists.next(matches, seen), "the tools to change");
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

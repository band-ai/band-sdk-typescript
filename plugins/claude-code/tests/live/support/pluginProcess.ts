/**
 * The built plugin as Claude Code runs it: `dist/server.js` as a child on real
 * stdio pipes, with its credentials in the env `.mcp.json` sets, and an MCP
 * client standing in for Claude Code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CHANNEL_METHOD, type ChannelPush } from "../../../src/adapter";
import type { AgentIdentity } from "../../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, releasedWithTest } from "../../../../../packages/sdk/tests/baseline/toolkit/liveRun";
import { RecordLog } from "../../../../../packages/sdk/tests/testUtils";

const SERVER = fileURLToPath(new URL("../../../dist/server.js", import.meta.url));

export interface Exit {
  readonly code: number | null;
  readonly stderr: string;
}

export class PluginProcess implements AsyncDisposable {
  public readonly client = new Client({ name: "claude-code", version: "live-test" });
  public readonly pushes = new RecordLog<ChannelPush>();
  public readonly exited: Promise<Exit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";

  private constructor(identity: AgentIdentity, wsUrl: string | undefined, restUrl: string) {
    this.child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH,
        BAND_CHANNEL_AGENT_ID: identity.id,
        BAND_CHANNEL_API_KEY: identity.apiKey,
        BAND_CHANNEL_WS_URL: wsUrl ?? "",
        BAND_CHANNEL_REST_URL: restUrl,
      },
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = once(this.child, "exit").then(([code]) => ({ code: code as number | null, stderr: this.stderr }));
    this.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === CHANNEL_METHOD) {
        this.pushes.record(notification.params as unknown as ChannelPush);
      }
    };
  }

  /** Starts the plugin as `identity` and completes Claude Code's handshake with it. */
  public static async start(identity: AgentIdentity): Promise<PluginProcess> {
    const { env } = await liveRun();
    const plugin = releasedWithTest(new PluginProcess(identity, env.wsUrl, env.restUrl));
    // The SDK's stdio transport takes any stream pair, so it also serves as the client end.
    const handshake = plugin.client.connect(new StdioServerTransport(plugin.child.stdout, plugin.child.stdin));
    const exitedFirst = plugin.exited.then(({ code, stderr }) => {
      throw new Error(`plugin exited ${code} before the handshake: ${stderr}`);
    });
    await Promise.race([handshake, exitedFirst]);
    return plugin;
  }

  /** Resolves with the push for `messageId` once Claude Code has it; rejects if the plugin exits first. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return Promise.race([
      this.pushes.next((push) => push.meta.message_id === messageId),
      this.exited.then(({ code, stderr }): never => {
        throw new Error(`plugin exited ${code} before the push of ${messageId}: ${stderr}`);
      }),
    ]);
  }

  /** Claude Code exits: its end of the pipe closes. */
  public leave(): Promise<Exit> {
    this.child.stdin.end();
    return this.exited;
  }

  /** The process dies without a clean disconnect. */
  public crash(): Promise<Exit> {
    this.child.kill("SIGKILL");
    return this.exited;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

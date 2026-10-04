/**
 * The built plugin as Claude Code runs it: `dist/server.js` as a child on real
 * stdio pipes, with exactly the env `.mcp.json` sets, and an MCP client
 * standing in for Claude Code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import type { ChannelPush } from "../../../src/adapter";
import { ChannelClient } from "../../support/channelClient";
import type { AgentIdentity } from "../../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, releasedWithTest } from "../../../../../packages/sdk/tests/baseline/toolkit/liveRun";

const SERVER = fileURLToPath(new URL("../../../dist/server.js", import.meta.url));

export interface Exit {
  readonly code: number | null;
  readonly stderr: string;
}

export class PluginProcess implements AsyncDisposable {
  public readonly exited: Promise<Exit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly channel: ChannelClient;
  private stderr = "";

  private constructor(identity: AgentIdentity, wsUrl: string | undefined) {
    this.child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH,
        BAND_CHANNEL_AGENT_ID: identity.id,
        BAND_CHANNEL_API_KEY: identity.apiKey,
        BAND_CHANNEL_WS_URL: wsUrl ?? "",
        BAND_CHANNEL_REST_URL: "",
      },
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = once(this.child, "exit").then(([code]) => ({ code: code as number | null, stderr: this.stderr }));
    this.channel = new ChannelClient(this.child.stdout, this.child.stdin, this.exited, "live-test");
  }

  /** Starts the plugin as `identity` and completes Claude Code's handshake with it. */
  public static async start(identity: AgentIdentity): Promise<PluginProcess> {
    const { env } = await liveRun();
    const plugin = releasedWithTest(new PluginProcess(identity, env.wsUrl));
    const exitedFirst = plugin.exited.then(({ code, stderr }) => {
      throw new Error(`plugin exited ${code} before the handshake: ${stderr}`);
    });
    await Promise.race([plugin.channel.connect(), exitedFirst]);
    return plugin;
  }

  public get client() {
    return this.channel.client;
  }

  /** Resolves with the push for `messageId` once Claude Code has it; rejects if the plugin exits first. */
  public pushOf(messageId: string): Promise<ChannelPush> {
    return this.channel.pushOf(messageId);
  }

  /** Claude Code exits; resolves once the plugin has. */
  public leave(): Promise<Exit> {
    this.channel.leave();
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

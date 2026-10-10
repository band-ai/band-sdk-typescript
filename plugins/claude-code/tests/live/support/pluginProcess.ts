/**
 * The built plugin as Claude Code runs it: the server `.mcp.json` declares, on
 * real stdio pipes, under a parent whose command line carries Band's channel
 * flag or not, and an MCP client standing in for Claude Code; and the
 * `/band:agents` command, as the skill runs it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { ChannelPush } from "../../../src/adapter";
import { ChannelClient } from "../../support/channelClient";
import { agentsCommandAt } from "../../support/agentsCommand";
import { liveRun, releasedWithTest } from "../../../../../packages/sdk/tests/baseline/toolkit/liveRun";

const PLUGIN_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const AGENTS_CLI = join(PLUGIN_ROOT, "dist", "agents.js");
const LAUNCHER = fileURLToPath(new URL("claudeLauncher.ts", import.meta.url));
/** How the README starts a local build with Band's channel. */
const LOCAL_CHANNEL = ["--channels", "plugin:band@inline"];

interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The plugin's one MCP server, with `${CLAUDE_PLUGIN_ROOT}` and `${user_config.*}` filled in as Claude Code does: an unset setting stays as written. */
function declaredServer(userConfig: Readonly<Record<string, string>>): McpServerConfig {
  const { mcpServers } = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const [server] = Object.values(mcpServers);
  const fill = (value: string): string =>
    value.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT).replace(/\$\{user_config\.(\w+)\}/g, (unset, key: string) => userConfig[key] ?? unset);
  return {
    command: server.command,
    args: server.args.map(fill),
    env: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, fill(value)])),
  };
}

export interface Exit {
  readonly code: number | null;
  readonly stderr: string;
}

export class PluginProcess implements AsyncDisposable {
  public readonly exited: Promise<Exit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly channel: ChannelClient;
  private stderr = "";

  private constructor(wsUrl: string | undefined, sessionEnv: Readonly<Record<string, string>>, channel: boolean) {
    const server = declaredServer(wsUrl ? { ws_url: wsUrl } : {});
    const launch = [LAUNCHER, ...(channel ? LOCAL_CHANNEL : []), "--", server.command, ...server.args];
    this.child = spawn(process.execPath, launch, { env: { PATH: process.env.PATH, ...server.env, ...sessionEnv } });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = once(this.child, "exit").then(([code]) => ({ code: code as number | null, stderr: this.stderr }));
    this.channel = new ChannelClient(this.child.stdout, this.child.stdin, this.exited, "live-test");
  }

  /**
   * Starts the plugin, set to the live run's Band, with Band's channel unless `channel` is false, queues
   * `answers` to the agent question, and completes Claude Code's handshake with it; `sessionEnv` is what the
   * session gives the server: its data directory and the agent `BAND_AGENT` names, if any.
   */
  public static async start(
    sessionEnv: Readonly<Record<string, string>>,
    { channel = true, answers = [] }: { channel?: boolean; answers?: readonly ElicitResult[] } = {},
  ): Promise<PluginProcess> {
    const { env } = await liveRun();
    const plugin = releasedWithTest(new PluginProcess(env.wsUrl, sessionEnv, channel));
    answers.forEach((answer) => plugin.channel.answer(answer));
    await plugin.channel.connect();
    return plugin;
  }

  public get client() {
    return this.channel.client;
  }

  /** Resolves with the Band tools once they are listed. */
  public connected(): Promise<string[]> {
    return this.channel.connected();
  }

  /** See {@link ChannelClient.toolNamesWhen}. */
  public toolNamesWhen(matches: (names: readonly string[]) => boolean): Promise<string[]> {
    return this.channel.toolNamesWhen(matches);
  }

  public resourcesWhen(matches: Parameters<ChannelClient["resourcesWhen"]>[0]) {
    return this.channel.resourcesWhen(matches);
  }

  /** Queues the user's answer to the next agent question. */
  public answer(result: ElicitResult): void {
    this.channel.answer(result);
  }

  /** Resolves with the next agent question from the `from`th on. */
  public question(from?: number): Promise<ElicitRequestFormParams> {
    return this.channel.question(from);
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

  /** Claude Code stops the server as it does on exit, with SIGINT first; resolves once the plugin has exited. */
  public interrupt(): Promise<Exit> {
    this.child.kill("SIGINT");
    return this.exited;
  }

  /** Claude Code goes, and its end of the pipes with it, so the server exits however the test left it. */
  public async [Symbol.asyncDispose](): Promise<void> {
    this.channel.leave();
    await this.exited;
  }
}

/** Runs the built `/band:agents` command; resolves with what it printed, rejecting when it fails. */
export async function agentsCommand(...args: string[]): Promise<string> {
  return agentsCommandAt(AGENTS_CLI, args);
}

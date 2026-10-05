/**
 * The built plugin as Claude Code runs it: the server `.mcp.json` declares, as a
 * child on real stdio pipes, and an MCP client standing in for Claude Code; and
 * the `/band:agents` command, as the skill runs it.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ChannelPush } from "../../../src/adapter";
import { ChannelClient } from "../../support/channelClient";
import type { AgentIdentity } from "../../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, releasedWithTest } from "../../../../../packages/sdk/tests/baseline/toolkit/liveRun";

const PLUGIN_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const AGENTS_CLI = join(PLUGIN_ROOT, "dist", "agents.js");

interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The plugin's one MCP server, with `${CLAUDE_PLUGIN_ROOT}` and `${user_config.*}` filled in as Claude Code does. */
function declaredServer(userConfig: Readonly<Record<string, string>>): McpServerConfig {
  const { mcpServers } = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const [server] = Object.values(mcpServers);
  const fill = (value: string): string =>
    value.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT).replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => userConfig[key] ?? "");
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

  private constructor(identity: AgentIdentity, wsUrl: string | undefined, sessionEnv: Readonly<Record<string, string>>) {
    const server = declaredServer({ agent_id: identity.id, api_key: identity.apiKey, ws_url: wsUrl ?? "" });
    this.child = spawn(server.command, server.args, { env: { PATH: process.env.PATH, ...server.env, ...sessionEnv } });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = once(this.child, "exit").then(([code]) => ({ code: code as number | null, stderr: this.stderr }));
    this.channel = new ChannelClient(this.child.stdout, this.child.stdin, this.exited, "live-test");
  }

  /**
   * Starts the plugin configured as `identity` and completes Claude Code's handshake with it;
   * `sessionEnv` is what else the session gives the server, such as the agent `BAND_AGENT` selects.
   */
  public static async start(identity: AgentIdentity, sessionEnv: Readonly<Record<string, string>> = {}): Promise<PluginProcess> {
    const { env } = await liveRun();
    const plugin = releasedWithTest(new PluginProcess(identity, env.wsUrl, sessionEnv));
    await plugin.channel.connect();
    return plugin;
  }

  /** Starts a plugin that fails before Claude Code's handshake, and resolves with how it exited. */
  public static async exitOf(identity: AgentIdentity, sessionEnv: Readonly<Record<string, string>>): Promise<Exit> {
    const { env } = await liveRun();
    return releasedWithTest(new PluginProcess(identity, env.wsUrl, sessionEnv)).exited;
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

  public async [Symbol.asyncDispose](): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

/** Runs the built `/band:agents` command; resolves with what it printed, rejecting when it fails. */
export async function agentsCommand(...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [AGENTS_CLI, ...args]);
  return stdout;
}

import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { BandLink } from "../src/platform/BandLink";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

const ROOM = "room-1";
const BOARD_TOOLS = ["band_get_board", "band_set_board"];

/**
 * An ACP agent that, on each prompt, connects to the Band MCP server the
 * adapter offered its session and runs `script` against it.
 */
function boardAgent(script: (band: McpClient) => Promise<void>) {
  let access: { url: string; authorization: string } | undefined;
  return inMemoryAgent((peer): AcpAgent => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }),
    authenticate: async () => ({}),
    newSession: async ({ mcpServers }) => {
      const band = mcpServers.find((server) => "url" in server);
      const authorization = band && "headers" in band ? band.headers.find((header) => header.name === "Authorization")?.value : undefined;
      access = band && authorization ? { url: band.url, authorization } : undefined;
      return { sessionId: "session-1" };
    },
    cancel: async () => {},
    prompt: async ({ sessionId }) => {
      if (!access) throw new Error("The session was offered no Band MCP server");
      const transport = new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { authorization: access.authorization } } });
      const band = new McpClient({ name: "board-agent", version: "1.0.0" });
      await band.connect(transport);
      try {
        await script(band);
      } finally {
        await transport.close();
      }
      await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    },
  }));
}

async function runTurn(enableTaskTools: boolean | undefined, script: (band: McpClient) => Promise<void>) {
  const adapter = new ACPClientAdapter({
    command: ["acp-fixture"],
    cwd: tmpRoot(),
    connectionFactory: boardAgent(script),
    ...(enableTaskTools === undefined ? {} : { enableTaskTools }),
  });
  // Band grants the board to an agent whose host asks for `tasks` and whose tenant has `ff_room_tasks`.
  const platform = BandPlatform.host([person("owner")], { featureFlags: { ff_room_tasks: true } });
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, capabilities: { tasks: true }, ...platform.link }),
  });
  await runtime.start(adapter);
  onTestFinished(async () => { await runtime.stop(); });
  const room = await platform.room(ROOM);
  expect(await room.outcome(await room.say("owner", "set the room's goal"))).toBe("processed");
  return platform.rest;
}

describe("board tools through an ACP adapter's Band MCP server", () => {
  it("are not offered by default", async () => {
    let names: string[] = [];
    await runTurn(undefined, async (band) => { names = (await band.listTools()).tools.map((tool) => tool.name); });
    expect(names).toContain("band_send_message");
    expect(names.filter((name) => BOARD_TOOLS.includes(name))).toEqual([]);
  });

  it("are offered with enableTaskTools and reach the room's board", async () => {
    let names: string[] = [];
    let written: unknown;
    let read: unknown;
    const rest = await runTurn(true, async (band) => {
      names = (await band.listTools()).tools.map((tool) => tool.name);
      written = await band.callTool({ name: "band_set_board", arguments: { goal_title: "Ship the board" } });
      read = await band.callTool({ name: "band_get_board", arguments: {} });
    });

    expect(names).toEqual(expect.arrayContaining(BOARD_TOOLS));
    expect(rest.boardCalls.entries).toEqual([
      { roomId: ROOM, call: "putChatBoard", args: { goal_title: "Ship the board" } },
      { roomId: ROOM, call: "getChatBoard", args: {} },
    ]);
    expect(written).not.toMatchObject({ isError: true });
    expect(read).not.toMatchObject({ isError: true });
    expect(read).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("\"goal_title\":\"Ship the board\"") }] });
  });
});

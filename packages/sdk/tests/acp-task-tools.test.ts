import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { BandLink } from "../src/platform/BandLink";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { bandMcpAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

const ROOM = "room-1";
const BOARD_TOOLS = ["band_get_board", "band_set_board"];

async function runTurn(enableTaskTools: boolean | undefined, script: (band: McpClient) => Promise<void>) {
  const adapter = new ACPClientAdapter({
    command: ["acp-fixture"],
    cwd: tmpRoot(),
    connectionFactory: bandMcpAgent(script),
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

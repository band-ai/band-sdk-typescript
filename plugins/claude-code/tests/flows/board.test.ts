import { describe, expect, it } from "vitest";
import { BOARD_TOOL } from "../../src/board";
import { CONNECT_TOOL, TOOL } from "../../src/tools";
import { AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { WS_URL_ENV } from "../../src/config";
import { pick } from "../support/channelClient";
import { ClaudeCodeSession, linkTo, AGENT_NAME } from "./support/claudeCode";

const ROOM = "room-board";
const BASE = Object.values(TOOL).sort();
const WITH_BOARD = [...BASE, ...Object.keys(BOARD_TOOL)].sort();

describe("the room board over the plugin's real MCP", () => {
  it.each<Readonly<Record<string, boolean>> | undefined>([undefined, {}, { ff_room_tasks: false }, { ff_room_tasks: true }])("lists board tools only when the connected organization enables them (%j)", async (featureFlags) => {
    const platform = BandPlatform.host([], { featureFlags });
    await platform.room(ROOM);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    const tools = await session.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(featureFlags?.ff_room_tasks ? WITH_BOARD : BASE);
    expect(tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"]).map((tool) => tool.name).sort()).toEqual([TOOL.reply, TOOL.send]);
  });

  it("returns Band's objects and resolves #N to its task through the SDK", async () => {
    const platform = BandPlatform.host([], { featureFlags: { ff_room_tasks: true } });
    await platform.room(ROOM);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    const created = await session.callTool("create_task", { room_id: ROOM, subject: "Review source" });
    expect(created.isError, created.text).toBe(false);
    const task = JSON.parse(created.text);
    expect(task).toMatchObject({ number: 1, subject: "Review source", assignments: [] });
    const found = await session.callTool("get_task", { room_id: ROOM, id: `#${task.number}` });
    expect(found).toEqual(created);
    expect(platform.rest.boardCalls.entries.at(-1)).toMatchObject({ roomId: ROOM, call: "getChatTask", id: "1" });
    const refused = await session.callTool("get_board", { room_id: "not-admitted" });
    expect(refused).toEqual({ isError: true, text: "Band refused it (404): Resource not found" });
  });

  it("removes all fourteen tools on disconnect and rereads the flag at reconnect", async () => {
    await using peer = await FakePhoenixPeer.start();
    const featureFlags = { ff_room_tasks: true };
    const platform = BandPlatform.host([person("user-1")], { featureFlags });
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect("user-1", `@[[${AGENT_ID}]] hello`);
    await using session = await ClaudeCodeSession.connect(() => ({ restApi: platform.rest }), { env: { [WS_URL_ENV]: peer.url } });
    await session.pushOf(waiting);
    expect((await session.toolNames()).sort()).toEqual(WITH_BOARD);
    await peer.endConnections(AGENT_ID, "agent.revoked", "Reconnect to continue");
    expect(await session.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
    featureFlags.ff_room_tasks = false;
    session.answer(pick(AGENT_NAME));
    const connected = await session.callTool(CONNECT_TOOL, {});
    expect(connected.isError, connected.text).toBe(false);
    expect((await session.toolNames()).sort()).toEqual(BASE);
  });
});

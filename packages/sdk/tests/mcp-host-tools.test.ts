import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import type { McpToolRegistration } from "../src/mcp/registrations";
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { FakeTools, tmpRoot } from "./testUtils";

const ROOM = "room-1";
const OTHER_ROOM = "room-2";

/** A host's own tool that acts on the room its call names, through the tools it is handed. */
const markRoom: McpToolRegistration = {
  name: "mark_room",
  description: "Leave a marker event in this room.",
  inputSchema: { type: "object", properties: { room_id: { type: "string" }, marker: { type: "string" } }, required: ["room_id", "marker"] },
  execute: async (args, tools) => {
    await tools!.sendEvent(`marker: ${String(args.marker)}`, "thought");
    return { content: [{ type: "text", text: "marked" }] };
  },
};

/** The same kind of tool without `room_id`: on a multi-room server it cannot say which room it means. */
const markUnnamedRoom: McpToolRegistration = {
  ...markRoom,
  name: "mark_unnamed_room",
  inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
};

const textOf = (result: unknown): string => {
  const content = result && typeof result === "object" && "content" in result && Array.isArray(result.content) ? result.content : [];
  const [block] = content;
  return block?.type === "text" ? String(block.text) : "";
};
const isError = (result: unknown): boolean => Boolean(result && typeof result === "object" && "isError" in result && result.isError);

async function bridgeClient(additionalTools: McpToolRegistration[], rooms: Record<string, FakeTools>) {
  const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: (roomId) => rooms[roomId], additionalTools });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await bridge.serverConfig.instance.connect(serverTransport);
  const client = new McpClient({ name: "host-tool-probe", version: "1.0.0" });
  await client.connect(clientTransport);
  onTestFinished(() => client.close());
  return client;
}

describe("a host's MCP tool gets the room's tools on every server", () => {
  it("on a room-scoped server, such as the Claude Agent SDK bridge, for the room each call names", async () => {
    const rooms = { [ROOM]: new FakeTools(), [OTHER_ROOM]: new FakeTools() };
    const client = await bridgeClient([markRoom], rooms);

    const results = [
      await client.callTool({ name: "mark_room", arguments: { room_id: ROOM, marker: "first" } }),
      await client.callTool({ name: "mark_room", arguments: { room_id: OTHER_ROOM, marker: "second" } }),
    ];

    expect(results.map(isError)).toEqual([false, false]);
    expect(rooms[ROOM].events.map((event) => event.content)).toEqual(["marker: first"]);
    expect(rooms[OTHER_ROOM].events.map((event) => event.content)).toEqual(["marker: second"]);
  });

  it("advertises a declared room_id as required on a room-scoped server", async () => {
    const optionalRoom: McpToolRegistration = { ...markRoom, inputSchema: { ...markRoom.inputSchema, required: ["marker"] } };
    const client = await bridgeClient([optionalRoom], { [ROOM]: new FakeTools() });

    const { tools } = await client.listTools();

    expect(tools.find((tool) => tool.name === "mark_room")?.inputSchema.required).toContain("room_id");
  });

  it("on a single-room server, such as an ACP room's own", async () => {
    let result: unknown;
    let access: { url: string; authorization: string } | undefined;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      additionalMcpTools: [markRoom],
      connectionFactory: inMemoryAgent((peer): AcpAgent => ({
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
          const transport = new StreamableHTTPClientTransport(new URL(access!.url), { requestInit: { headers: { authorization: access!.authorization } } });
          const band = new McpClient({ name: "acp-agent", version: "1.0.0" });
          await band.connect(transport);
          try {
            result = await band.callTool({ name: "mark_room", arguments: { room_id: ROOM, marker: "acp" } });
          } finally {
            await transport.close();
          }
          await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
          return { stopReason: "end_turn" };
        },
      })),
    });
    const platform = await BandPlatform.start(adapter, [person("owner")]);
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room(ROOM);

    expect(await room.outcome(await room.say("owner", "mark it"))).toBe("processed");
    expect(isError(result)).toBe(false);
    expect(room.events("thought").map((event) => event.content)).toContain("marker: acp");
  });

  it.each([
    { call: "names an empty room", args: { room_id: " ", marker: "lost" }, error: "Missing required room_id" },
    { call: "names an unknown room", args: { room_id: "room-9", marker: "lost" }, error: "No tool context found for room_id room-9" },
  ])("refuses a call that $call, without running the tool", async ({ args, error }) => {
    const roomTools = new FakeTools();
    const client = await bridgeClient([markRoom], { [ROOM]: roomTools });

    const result = await client.callTool({ name: "mark_room", arguments: args });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain(error);
    expect(roomTools.events).toEqual([]);
  });

  it("runs a tool that declares no room_id and only passes its tools along", async () => {
    const passAlong: McpToolRegistration = {
      name: "pass_along",
      description: "Hand the tools to an async helper that never uses them.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async (_args, tools) => {
        await Promise.resolve(tools);
        return { content: [{ type: "text", text: "passed" }] };
      },
    };
    const client = await bridgeClient([passAlong], { [ROOM]: new FakeTools() });

    const result = await client.callTool({ name: "pass_along", arguments: {} });

    expect(textOf(result)).toBe("passed");
  });

  it("fails loudly when a tool that declares no room_id uses room tools on a room-scoped server", async () => {
    const roomTools = new FakeTools();
    const client = await bridgeClient([markUnnamedRoom], { [ROOM]: roomTools });

    const result = await client.callTool({ name: "mark_unnamed_room", arguments: { marker: "lost" } });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("declare room_id");
    expect(roomTools.events).toEqual([]);
  });
});

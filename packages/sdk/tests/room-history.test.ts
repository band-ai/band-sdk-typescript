import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import type { PaginatedResponse, PlatformChatMessage } from "../src/client/rest/types";
import type { PlatformMessageLike, RoomHistoryPage } from "../src/contracts/protocols";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";
import type { McpToolRegistration } from "../src/mcp/registrations";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { FakeRestApi, tmpRoot } from "./testUtils";

const ROOM = "room-1";

const chatMessage = (index: number): PlatformChatMessage => ({
  id: `m${index}`,
  content: `message ${index}`,
  sender_id: "owner",
  sender_type: "User",
  sender_name: "owner",
  message_type: "text",
  metadata: {},
  inserted_at: new Date(Date.UTC(2026, 10, 9, 12, index)).toISOString(),
});

/** Band's agent message list on `status=all&sort_order=desc`: keyset pages, newest first. */
class HistoryRestApi extends FakeRestApi {
  public readonly requests: Array<{ chatId: string; cursor?: string; limit: number }> = [];

  public constructor(private readonly oldestFirst: PlatformChatMessage[]) {
    super();
  }

  public async listRoomHistory(request: { chatId: string; cursor?: string; limit: number }): Promise<PaginatedResponse<PlatformChatMessage>> {
    this.requests.push(request);
    const newestFirst = [...this.oldestFirst].reverse();
    const start = request.cursor === undefined ? 0 : newestFirst.findIndex((message) => message.id === request.cursor) + 1;
    const data = newestFirst.slice(start, start + request.limit);
    const hasMore = start + request.limit < newestFirst.length;
    return { data, metadata: { has_more: hasMore, ...(hasMore ? { next_cursor: data.at(-1)!.id } : {}) } };
  }
}

const ids = (page: RoomHistoryPage) => page.messages.map((message) => message.id);

const inbound = (index: number): PlatformMessageLike => ({
  id: `m${index}`,
  roomId: ROOM,
  content: `message ${index}`,
  senderId: "owner",
  senderType: "User",
  senderName: "owner",
  messageType: "text",
  metadata: {},
  createdAt: new Date(Date.UTC(2026, 10, 9, 12, index)),
});

describe("AgentTools.readRoomHistory", () => {
  const seven = Array.from({ length: 7 }, (_, index) => chatMessage(index + 1));

  it("walks the room newest first, with no message repeated or skipped", async () => {
    const rest = new HistoryRestApi(seven);
    const tools = new AgentTools({ roomId: ROOM, rest });
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await tools.readRoomHistory({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(walked).toEqual(["m7", "m6", "m5", "m4", "m3", "m2", "m1"]);
    expect(rest.requests).toEqual([
      { chatId: ROOM, limit: 3 },
      { chatId: ROOM, cursor: "m5", limit: 3 },
      { chatId: ROOM, cursor: "m2", limit: 3 },
    ]);
  });

  it("puts the pinned message first on every page, and only once", async () => {
    const tools = new AgentTools({ roomId: ROOM, rest: new HistoryRestApi(seven) });
    const pinned = inbound(6);

    const first = await tools.readRoomHistory({ limit: 3, pinned });
    expect(ids(first), "the page that holds it moves it first").toEqual(["m6", "m7", "m5"]);
    const second = await tools.readRoomHistory({ limit: 3, cursor: first.nextCursor!, pinned });
    expect(ids(second), "a page that would not hold it still leads with it").toEqual(["m6", "m4", "m3", "m2"]);
    expect(second.messages[0]).toMatchObject({ id: "m6", content: "message 6", senderId: "owner" });
  });

  it("reads 20 messages a page by default and refuses a page size Band would not serve", async () => {
    const rest = new HistoryRestApi(seven);
    const tools = new AgentTools({ roomId: ROOM, rest });
    await tools.readRoomHistory();
    expect(rest.requests).toEqual([{ chatId: ROOM, limit: 20 }]);
    for (const limit of [0, 101, 2.5]) {
      await expect(tools.readRoomHistory({ limit })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(rest.requests).toHaveLength(1);
  });

  it("throws, rather than returning an empty page, when the REST client cannot list history", async () => {
    const tools = new AgentTools({ roomId: ROOM, rest: new FakeRestApi() });
    await expect(tools.readRoomHistory()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});

describe("FernRestAdapter.listRoomHistory", () => {
  it("asks Band's agent message list for every status, newest first, one cursor page", async () => {
    const listAgentMessages = vi.fn(async () => ({ data: [chatMessage(2), chatMessage(1)], metadata: { has_more: true, next_cursor: "opaque" } }));
    const adapter = new FernRestAdapter({ agentApiMessages: { listAgentMessages } });

    const page = await adapter.listRoomHistory({ chatId: ROOM, cursor: "earlier", limit: 2 });

    expect(listAgentMessages).toHaveBeenCalledWith(ROOM, { status: "all", sort_order: "desc", cursor: "earlier", limit: 2 }, expect.any(Object));
    expect(page.data.map((message) => message.id)).toEqual(["m2", "m1"]);
    expect(page.metadata).toMatchObject({ has_more: true, next_cursor: "opaque" });
  });

  it("throws when the client has no agent message list", async () => {
    await expect(new FernRestAdapter({}).listRoomHistory({ chatId: ROOM, limit: 2 })).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});

describe("room history in a turn", () => {
  it("pins the turn's own inbound message, whichever page the turn reads", async () => {
    const pages: RoomHistoryPage[] = [];
    const platform = await BandPlatform.start(new GenericAdapter(async ({ tools }) => {
      const first = await tools.readRoomHistory!({ limit: 1 });
      pages.push(first, await tools.readRoomHistory!({ limit: 1, cursor: first.nextCursor! }));
      tools.turn.settle();
    }), [person("owner")]);
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room(ROOM);
    platform.rest.remember(ROOM, chatMessage(1));

    const message = await room.say("owner", "what did I say before?");
    expect(await room.outcome(message)).toBe("processed");
    expect(pages.map(ids)).toEqual([[message], [message, "m1"]]);
  });

  it("serves a host's own MCP tool from the room's history through an ACP backend", async () => {
    let listed: string[] = [];
    let readText = "";
    const readRoom: McpToolRegistration = {
      name: "read_room",
      description: "Read the room's history, newest first.",
      inputSchema: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" } }, required: [] },
      execute: async (args, tools) => {
        const page = await tools!.readRoomHistory!(args);
        return { content: [{ type: "text", text: JSON.stringify(page) }] };
      },
    };
    let access: { url: string; authorization: string } | undefined;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      additionalMcpTools: [readRoom],
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
          const band = new McpClient({ name: "history-agent", version: "1.0.0" });
          await band.connect(transport);
          try {
            listed = (await band.listTools()).tools.map((tool) => tool.name);
            const result = await band.callTool({ name: "read_room", arguments: { limit: 5 } });
            const [block] = Array.isArray(result.content) ? result.content : [];
            readText = block?.type === "text" ? block.text : "";
          } finally {
            await transport.close();
          }
          await peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read it" } } });
          return { stopReason: "end_turn" };
        },
      })),
    });
    const platform = await BandPlatform.start(adapter, [person("owner")]);
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room(ROOM);

    const message = await room.say("owner", "summarize the room");
    expect(await room.outcome(message)).toBe("processed");
    expect(listed).toContain("read_room");
    expect(platform.rest.historyRequests.entries).toEqual([{ chatId: ROOM, limit: 5 }]);
    const page: unknown = JSON.parse(readText);
    expect(page).toHaveProperty(["messages", 0, "id"], message);
    expect(page).toHaveProperty(["messages", 0, "content"], "summarize the room");
  });
});

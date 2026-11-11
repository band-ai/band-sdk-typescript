import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { RestFacade } from "../src/client/rest/RestFacade";
import { DEFAULT_CONTEXT_PAGE, MAX_CURSOR_PAGE, fetchContextPage, fetchCursorTail, type CursorPageRequest } from "../src/client/rest/pagination";
import type { PaginatedResponse, PaginationMetadata, PlatformChatMessage } from "../src/client/rest/types";
import type { RoomContextPage } from "../src/contracts/protocols";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";
import type { McpToolRegistration } from "../src/mcp/registrations";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { bandMcpAgent } from "./support/inMemoryAcpAgent";
import { buildFakeRestAdapter } from "./support/fakeRestAdapter";
import { FakeRestApi, tmpRoot } from "./testUtils";

const ROOM = "room-1";

const record = (id: string, fields: Partial<PlatformChatMessage> = {}): PlatformChatMessage => ({
  id,
  content: `said ${id}`,
  sender_id: "owner",
  sender_type: "User",
  sender_name: "owner",
  message_type: "text",
  metadata: {},
  inserted_at: "2026-11-09T12:00:00.000Z",
  ...fields,
});

/** A context endpoint that serves one page with `metadata` and records each request. */
class OnePageContextApi extends FakeRestApi {
  public readonly requests: Array<{ chatId: string } & Partial<CursorPageRequest>> = [];

  public constructor(private readonly metadata?: PaginationMetadata) {
    super();
  }

  public async getChatContext(request: { chatId: string } & Partial<CursorPageRequest>): Promise<PaginatedResponse<PlatformChatMessage>> {
    this.requests.push(request);
    return { data: [record("m1")], ...(this.metadata ? { metadata: this.metadata } : {}) };
  }
}

const ids = (page: RoomContextPage) => page.messages.map((message) => message.id);

describe("AgentTools.fetchRoomContext over Band's agent context endpoint", () => {
  it("asks for one cursor page of the room's context and hands back the next cursor", async () => {
    const mention = { id: AGENT_ID, handle: "agent", name: "Agent" };
    const { rest, calls } = buildFakeRestAdapter([{
      status: 200,
      body: {
        data: [
          record("m1", { content: `@[[${AGENT_ID}]] look`, metadata: { mentions: [mention] } }),
          record("m2", { sender_id: AGENT_ID, sender_type: "Agent", message_type: "thought", content: "looking" }),
        ],
        metadata: { has_more: true, next_cursor: "c2" },
      },
    }]);

    const page = await new AgentTools({ roomId: ROOM, rest }).fetchRoomContext({ cursor: "c1", limit: 2 });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/api/v1/agent/chats/${ROOM}/context`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ cursor: "c1", limit: "2" });
    expect(page.nextCursor).toBe("c2");
    expect(page.messages).toMatchObject([
      { id: "m1", roomId: ROOM, content: "@agent look", senderId: "owner" },
      { id: "m2", messageType: "thought", senderId: AGENT_ID },
    ]);
  });

  it(`reads ${DEFAULT_CONTEXT_PAGE} messages by default, and from 1 to ${MAX_CURSOR_PAGE} on request`, async () => {
    const rest = new OnePageContextApi();
    const tools = new AgentTools({ roomId: ROOM, rest });

    for (const limit of [0, MAX_CURSOR_PAGE + 1, 2.5]) {
      await expect(tools.fetchRoomContext({ limit })).rejects.toBeInstanceOf(ValidationError);
    }
    await tools.fetchRoomContext();
    await tools.fetchRoomContext({ limit: 1 });
    await tools.fetchRoomContext({ limit: MAX_CURSOR_PAGE });

    expect(rest.requests.map(({ limit }) => limit)).toEqual([DEFAULT_CONTEXT_PAGE, 1, MAX_CURSOR_PAGE]);
  });

  it("throws, rather than returning an empty page, when the REST client has no context endpoint", async () => {
    await expect(new AgentTools({ roomId: ROOM, rest: new FakeRestApi() }).fetchRoomContext()).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(fetchContextPage(new RestFacade({ api: new FakeRestApi() }), ROOM)).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("reads through a RestFacade to the API it wraps", async () => {
    const api = new OnePageContextApi({ has_more: true, next_cursor: "c2" });

    const page = await fetchContextPage(new RestFacade({ api }), ROOM, { cursor: "c1", limit: 3 });

    expect(api.requests).toEqual([{ chatId: ROOM, cursor: "c1", limit: 3 }]);
    expect(page).toEqual({ messages: [record("m1")], nextCursor: "c2" });
  });
});

describe("where a context page ends", () => {
  it.each([
    { name: "no more after a cursor", metadata: { has_more: false, next_cursor: "c2" }, next: null, truncated: false },
    { name: "no metadata", metadata: undefined, next: null, truncated: false },
    { name: "more and a cursor", metadata: { has_more: true, next_cursor: "c2" }, next: "c2", truncated: false },
  ])("$name: the page reader and the tail walk agree", async ({ metadata, next, truncated }) => {
    const page = await fetchContextPage(new OnePageContextApi(metadata), ROOM);
    expect(page.nextCursor).toBe(next);

    const cursors: Array<string | undefined> = [];
    const tail = await fetchCursorTail(async ({ cursor }) => {
      cursors.push(cursor);
      return cursors.length === 1 ? { data: [], ...(metadata ? { metadata } : {}) } : { data: [], metadata: { has_more: false } };
    }, { keep: 1 });
    expect(cursors, "the walk follows exactly the cursor the page reader hands back").toEqual(next === null ? [undefined] : [undefined, next]);
    expect(tail.truncated).toBe(truncated);
  });

  it("refuses a page that has more but no cursor, which the tail walk reports as truncated", async () => {
    const metadata = { has_more: true, next_cursor: "" };
    await expect(fetchContextPage(new OnePageContextApi(metadata), ROOM)).rejects.toBeInstanceOf(ValidationError);

    const tail = await fetchCursorTail(async () => ({ data: [], metadata }), { keep: 1 });
    expect(tail.truncated).toBe(true);
  });
});

describe("room context in an ACP room", () => {
  it("serves a host's own MCP tool the room's context, page by page, oldest first", async () => {
    const pages: RoomContextPage[] = [];
    const readContext: McpToolRegistration = {
      name: "read_room_context",
      description: "Read this room's messages that you sent or that mention you, oldest first.",
      inputSchema: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" } }, required: [] },
      execute: async (args, tools) => {
        if (!tools?.fetchRoomContext) {
          throw new UnsupportedFeatureError("Room context needs a single-room server");
        }
        return { content: [{ type: "text", text: JSON.stringify(await tools.fetchRoomContext(args)) }] };
      },
    };
    const callReadContext = async (band: McpClient, args: Record<string, unknown>): Promise<RoomContextPage> => {
      const result = await band.callTool({ name: "read_room_context", arguments: args });
      const [block] = Array.isArray(result.content) ? result.content : [];
      return JSON.parse(block?.type === "text" ? block.text : "null") as RoomContextPage;
    };
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      additionalMcpTools: [readContext],
      connectionFactory: bandMcpAgent(async (band) => {
        const first = await callReadContext(band, { limit: 2 });
        pages.push(first, await callReadContext(band, { limit: 2, cursor: first.nextCursor }));
      }),
    });
    const platform = await BandPlatform.start(adapter, [person("owner")]);
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room(ROOM);
    const mention = { id: AGENT_ID, handle: "agent", name: "Agent" };
    platform.rest.remember(ROOM, record("asked", { content: `@[[${AGENT_ID}]] what changed?`, metadata: { mentions: [mention] } }));
    platform.rest.remember(ROOM, record("thought", { sender_id: AGENT_ID, sender_type: "Agent", message_type: "thought", content: "checking" }));

    const message = await room.say("owner", "summarize the room");
    expect(await room.outcome(message)).toBe("processed");

    expect(pages.map(ids)).toEqual([["asked", "thought"], [message]]);
    expect(pages.map((page) => page.nextCursor)).toEqual(["2", null]);
    expect(pages[0]!.messages[0]).toMatchObject({ senderId: "owner", content: "@agent what changed?" });
    expect(pages[0]!.messages[1]).toMatchObject({ senderId: AGENT_ID, messageType: "thought", content: "checking" });
    expect(pages[1]!.messages[0]).toMatchObject({ senderId: "owner", content: "summarize the room" });
  });
});

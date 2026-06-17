import { describe, expect, it, vi } from "vitest";

import type { AgentToolsProtocol } from "../src/core";
import { createThenvoiSdkMcpServer } from "../src/mcp/sdk";
import { FakeRestApi } from "./testUtils";

describe("createThenvoiSdkMcpServer", () => {
  function makeTools(calls: Array<{ name: string; args: Record<string, unknown> }>): AgentToolsProtocol {
    return {
      capabilities: { peers: false, contacts: false, memory: false },
      sendMessage: async () => ({ ok: true }),
      sendEvent: async () => ({ ok: true }),
      addParticipant: async () => ({ ok: true }),
      removeParticipant: async () => ({ ok: true }),
      getParticipants: async () => [],
      lookupPeers: async () => ({ data: [] }),
      createChatroom: async () => "room-x",
      getToolSchemas: () => [],
      getAnthropicToolSchemas: () => [],
      getOpenAIToolSchemas: () => [],
      listContacts: async () => ({ data: [] }),
      addContact: async () => ({ ok: true }),
      removeContact: async () => ({ ok: true }),
      listContactRequests: async () => ({ received: [], sent: [] }),
      respondContactRequest: async () => ({ ok: true }),
      listMemories: async () => ({ data: [] }),
      storeMemory: async () => ({ id: "mem-1" }),
      getMemory: async () => ({ id: "mem-1" }),
      supersedeMemory: async () => ({ ok: true }),
      archiveMemory: async () => ({ ok: true }),
      executeToolCall: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { ok: true };
      },
    };
  }

  it("builds thenvoi MCP tools and routes calls to room-scoped tool execution", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const roomTools = makeTools(calls);

    const bridge = createThenvoiSdkMcpServer({
      enableMemoryTools: false,
      getToolsForRoom: (roomId: string) => (roomId === "room-1" ? roomTools : undefined),
    });

    expect(bridge.allowedTools.some((name) => name === "mcp__thenvoi__thenvoi_send_message")).toBe(true);

    const sendMessageTool = bridge.toolDefinitions.find((entry) => entry.name === "thenvoi_send_message");
    expect(sendMessageTool).toBeDefined();
    if (!sendMessageTool) {
      throw new Error("thenvoi_send_message tool definition missing");
    }

    const result = await sendMessageTool.handler({
      room_id: "room-1",
      content: "hello",
      mentions: ["@a"],
    }, {});

    expect(calls).toEqual([
      {
        name: "thenvoi_send_message",
        args: {
          content: "hello",
          mentions: ["@a"],
        },
      },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("builds room-aware system prompt context and caches it", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let participantCalls = 0;
    const listChats = vi.fn(async () => ({
      data: [{ id: "room-1", title: "Project Discussion" }],
      metadata: { totalPages: 1 },
    }));
    const roomTools: AgentToolsProtocol & { rest: FakeRestApi } = {
      ...{
        capabilities: { peers: false, contacts: false, memory: false },
        sendMessage: async () => ({ ok: true }),
        sendEvent: async () => ({ ok: true }),
        addParticipant: async () => ({ ok: true }),
        removeParticipant: async () => ({ ok: true }),
        getParticipants: async () => {
          participantCalls += 1;
          return [
            { id: "user-1", name: "Vlad Luzin", type: "User", handle: "@vlad" },
            { id: "agent-1", name: "Andy", type: "Agent", handle: "@vlad/andy" },
          ];
        },
        lookupPeers: async () => ({ data: [] }),
        createChatroom: async () => "room-x",
        getToolSchemas: () => [],
        getAnthropicToolSchemas: () => [],
        getOpenAIToolSchemas: () => [],
        listContacts: async () => ({ data: [] }),
        addContact: async () => ({ ok: true }),
        removeContact: async () => ({ ok: true }),
        listContactRequests: async () => ({ received: [], sent: [] }),
        respondContactRequest: async () => ({ ok: true }),
        listMemories: async () => ({ data: [] }),
        storeMemory: async () => ({ id: "mem-1" }),
        getMemory: async () => ({ id: "mem-1" }),
        supersedeMemory: async () => ({ ok: true }),
        archiveMemory: async () => ({ ok: true }),
        executeToolCall: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return { ok: true };
        },
      },
      rest: new FakeRestApi({
        listChats,
      }, {
        id: "agent-1",
        name: "Andy",
        handle: "@vlad/andy",
        description: "Helper",
      }),
    };

    const bridge = createThenvoiSdkMcpServer({
      enableMemoryTools: false,
      getToolsForRoom: (roomId: string) => (roomId === "room-1" ? roomTools : undefined),
    });

    const first = await bridge.getSystemPromptContext("room-1");
    const second = await bridge.getSystemPromptContext("room-1");

    expect(first).toContain("room-1");
    expect(first).toContain("Project Discussion");
    expect(first).toContain("@vlad/andy");
    expect(first).toContain("@vlad");
    expect(first).not.toContain("@vlad/andy, @vlad");
    expect(second).toBe(first);
    expect(participantCalls).toBe(1);
    expect(listChats).toHaveBeenCalledTimes(1);

    const contextData = await bridge.getSystemPromptContextData("room-1");
    expect(contextData.agent.id).toBe("agent-1");
    expect(contextData.roomTitle).toBe("Project Discussion");
    expect(contextData.participants).toHaveLength(2);
    expect(contextData.warnings).toEqual([]);
  });

  it("falls back with warnings when room tools are unavailable", async () => {
    const bridge = createThenvoiSdkMcpServer({
      enableMemoryTools: false,
      getToolsForRoom: () => undefined,
    });

    const markdown = await bridge.getSystemPromptContext("missing-room");
    const contextData = await bridge.getSystemPromptContextData("missing-room");

    expect(markdown).toContain("missing-room");
    expect(markdown).toContain("### Warnings");
    expect(contextData.warnings).toEqual(["No tool context found for room_id missing-room"]);
    expect(contextData.agent.id).toBe("unknown-agent");
    expect(contextData.participants).toEqual([]);
  });

  it("walks chat pages and surfaces REST resolution warnings", async () => {
    const roomTools: AgentToolsProtocol & { rest: FakeRestApi } = {
      ...{
        capabilities: { peers: false, contacts: false, memory: false },
        sendMessage: async () => ({ ok: true }),
        sendEvent: async () => ({ ok: true }),
        addParticipant: async () => ({ ok: true }),
        removeParticipant: async () => ({ ok: true }),
        getParticipants: async () => [
          { id: "user-1", name: "Vlad Luzin", type: "User", handle: "@vlad" },
        ],
        lookupPeers: async () => ({ data: [] }),
        createChatroom: async () => "room-x",
        getToolSchemas: () => [],
        getAnthropicToolSchemas: () => [],
        getOpenAIToolSchemas: () => [],
        listContacts: async () => ({ data: [] }),
        addContact: async () => ({ ok: true }),
        removeContact: async () => ({ ok: true }),
        listContactRequests: async () => ({ received: [], sent: [] }),
        respondContactRequest: async () => ({ ok: true }),
        listMemories: async () => ({ data: [] }),
        storeMemory: async () => ({ id: "mem-1" }),
        getMemory: async () => ({ id: "mem-1" }),
        supersedeMemory: async () => ({ ok: true }),
        archiveMemory: async () => ({ ok: true }),
        executeToolCall: async () => ({ ok: true }),
      },
      rest: new FakeRestApi({
        getAgentMe: async () => {
          throw new Error("identity offline");
        },
        listChats: async ({ page }) => {
          if (page === 1) {
            return { data: [{ id: "room-1", title: "Other Room" }], metadata: { totalPages: 2 } };
          }
          return { data: [{ id: "room-200", title: "Paged Room" }], metadata: { totalPages: 2 } };
        },
      }),
    };

    const bridge = createThenvoiSdkMcpServer({
      enableMemoryTools: false,
      getToolsForRoom: (roomId: string) => (roomId === "room-200" ? roomTools : undefined),
    });

    const markdown = await bridge.getSystemPromptContext("room-200");
    const contextData = await bridge.getSystemPromptContextData("room-200");

    expect(markdown).toContain("Paged Room");
    expect(markdown).toContain("### Warnings");
    expect(contextData.roomTitle).toBe("Paged Room");
    expect(contextData.warnings).toContain("Unable to resolve agent identity: identity offline");
  });

  it("builds thenvoi MCP tools without room_id when multiRoom is false", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge = createThenvoiSdkMcpServer({
      multiRoom: false,
      enableMemoryTools: false,
      getToolsForRoom: () => makeTools(calls),
    });

    const sendMessageTool = bridge.toolDefinitions.find((entry) => entry.name === "thenvoi_send_message");
    expect(sendMessageTool).toBeDefined();
    if (!sendMessageTool) {
      throw new Error("thenvoi_send_message tool definition missing");
    }

    const result = await sendMessageTool.handler({
      content: "hello",
      mentions: ["@b"],
    }, {});

    expect(calls).toEqual([
      {
        name: "thenvoi_send_message",
        args: {
          content: "hello",
          mentions: ["@b"],
        },
      },
    ]);
    expect(result.isError).toBeUndefined();
  });
});

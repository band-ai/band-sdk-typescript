import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OpenAIAdapter } from "../src/index";
import { RestFacade } from "../src/client/rest/RestFacade";
import type { RestApi } from "../src/client/rest/types";
import { BLANK_CONTENT_ERROR, BLANK_CONTENT_STATUS } from "../src/contracts/content";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import type { HistoryProvider, PlatformMessage } from "../src/runtime";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import type { AgentToolsProtocol } from "../src/core";
import type { ToolCallingModel } from "../src/adapters";
import type {
  ContactRequestsResult,
  ContactRecord,
  MemoryRecord,
  MetadataMap,
  PaginatedList,
  ParticipantRecord,
  PeerRecord,
} from "../src/contracts/dtos";

class FakeTools implements AgentToolsProtocol {
  public readonly capabilities = { peers: false, contacts: false, memory: false };
  public readonly events: Array<Record<string, unknown>> = [];
  public readonly messages: string[] = [];

  public async sendMessage(content: string): Promise<Record<string, unknown>> {
    this.messages.push(content);
    return { ok: true };
  }

  public async sendEvent(content: string, messageType: string): Promise<Record<string, unknown>> {
    this.events.push({ content, messageType });
    return { ok: true };
  }

  public async addParticipant(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async removeParticipant(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async getParticipants(): Promise<ParticipantRecord[]> {
    return [];
  }

  public async lookupPeers(): Promise<PaginatedList<PeerRecord>> {
    return { data: [] };
  }

  public async createChatroom(): Promise<string> {
    return "room";
  }

  public getToolSchemas(): Array<Record<string, unknown>> {
    return [
      {
        type: "function",
        function: {
          name: "band_send_message",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
  }

  public getAnthropicToolSchemas(): Array<Record<string, unknown>> {
    return this.getToolSchemas();
  }

  public getOpenAIToolSchemas(): Array<Record<string, unknown>> {
    return this.getToolSchemas();
  }

  public async listContacts(): Promise<PaginatedList<ContactRecord>> {
    throw new Error("not implemented");
  }

  public async addContact(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  public async removeContact(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  public async listContactRequests(): Promise<ContactRequestsResult> {
    throw new Error("not implemented");
  }

  public async respondContactRequest(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  public async listMemories(): Promise<PaginatedList<MemoryRecord>> {
    throw new Error("not implemented");
  }

  public async storeMemory(): Promise<MemoryRecord> {
    throw new Error("not implemented");
  }

  public async getMemory(): Promise<MemoryRecord> {
    throw new Error("not implemented");
  }

  public async supersedeMemory(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  public async archiveMemory(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  public async executeToolCall(name: string, _arguments: MetadataMap): Promise<unknown> {
    if (name === "band_send_message") {
      return { ok: true };
    }

    return { ok: true };
  }
}

class FakeModel implements ToolCallingModel {
  private turns = 0;
  public readonly requests: Array<{
    toolRounds?: Array<{
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolResults: Array<{ toolCallId: string; name: string; output: unknown; isError?: boolean }>;
    }>;
  }> = [];

  public async complete(
    request: {
      toolRounds?: Array<{
        toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        toolResults: Array<{ toolCallId: string; name: string; output: unknown; isError?: boolean }>;
      }>;
    },
  ): Promise<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }> {
    this.requests.push({
      toolRounds: request.toolRounds,
    });
    this.turns += 1;
    if (this.turns === 1) {
      return {
        toolCalls: [
          {
            id: "tc1",
            name: "band_send_message",
            input: { content: "ignored" },
          },
        ],
      };
    }

    return { text: "final answer" };
  }
}

/**
 * Minimal RestApi mirroring FernRestAdapter's blank-content refusal, so the real
 * AgentTools (not FakeTools) can be wired into the adapter under test.
 * createChatEvent isn't exercised by this file's tests, so it just returns success.
 */
class BlankContentRestApi implements RestApi {
  public async getAgentMe() {
    return { id: "a1", name: "Agent", description: null };
  }

  public async createChatMessage() {
    return { ok: false, status: BLANK_CONTENT_STATUS, error: `content ${BLANK_CONTENT_ERROR}` };
  }

  public async createChatEvent() {
    return { ok: true, id: "evt-1" };
  }

  public async createChat() {
    return { id: "r2" };
  }

  public async listChatParticipants() {
    return [];
  }

  public async addChatParticipant() {
    return { ok: true };
  }

  public async removeChatParticipant() {
    return { ok: true };
  }

  public async markMessageProcessing() {
    return { ok: true };
  }

  public async markMessageProcessed() {
    return { ok: true };
  }

  public async markMessageFailed() {
    return { ok: true };
  }
}

const fakeHistory = {
  raw: [],
  convert: () => [],
  length: 0,
} as unknown as HistoryProvider;

const fakeMessage: PlatformMessage = {
  id: "m1",
  roomId: "r1",
  content: "hello",
  senderId: "u1",
  senderType: "User",
  senderName: "Jane",
  messageType: "text",
  metadata: {},
  createdAt: new Date(),
};

describe("ToolCallingAdapter", () => {
  it("does not duplicate the current message when history already includes it", async () => {
    class SingleTurnModel implements ToolCallingModel {
      public seenMessages: Array<Record<string, unknown>> = [];

      public async complete(
        request: { messages?: Array<Record<string, unknown>> },
      ): Promise<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }> {
        this.seenMessages = request.messages ?? [];
        return { text: "ok" };
      }
    }

    const model = new SingleTurnModel();
    const adapter = new OpenAIAdapter({ model });
    const tools = new FakeTools();
    const historyWithCurrentMessage = {
      raw: [fakeMessage],
      convert: () => [],
      length: 1,
    } as unknown as HistoryProvider;

    await adapter.onMessage(fakeMessage, tools, historyWithCurrentMessage, null, null, {
      isSessionBootstrap: false,
      roomId: "r1",
    });

    const helloCount = model.seenMessages.filter((entry) => entry.content === "hello").length;
    expect(helloCount).toBe(1);
  });

  it("runs tool rounds then sends final text", async () => {
    const model = new FakeModel();
    const adapter = new OpenAIAdapter({
      model,
    });

    const tools = new FakeTools();
    await adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
      isSessionBootstrap: true,
      roomId: "r1",
    });

    expect(tools.messages).toEqual(["final answer"]);
    expect(model.requests).toHaveLength(2);

    const secondRequest = model.requests[1];
    const roundResults = (secondRequest?.toolRounds ?? []).flatMap((round) => round.toolResults);

    expect(roundResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "tc1",
          name: "band_send_message",
        }),
      ]),
    );
  });

  it("emits tool_call and tool_result events when execution reporting is enabled", async () => {
    const adapter = new OpenAIAdapter({
      model: new FakeModel(),
      enableExecutionReporting: true,
    });

    const tools = new FakeTools();
    await adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
      isSessionBootstrap: true,
      roomId: "r1",
    });

    expect(tools.events).toHaveLength(2);
    expect(tools.events[0]?.messageType).toBe("tool_call");
    expect(tools.events[1]?.messageType).toBe("tool_result");
    expect(tools.messages).toEqual(["final answer"]);
  });

  it("dispatches custom tools before platform tools", async () => {
    const calls: string[] = [];

    const customTool: CustomToolDef = {
      schema: z.object({ city: z.string() }),
      handler: (args) => {
        calls.push(`custom:${(args as { city: string }).city}`);
        return "Sunny, 72F";
      },
      name: "get_weather",
    };

    class CustomToolModel implements ToolCallingModel {
      private turns = 0;
      public async complete(): Promise<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }> {
        this.turns += 1;
        if (this.turns === 1) {
          return {
            toolCalls: [
              { id: "tc1", name: "get_weather", input: { city: "NYC" } },
            ],
          };
        }
        return { text: "done" };
      }
    }

    const adapter = new OpenAIAdapter({
      model: new CustomToolModel(),
      customTools: [customTool],
    });

    const tools = new FakeTools();
    await adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
      isSessionBootstrap: true,
      roomId: "r1",
    });

    expect(calls).toEqual(["custom:NYC"]);
    expect(tools.messages).toEqual(["done"]);
  });

  it("catches custom tool errors and returns typed error output", async () => {
    const customTool: CustomToolDef = {
      schema: z.object({ query: z.string() }),
      handler: () => { throw new Error("API down"); },
      name: "search",
    };

    class ErrorToolModel implements ToolCallingModel {
      private turns = 0;
      public async complete(req: { toolRounds?: Array<{ toolResults: Array<{ output: unknown }> }> }): Promise<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }> {
        this.turns += 1;
        if (this.turns === 1) {
          return {
            toolCalls: [{ id: "tc1", name: "search", input: { query: "test" } }],
          };
        }
        const toolOutput = req.toolRounds?.[0]?.toolResults?.[0]?.output;
        const caughtAsTypedError = Boolean(
          toolOutput
          && typeof toolOutput === "object"
          && (toolOutput as { ok?: unknown }).ok === false
          && typeof (toolOutput as { message?: unknown }).message === "string"
          && (toolOutput as { message: string }).message.includes("API down"),
        );
        return { text: caughtAsTypedError ? "error_caught" : "no_error" };
      }
    }

    const adapter = new OpenAIAdapter({
      model: new ErrorToolModel(),
      customTools: [customTool],
    });

    const tools = new FakeTools();
    await adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
      isSessionBootstrap: true,
      roomId: "r1",
    });

    expect(tools.messages).toEqual(["error_caught"]);
  });

  it("does not send an invisible-only final response", async () => {
    // A zero-width space survives response.text?.trim() but has no visible content;
    // sendMessage throws on it and onMessage has no try/catch, so an unguarded call
    // here would kill the entire agent runtime.
    class BlankFinalResponseModel implements ToolCallingModel {
      public async complete(): Promise<{ text?: string }> {
        return { text: "\u200B" };
      }
    }

    let createChatMessageCalls = 0;
    class TrackingBlankContentRestApi extends BlankContentRestApi {
      public override async createChatMessage(): ReturnType<BlankContentRestApi["createChatMessage"]> {
        createChatMessageCalls += 1;
        return super.createChatMessage();
      }
    }

    const adapter = new OpenAIAdapter({ model: new BlankFinalResponseModel() });
    const tools = new AgentTools({
      roomId: "r1",
      rest: new RestFacade({ api: new TrackingBlankContentRestApi() }),
    });

    await expect(
      adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
        isSessionBootstrap: true,
        roomId: "r1",
      }),
    ).resolves.toBeUndefined();

    expect(createChatMessageCalls).toBe(0);
  });
});

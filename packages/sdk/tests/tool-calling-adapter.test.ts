import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentFailure } from "@band-ai/band-sdk-core";

import { OpenAIAdapter } from "../src/index";
import type { HistoryProvider, PlatformMessage } from "../src/runtime";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import type { AgentToolsProtocol } from "../src/core";
import { toFailureEvent } from "../src/contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../src/runtime/tools/schemas";
import type { ToolCallingModel } from "../src/adapters";
import { describeDeliveryContract } from "./deliveryContract";
import { expectTurnFailed } from "./testUtils";
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

  public async sendEvent(content: string, messageType: string, metadata?: MetadataMap): Promise<Record<string, unknown>> {
    this.events.push({ content, messageType, metadata });
    return { ok: true };
  }

  public async sendFailure(failure: AgentFailure): Promise<Record<string, unknown>> {
    const { content, messageType, metadata } = toFailureEvent(failure);
    return this.sendEvent(content, messageType, metadata);
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

const fakeHistory = {
  raw: [],
  convert: () => [],
  length: 0,
} as unknown as HistoryProvider;


/** Platform history after bootstrap holds only what was delivered to the agent. */
function inboundOnly(...raw: PlatformMessage[]): HistoryProvider {
  return { raw, convert: () => [], length: raw.length } as unknown as HistoryProvider;
}

function turnLines(messages: Array<Record<string, unknown>>): Array<{ role: unknown; content: unknown }> {
  return messages.map(({ role, content }) => ({ role, content }));
}

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
      isSessionBootstrap: true,
      roomId: "r1",
    });

    const helloCount = model.seenMessages.filter((entry) => String(entry.content).endsWith("hello")).length;
    expect(helloCount).toBe(1);
  });

  it("shows only its own messages as its turns, attributing everyone else's", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(...(request.messages ?? []));
        return { text: "ok" };
      },
    };
    const adapter = new OpenAIAdapter({ model });
    await adapter.onStarted("helper-agent", "");
    const history = {
      raw: [
        { id: "h1", sender_type: "Agent", sender_name: "helper-agent", content: "earlier answer" },
        { id: "h2", sender_type: "User", sender_name: "Jane", content: "thanks" },
      ],
      convert: () => [],
      length: 2,
    } as unknown as HistoryProvider;
    const fromAnotherAgent: PlatformMessage = { ...fakeMessage, id: "m2", senderType: "Agent", senderName: "planner-agent" };

    await adapter.onMessage(fromAnotherAgent, new FakeTools(), history, null, null, { isSessionBootstrap: true, roomId: "r1" });

    expect(seen.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "[Jane]: thanks" },
      { role: "user", content: "[planner-agent]: hello" },
    ]);
  });

  it("carries a send-tool reply and later final text into the following turn", async () => {
    const pineapple = { ...fakeMessage, id: "m1", content: "Reply with: pineapple" };
    const mango = { ...fakeMessage, id: "m2", content: "Reply with: mango" };
    const kiwi = { ...fakeMessage, id: "m3", content: "Reply with: kiwi" };
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return { toolCalls: [{ id: "c1", name: SEND_MESSAGE_TOOL_NAME, input: { content: "pineapple" } }] };
        }
        if (seen.length === 3) {
          return { text: "mango" };
        }
        return {};
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const tools = new FakeTools();
    const room = { isSessionBootstrap: false, roomId: "r1" };

    await adapter.onMessage(pineapple, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" });
    await adapter.onMessage(mango, tools, inboundOnly(pineapple), null, null, room);
    await adapter.onMessage(kiwi, tools, inboundOnly(pineapple, mango), null, null, room);

    expect(turnLines(seen[2]!)).toEqual([
      { role: "user", content: "[Jane]: Reply with: pineapple" },
      { role: "assistant", content: "pineapple" },
      { role: "user", content: "[Jane]: Reply with: mango" },
    ]);
    expect(turnLines(seen[3]!)).toEqual([
      { role: "user", content: "[Jane]: Reply with: pineapple" },
      { role: "assistant", content: "pineapple" },
      { role: "user", content: "[Jane]: Reply with: mango" },
      { role: "assistant", content: "mango" },
      { role: "user", content: "[Jane]: Reply with: kiwi" },
    ]);
  });

  it("leaves a failed send out of the next turn and keeps the one that landed", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return {
            toolCalls: [
              { id: "c1", name: SEND_MESSAGE_TOOL_NAME, input: { content: "pineapple" } },
              { id: "c2", name: SEND_MESSAGE_TOOL_NAME, input: { content: "nope" } },
            ],
          };
        }
        return {};
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const tools = new FakeTools();
    tools.executeToolCall = async (name, args) => {
      if (name === SEND_MESSAGE_TOOL_NAME && args.content === "nope") {
        return { ok: false, message: "send failed" };
      }
      return { ok: true };
    };
    const next = { ...fakeMessage, id: "m2", content: "Reply with: mango" };

    await adapter.onMessage(fakeMessage, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" });
    await adapter.onMessage(next, tools, inboundOnly(fakeMessage), null, null, { isSessionBootstrap: false, roomId: "r1" });

    expect(turnLines(seen.at(-1)!)).toEqual([
      { role: "user", content: "[Jane]: hello" },
      { role: "assistant", content: "pineapple" },
      { role: "user", content: "[Jane]: Reply with: mango" },
    ]);
  });

  it("keeps a send that landed when a later model call throws", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return { toolCalls: [{ id: "c1", name: SEND_MESSAGE_TOOL_NAME, input: { content: "pineapple" } }] };
        }
        if (seen.length === 2) {
          throw new Error("provider blew up");
        }
        return {};
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const next = { ...fakeMessage, id: "m2", content: "Reply with: mango" };

    await expect(adapter.onMessage(fakeMessage, new FakeTools(), inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" })).rejects.toThrow();
    await adapter.onMessage(next, new FakeTools(), inboundOnly(fakeMessage), null, null, { isSessionBootstrap: false, roomId: "r1" });

    expect(turnLines(seen.at(-1)!)).toEqual([
      { role: "user", content: "[Jane]: hello" },
      { role: "assistant", content: "pineapple" },
      { role: "user", content: "[Jane]: Reply with: mango" },
    ]);
  });

  it("does not remember final text that was not delivered", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return { text: "all done" };
        }
        return {};
      },
    };
    const tools = new FakeTools();
    tools.sendMessage = async () => {
      throw new Error("send failed");
    };
    const adapter = new OpenAIAdapter({ model });
    const next = { ...fakeMessage, id: "m2", content: "next question" };

    await expect(adapter.onMessage(fakeMessage, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" })).rejects.toThrow();
    await adapter.onMessage(next, new FakeTools(), inboundOnly(fakeMessage), null, null, { isSessionBootstrap: false, roomId: "r1" });

    expect(turnLines(seen.at(-1)!)).toEqual([
      { role: "user", content: "[Jane]: hello" },
      { role: "user", content: "[Jane]: next question" },
    ]);
  });

  it("remembers the string a non-string or empty send was posted as", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return {
            toolCalls: [
              { id: "c1", name: SEND_MESSAGE_TOOL_NAME, input: { content: 42 } },
              { id: "c2", name: SEND_MESSAGE_TOOL_NAME, input: { content: "" } },
            ],
          };
        }
        return {};
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const next = { ...fakeMessage, id: "m2", content: "next question" };

    await adapter.onMessage(fakeMessage, new FakeTools(), inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" });
    await adapter.onMessage(next, new FakeTools(), inboundOnly(fakeMessage), null, null, { isSessionBootstrap: false, roomId: "r1" });

    expect(turnLines(seen.at(-1)!)).toEqual([
      { role: "user", content: "[Jane]: hello" },
      { role: "assistant", content: "42" },
      { role: "assistant", content: "" },
      { role: "user", content: "[Jane]: next question" },
    ]);
  });

  it("does not interleave two turns of the same room", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const seen: string[][] = [];
    let calls = 0;
    const model: ToolCallingModel = {
      complete: async (request) => {
        calls += 1;
        const contents = (request.messages ?? []).map((message) => String(message.content));
        if (calls === 1) {
          markStarted();
          await gate;
        }
        seen.push(contents);
        return { text: calls === 1 ? "pineapple" : "mango" };
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const tools = new FakeTools();
    const mango = { ...fakeMessage, id: "m2", content: "Reply with: mango" };
    const room = { isSessionBootstrap: false, roomId: "r1" };

    const first = adapter.onMessage(fakeMessage, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" });
    await started;
    const second = adapter.onMessage(mango, tools, inboundOnly(fakeMessage), null, null, room);
    releaseFirst();
    await first;
    await second;

    expect(seen[1]).toEqual([
      "[Jane]: hello",
      "pineapple",
      "[Jane]: Reply with: mango",
    ]);
  });

  it("keeps a participant notice on this turn only", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        seen.push(request.messages ?? []);
        if (seen.length === 1) {
          return { toolCalls: [{ id: "c1", name: SEND_MESSAGE_TOOL_NAME, input: { content: "pineapple" } }] };
        }
        return {};
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const next = { ...fakeMessage, id: "m2", content: "Reply with: mango" };

    await adapter.onMessage(fakeMessage, new FakeTools(), inboundOnly(), "Alice joined the room.", null, { isSessionBootstrap: true, roomId: "r1" });
    await adapter.onMessage(next, new FakeTools(), inboundOnly(fakeMessage), null, "Bob is now a contact.", { isSessionBootstrap: false, roomId: "r1" });

    expect(turnLines(seen[0]!)).toContainEqual({ role: "system", content: "Alice joined the room." });
    const later = turnLines(seen.at(-1)!);
    expect(later).not.toContainEqual({ role: "system", content: "Alice joined the room." });
    expect(later).toContainEqual({ role: "system", content: "Bob is now a contact." });
  });

  it("does not share one room's turn or transcript with another room", async () => {
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const prompts: string[][] = [];
    const model: ToolCallingModel = {
      complete: async (request) => {
        const contents = (request.messages ?? []).map((message) => String(message.content));
        if (contents.some((content) => content.includes("room-a-ask")) && prompts.length === 0) {
          markStarted();
          await gate;
        }
        prompts.push(contents);
        return { text: "ok" };
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const tools = new FakeTools();
    const roomA = { ...fakeMessage, id: "a", roomId: "room-a", content: "room-a-ask" };
    const roomB = { ...fakeMessage, id: "b", roomId: "room-b", content: "room-b-ask" };
    const first = adapter.onMessage(roomA, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "room-a" });
    await started;
    const second = adapter.onMessage(roomB, tools, inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "room-b" });
    const finished = await Promise.race([
      second.then(() => "done" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 200);
      }),
    ]);
    releaseA();
    await first;
    await second;

    expect(finished).toBe("done");
    expect(prompts[0]!.some((content) => content.includes("room-a-ask"))).toBe(false);
  });

  it("waits out a parked turn after cleanup and drops that transcript", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const prompts: string[][] = [];
    let secondEntered = false;
    const model: ToolCallingModel = {
      complete: async (request) => {
        const contents = (request.messages ?? []).map((message) => String(message.content));
        if (prompts.length === 0) {
          markStarted();
          await gate;
        } else {
          secondEntered = true;
        }
        prompts.push(contents);
        return { text: prompts.length === 1 ? "pineapple" : "mango" };
      },
    };
    const adapter = new OpenAIAdapter({ model });
    const next = { ...fakeMessage, id: "m2", content: "next question" };
    const first = adapter.onMessage(fakeMessage, new FakeTools(), inboundOnly(), null, null, { isSessionBootstrap: true, roomId: "r1" });
    await started;
    await adapter.onCleanup("r1");
    const second = adapter.onMessage(next, new FakeTools(), inboundOnly(), null, null, { isSessionBootstrap: false, roomId: "r1" });
    const finished = await Promise.race([
      second.then(() => "done" as const),
      new Promise<"waiting">((resolve) => {
        setTimeout(() => resolve("waiting"), 50);
      }),
    ]);
    expect(finished).toBe("waiting");
    expect(secondEntered).toBe(false);
    releaseFirst();
    await first;
    await second;

    expect(prompts.at(-1)).toEqual(["[Jane]: next question"]);
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

  it("routes a provider failure through sendFailure, then fails the turn", async () => {
    class ThrowingModel implements ToolCallingModel {
      public async complete(): Promise<{
        text?: string;
        toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      }> {
        throw new Error("provider exploded");
      }
    }

    const adapter = new OpenAIAdapter({ model: new ThrowingModel() });
    const tools = new FakeTools();

    await expectTurnFailed(
      adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
        isSessionBootstrap: true,
        roomId: "r1",
      }),
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect(tools.events[0]?.content).toBe("provider exploded");
    expect((tools.events[0]?.metadata as { failure?: Record<string, unknown> })?.failure).toMatchObject({
      provider: "openai",
      message: "provider exploded",
    });
  });

  it("stops the tool loop after maxToolRounds and reports a single sendFailure, not a double report", async () => {
    class InfiniteToolCallModel implements ToolCallingModel {
      public async complete(): Promise<{
        text?: string;
        toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      }> {
        return { toolCalls: [{ id: "tc1", name: "band_send_message", input: {} }] };
      }
    }

    const adapter = new OpenAIAdapter({ model: new InfiniteToolCallModel(), maxToolRounds: 1 });
    const tools = new FakeTools();

    await expectTurnFailed(adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
      isSessionBootstrap: true,
      roomId: "r1",
    }));

    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect((tools.events[0]?.metadata as { failure?: { message?: string } })?.failure?.message).toContain(
      "Stopped tool loop after 1 rounds",
    );
  });

  describeDeliveryContract([{
    path: "model reply (shared by every ToolCalling-based adapter)",
    turn: async (tools) => {
      const adapter = new OpenAIAdapter({ model: new FakeModel() });
      await adapter.onMessage(fakeMessage, tools, fakeHistory, null, null, {
        isSessionBootstrap: true,
        roomId: "r1",
      });
    },
  }]);
});

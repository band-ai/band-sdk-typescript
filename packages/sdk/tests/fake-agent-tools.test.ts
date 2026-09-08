import { describe, expect, it } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import { FakeAgentTools } from "../src/testing/FakeAgentTools";

describe("FakeAgentTools", () => {
  it("tracks sent messages with counter-based IDs", async () => {
    const tools = new FakeAgentTools();

    const result1 = await tools.sendMessage("hello");
    const result2 = await tools.sendMessage("world", ["@alice"]);

    expect(result1).toEqual({ id: "msg-0", status: "sent" });
    expect(result2).toEqual({ id: "msg-1", status: "sent" });
    expect(tools.messagesSent).toEqual([
      { content: "hello", mentions: undefined },
      { content: "world", mentions: ["@alice"] },
    ]);
  });

  it("tracks sent events with counter-based IDs", async () => {
    const tools = new FakeAgentTools();

    const result = await tools.sendEvent("typing", "status", { key: "val" });

    expect(result).toEqual({ id: "evt-0", status: "sent" });
    expect(tools.eventsSent).toEqual([
      { content: "typing", messageType: "status", metadata: { key: "val" } },
    ]);
  });

  it("sendFailure posts an error event whose metadata nests the failure under `failure`", async () => {
    const tools = new FakeAgentTools();

    const result = await tools.sendFailure(new AgentFailure("acp", "agent went away", "timeout", { raw: true }));

    expect(result).toEqual({ id: "evt-0", status: "sent" });
    expect(tools.eventsSent).toEqual([
      {
        content: "agent went away",
        messageType: "error",
        metadata: { failure: { provider: "acp", message: "agent went away", code: "timeout", detail: { raw: true } } },
      },
    ]);
  });

  it("sendFailure honors failOn/errorFactory like every other tracked method", async () => {
    const tools = new FakeAgentTools({ failOn: ["sendFailure"] });

    await expect(tools.sendFailure(new AgentFailure("acp", "agent went away"))).rejects.toThrow(
      "FakeAgentTools configured failure for sendFailure",
    );
    expect(tools.eventsSent).toEqual([]);
  });

  it("tracks participants added and removed", async () => {
    const tools = new FakeAgentTools();

    await tools.addParticipant("Alice", "admin");
    await tools.removeParticipant("Bob");

    expect(tools.participantsAdded).toEqual([{ name: "Alice", role: "admin" }]);
    expect(tools.participantsRemoved).toEqual(["Bob"]);
  });

  it("tracks tool calls", async () => {
    const tools = new FakeAgentTools();

    const result = await tools.executeToolCall("my_tool", { arg1: "val1" });

    expect(result).toEqual({ status: "ok" });
    expect(tools.toolCalls).toEqual([
      { toolName: "my_tool", arguments: { arg1: "val1" } },
    ]);
  });

  it("returns empty lists for contact stubs", async () => {
    const tools = new FakeAgentTools();

    expect(await tools.listContacts()).toEqual({ data: [] });
    expect(await tools.addContact({ handle: "alice" })).toEqual({ status: "ok" });
    expect(await tools.removeContact({ target: "handle", handle: "alice" })).toEqual({ status: "ok" });
    expect(await tools.listContactRequests()).toEqual({ received: [], sent: [] });
    expect(await tools.respondContactRequest({ action: "approve", target: "handle", handle: "alice" })).toEqual({
      status: "ok",
    });
  });

  it("returns empty lists for memory stubs", async () => {
    const tools = new FakeAgentTools();

    expect(await tools.listMemories()).toEqual({ data: [] });
    expect(await tools.storeMemory({
      content: "test",
      system: "working",
      type: "semantic",
      segment: "user",
      thought: "remember this",
    })).toEqual({
      id: "mem-0",
      content: "test",
      system: "working",
      type: "semantic",
      segment: "user",
      thought: "remember this",
      status: "active",
    });
    expect(await tools.getMemory("mem-1")).toEqual({ id: "mem-1", status: "active" });
    expect(await tools.supersedeMemory("mem-1")).toEqual({ status: "ok" });
    expect(await tools.archiveMemory("mem-1")).toEqual({ status: "ok" });
  });

  it("returns empty tool schemas", () => {
    const tools = new FakeAgentTools();

    expect(tools.getToolSchemas("openai")).toEqual([]);
    expect(tools.getAnthropicToolSchemas()).toEqual([]);
    expect(tools.getOpenAIToolSchemas()).toEqual([]);
  });

  it("returns empty peer lookup", async () => {
    const tools = new FakeAgentTools();
    expect(await tools.lookupPeers()).toEqual({ data: [] });
  });

  it("throws on configured failOn methods", async () => {
    const tools = new FakeAgentTools({ failOn: ["sendMessage", "executeToolCall"] });

    await expect(tools.sendMessage("hello")).rejects.toThrow("configured failure");
    await expect(tools.executeToolCall("tool", {})).rejects.toThrow("configured failure");

    // Other methods still work
    await expect(tools.sendEvent("test", "thought")).resolves.toBeDefined();
    expect(tools.messagesSent).toEqual([]); // Never recorded because it threw
  });

  it("uses custom error factory", async () => {
    const tools = new FakeAgentTools({
      failOn: ["sendMessage"],
      errorFactory: (method) => new Error(`custom: ${String(method)}`),
    });

    await expect(tools.sendMessage("hello")).rejects.toThrow("custom: sendMessage");
  });

  it("resets all tracked data", async () => {
    const tools = new FakeAgentTools();

    await tools.sendMessage("hello");
    await tools.sendEvent("typing", "status");
    await tools.addParticipant("Alice");
    await tools.removeParticipant("Bob");
    await tools.executeToolCall("tool", {});

    tools.reset();

    expect(tools.messagesSent).toEqual([]);
    expect(tools.eventsSent).toEqual([]);
    expect(tools.participantsAdded).toEqual([]);
    expect(tools.participantsRemoved).toEqual([]);
    expect(tools.toolCalls).toEqual([]);

    // Counter should reset too
    const result = await tools.sendMessage("after reset");
    expect(result).toEqual({ id: "msg-0", status: "sent" });
  });
});

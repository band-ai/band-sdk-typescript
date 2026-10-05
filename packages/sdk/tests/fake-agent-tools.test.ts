import { describe, expect, it } from "vitest";
import { AgentFailure } from "@band-ai/band-sdk-core";

import { NO_REPLY_TOOL_NAME } from "../src/contracts/toolSchemas";
import { relayReply } from "../src/core/turn";
import { FakeAgentTools } from "../src/testing/FakeAgentTools";
import { CLOSING_TEXT } from "./turnOutcomeContract";

describe("FakeAgentTools", () => {
  it("records its Band tool calls on its turn, as production tools do", async () => {
    const replied = new FakeAgentTools();
    await replied.sendMessage("Done.");
    // The turn replied, so its closing text is not relayed as a second message.
    expect(await relayReply(replied, CLOSING_TEXT, [])).toBe(false);
    expect(replied.messagesSent.map((message) => message.content)).toEqual(["Done."]);

    const declined = new FakeAgentTools();
    await declined.executeToolCall(NO_REPLY_TOOL_NAME, { reason: "FYI" });
    expect(declined.turn.verdict()).toBe("complete");

    expect(new FakeAgentTools().turn.verdict()).toBe("missing_reply");
  });

  it("starts a new turn on reset, so a reused fake judges the next turn on its own", async () => {
    const fake = new FakeAgentTools();
    await fake.sendMessage("First turn's reply.");
    fake.reset();

    expect(await relayReply(fake, CLOSING_TEXT, [])).toBe(true);
    expect(fake.messagesSent.map((message) => message.content)).toEqual([CLOSING_TEXT]);
  });

  it("never counts a notice as the turn's reply", async () => {
    const fake = new FakeAgentTools();
    await fake.sendNotice("Working on it.");

    expect(fake.turn.verdict()).toBe("missing_reply");
    expect(await relayReply(fake, CLOSING_TEXT, [])).toBe(true);
  });

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

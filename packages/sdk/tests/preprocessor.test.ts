import { describe, expect, it } from "vitest";

import { DefaultPreprocessor } from "../src/runtime/preprocessing/DefaultPreprocessor";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { BandLink } from "../src/platform/BandLink";
import type { MentionPayload } from "../src/platform/events";
import type { StreamingTransport } from "../src/platform/streaming/transport";
import { FakeRestApi, wireMention } from "./testUtils";

class FakeTransport implements StreamingTransport {
  public async connect() {}
  public async disconnect() {}
  public async join() {}
  public async leave() {}
  public async runForever() {}
  public isConnected() {
    return true;
  }
}

function makeEvent(senderId = "user-1", senderType = "User") {
  return {
    type: "message_created" as const,
    roomId: "room-1",
    payload: {
      id: "m1",
      content: "hello",
      message_type: "text",
      sender_id: senderId,
      sender_type: senderType,
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function makeContext() {
  const link = new BandLink({
    agentId: "a1",
    apiKey: "k",
    restApi: new FakeRestApi(),
    transport: new FakeTransport(),
  });

  return new ExecutionContext({
    roomId: "room-1",
    link,
    maxContextMessages: 50,
  });
}

describe("DefaultPreprocessor", () => {
  it("converts message_created events into AgentInput", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();
    const input = await preprocessor.process(context, makeEvent(), "a1");

    expect(input).not.toBeNull();
    expect(input?.message.content).toBe("hello");
    expect(input?.isSessionBootstrap).toBe(true);
  });

  describe("mention tokens", () => {
    const mentioning = (id: string, content: string, mentions: MentionPayload[]) => {
      const event = makeEvent();
      return { ...event, payload: { ...event.payload, id, content, metadata: { mentions } } };
    };
    const agent = wireMention({ id: "a1", name: "Memory Secretary", handle: "owner/secretary", type: "agent" });

    it("resolves the current message from its own metadata.mentions, and hands the resolved text to the next turn's history", async () => {
      const context = makeContext();
      const preprocessor = new DefaultPreprocessor();

      const first = await preprocessor.process(context, mentioning("m1", "@[[a1]] remember that I like tea", [agent]), "a1");
      const second = await preprocessor.process(context, mentioning("m2", "@[[a1]] and coffee", [agent]), "a1");

      expect(first?.message.content).toBe("@owner/secretary remember that I like tea");
      expect(second?.message.content).toBe("@owner/secretary and coffee");
      expect(second?.history.raw.map((entry) => entry.content)).toContain("@owner/secretary remember that I like tea");
    });

    it("leaves a token with no mention entry raw", async () => {
      const input = await new DefaultPreprocessor().process(makeContext(), mentioning("m1", "@[[unknown-id]] hi", []), "a1");

      expect(input?.message.content).toBe("@[[unknown-id]] hi");
    });
  });

  it("skips self-authored messages", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();
    const result = await preprocessor.process(context, makeEvent("a1", "Agent"), "a1");

    expect(result).toBeNull();
  });

  it("does not skip a message whose sender id matches the agent but whose sender type is not Agent", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();
    const result = await preprocessor.process(context, makeEvent("a1", "User"), "a1");

    expect(result).not.toBeNull();
  });

  it("uses isLlmInitialized for bootstrap detection", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();

    // First call: bootstrap
    const first = await preprocessor.process(context, makeEvent(), "a1");
    expect(first?.isSessionBootstrap).toBe(true);
    expect(context.isLlmInitialized).toBe(true);

    // Second call: no longer bootstrap
    const second = await preprocessor.process(
      context,
      { ...makeEvent(), payload: { ...makeEvent().payload, id: "m2" } },
      "a1",
    );
    expect(second?.isSessionBootstrap).toBe(false);
  });

  it("drains system messages into contactsMessage", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();

    context.injectSystemMessage("Contact added: Alice");
    context.injectSystemMessage("Contact removed: Bob");

    const input = await preprocessor.process(context, makeEvent(), "a1");
    expect(input?.contactsMessage).toBe("Contact added: Alice\nContact removed: Bob");

    // System messages should be drained
    expect(context.consumeSystemMessages()).toEqual([]);
  });

  it("falls back to legacy contactsMessage when no system messages", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();

    context.setContactsMessage("legacy contact info");

    const input = await preprocessor.process(context, makeEvent(), "a1");
    expect(input?.contactsMessage).toBe("legacy contact info");
  });

  it("prefers system messages over legacy contactsMessage", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();

    context.setContactsMessage("legacy contact info");
    context.injectSystemMessage("system msg");

    const input = await preprocessor.process(context, makeEvent(), "a1");
    expect(input?.contactsMessage).toBe("system msg");
    // Legacy message was NOT consumed since system messages took priority
    expect(context.consumeContactsMessage()).toBe("legacy contact info");
  });

  it("surfaces a field-only participant change on the next processed event", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();

    context.addParticipant({ id: "p1", name: "Weather Agent", type: "Agent", handle: "weather-agent" });
    const first = await preprocessor.process(context, makeEvent(), "a1");
    expect(first?.participantsMessage).toContain("Weather Agent joined the room.");
    expect(first?.participantsMessage).toContain("weather-agent");

    context.addParticipant({ id: "p1", handle: "weather-agent-v2" });
    const second = await preprocessor.process(
      context,
      { ...makeEvent(), payload: { ...makeEvent().payload, id: "m2" } },
      "a1",
    );
    expect(second?.participantsMessage).toContain("weather-agent-v2");
    expect(second?.participantsMessage).not.toContain("joined the room");
  });
});

import { describe, expect, it } from "vitest";

import { DefaultPreprocessor } from "../src/runtime/preprocessing/DefaultPreprocessor";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { BandLink } from "../src/platform/BandLink";
import type { StreamingTransport } from "../src/platform/streaming/transport";
import { FakeRestApi } from "./testUtils";

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

function makeEvent(senderId = "user-1") {
  return {
    type: "message_created" as const,
    roomId: "room-1",
    payload: {
      id: "m1",
      content: "hello",
      message_type: "text",
      sender_id: senderId,
      sender_type: "User",
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

  it("skips self-authored messages", async () => {
    const context = makeContext();
    const preprocessor = new DefaultPreprocessor();
    const result = await preprocessor.process(context, makeEvent("a1"), "a1");

    expect(result).toBeNull();
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
});

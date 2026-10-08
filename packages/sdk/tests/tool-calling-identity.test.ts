import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../src/adapters/anthropic/AnthropicAdapter";
import { GeminiAdapter } from "../src/adapters/gemini/GeminiAdapter";
import { SYNTHETIC_CONTACT_EVENTS_SENDER_ID, SYNTHETIC_SENDER_TYPE } from "../src/contracts/protocols";
import type { HistoryProvider } from "../src/runtime";
import { MEMORY_SECTION } from "../src/runtime/prompts";
import { FakeTools, makeMessage } from "./testUtils";

const POLICY = "Keep confidential information private. Reply briefly.";
const PARTICIPANTS = "Participants: @jane, @bob and @owner/helper.";
const CONTACTS = "Contact requests must be reviewed by the user.";
const history = { raw: [], convert: () => [], length: 0 } as unknown as HistoryProvider;

function requestText(request: Record<string, unknown>): string {
  const messages = (request.messages ?? request.contents) as Array<Record<string, unknown>>;
  return messages.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return ((message.parts ?? []) as Array<{ text?: string }>).flatMap((part) => part.text ? [part.text] : []);
  }).join("\n");
}

function identity(request: Record<string, unknown>) {
  const matches = [...requestText(request).matchAll(/Current turn identity: (.+)/g)];
  return matches.map((match) => JSON.parse(match[1]!));
}

describe.each(["anthropic", "gemini"] as const)("%s current recipient context", (provider) => {
  it("transmits transient identity on every round without changing policy or remembering an earlier recipient", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const capture = async (request: Record<string, unknown>) => {
      requests.push(request);
      if (provider === "anthropic") {
        return requests.length === 1
          ? { content: [{ type: "tool_use", id: "lookup", name: "band_get_participants", input: {} }] }
          : { content: [{ type: "text", text: "ok" }] };
      }
      return requests.length === 1
        ? { functionCalls: [{ id: "lookup", name: "band_get_participants", args: {} }] }
        : { text: "ok" };
    };
    const common = { systemPrompt: POLICY, includeMemoryTools: true };
    const adapter = provider === "anthropic"
      ? new AnthropicAdapter({ ...common, clientFactory: async () => ({ messages: { create: capture } }) })
      : new GeminiAdapter({ ...common, clientFactory: async () => ({ models: { generateContent: capture } }) });
    await adapter.onStarted("helper", "personal secretary");
    const jane = { ...makeMessage("remember my preference"), senderName: "Jane", senderId: "jane-id", senderType: "User" };
    const bob = { ...makeMessage("please reply to me"), id: "bob-message", senderName: "Bob", senderId: "bob-id", senderType: "Agent" };
    await adapter.onMessage(jane, new FakeTools(), history, PARTICIPANTS, CONTACTS, { isSessionBootstrap: true, roomId: "room" });
    await adapter.onMessage(bob, new FakeTools(), history, null, null, { isSessionBootstrap: false, roomId: "room" });
    await adapter.onMessage({ ...makeMessage("contact notice"), id: "synthetic", senderId: SYNTHETIC_CONTACT_EVENTS_SENDER_ID, senderType: SYNTHETIC_SENDER_TYPE }, new FakeTools(), history, null, null, { isSessionBootstrap: false, roomId: "room" });

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      const system = provider === "anthropic" ? request.system : (request.config as Record<string, unknown>).systemInstruction;
      expect(system).toContain(POLICY);
      expect(system).toContain(MEMORY_SECTION);
    }
    for (const request of requests.slice(0, 2)) {
      expect(identity(request)).toEqual([{ agentName: "helper", senderName: "Jane", senderType: "User", senderId: "jane-id" }]);
      expect(requestText(request)).toContain(PARTICIPANTS);
      expect(requestText(request)).toContain(CONTACTS);
      expect(requestText(request)).toContain("delivery mention addresses you");
      expect(requestText(request)).toContain("Reply to its sender, not yourself");
    }
    expect(identity(requests[2]!)).toEqual([{ agentName: "helper", senderName: "Bob", senderType: "Agent", senderId: "bob-id" }]);
    expect(requestText(requests[2]!)).not.toContain(PARTICIPANTS);
    expect(requestText(requests[2]!)).not.toContain(CONTACTS);
    expect(requestText(requests[2]!)).toContain("[Jane]: remember my preference");
    expect(requestText(requests[2]!)).toContain("[Bob]: please reply to me");
    expect(identity(requests[3]!)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { UnsupportedFeatureError } from "../src/core/errors";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";

/**
 * Every FernRestAdapter method resolves its Fern client method through an
 * optional-chained `??` fallback chain (e.g. `chatMessages?.x ?? agentApiMessages?.y`)
 * and throws UnsupportedFeatureError when none of the candidates exist, so a
 * caller (RestFacade) gets a clear error instead of a raw "cannot call
 * undefined" crash. Each row below is a distinct fallback chain in
 * FernRestAdapter.ts — this is the contract a broken or shortened `??` chain
 * would silently violate.
 */
describe("FernRestAdapter: unsupported-endpoint contract", () => {
  const cases: Array<[string, (adapter: FernRestAdapter) => Promise<unknown>]> = [
    ["createChatMessage", (adapter) => adapter.createChatMessage("room-1", { content: "hi" })],
    ["createChat", (adapter) => adapter.createChat()],
    ["listChatParticipants", (adapter) => adapter.listChatParticipants("room-1")],
    [
      "addChatParticipant",
      (adapter) => adapter.addChatParticipant("room-1", { participantId: "u1", role: "member" }),
    ],
    ["removeChatParticipant", (adapter) => adapter.removeChatParticipant("room-1", "u1")],
    ["markMessageProcessing", (adapter) => adapter.markMessageProcessing("room-1", "m1")],
    ["markMessageProcessed", (adapter) => adapter.markMessageProcessed("room-1", "m1")],
    ["markMessageFailed", (adapter) => adapter.markMessageFailed("room-1", "m1", "boom")],
    ["listPeers", (adapter) => adapter.listPeers({ page: 1, pageSize: 10, notInChat: "room-1" })],
    ["listChats", (adapter) => adapter.listChats({ page: 1, pageSize: 10 })],
    ["listContacts", (adapter) => adapter.listContacts({})],
    ["addContact", (adapter) => adapter.addContact({ handle: "@jane" })],
    ["removeContact", (adapter) => adapter.removeContact({ target: "handle", handle: "@jane" })],
    ["listContactRequests", (adapter) => adapter.listContactRequests({})],
    [
      "respondContactRequest",
      (adapter) => adapter.respondContactRequest({ action: "approve", target: "handle", handle: "@jane" }),
    ],
    ["listMemories", (adapter) => adapter.listMemories({})],
    [
      "storeMemory",
      (adapter) => adapter.storeMemory({
        content: "c",
        system: "working",
        type: "semantic",
        segment: "user",
        thought: "why",
      }),
    ],
    ["getMemory", (adapter) => adapter.getMemory("memory-1")],
    ["supersedeMemory", (adapter) => adapter.supersedeMemory("memory-1")],
    ["archiveMemory", (adapter) => adapter.archiveMemory("memory-1")],
    ["listMessages", (adapter) => adapter.listMessages({ chatId: "room-1", page: 1, pageSize: 10 })],
    ["getChatContext", (adapter) => adapter.getChatContext({ chatId: "room-1" })],
  ];

  it.each(cases)("%s rejects with UnsupportedFeatureError when the client has no matching endpoint", async (_name, invoke) => {
    const adapter = new FernRestAdapter({});
    await expect(invoke(adapter)).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});

import { describe, expect, it } from "vitest";

import { buildConversationPrompt } from "../src/adapters/shared/conversationPrompt";
import { CHAT_EVENT_TYPES } from "../src/contracts/chatEvents";
import { HistoryProvider } from "../src/runtime/types";

describe("buildConversationPrompt", () => {
  it("includes bootstrap history and system updates in stable order", () => {
    const prompt = buildConversationPrompt({
      history: new HistoryProvider([
        { sender_name: "Alice", content: "historic message" },
      ]),
      isSessionBootstrap: true,
      participantsMessage: "Participants changed",
      contactsMessage: "Contacts changed",
      historyHeader: "[History]",
      currentMessage: "Current message",
    });

    expect(prompt).toContain("[History]");
    expect(prompt).toContain("[Alice]: historic message");
    expect(prompt).toContain("[System]: Participants changed");
    expect(prompt).toContain("[System]: Contacts changed");
    expect(prompt.endsWith("Current message")).toBe(true);
  });

  it("omits bootstrap history when session is already warm", () => {
    const prompt = buildConversationPrompt({
      history: new HistoryProvider([
        { sender_name: "Alice", content: "historic message" },
      ]),
      isSessionBootstrap: false,
      participantsMessage: null,
      contactsMessage: null,
      historyHeader: "[History]",
      currentMessage: "Current message",
    });

    expect(prompt).not.toContain("[History]");
    expect(prompt).toBe("Current message");
  });

  it("keeps only text entries from the raw bootstrap window", () => {
    const outsideWindow = { sender_name: "Old", content: "outside the window" };
    const inWindow = [
      { sender_name: "Alice", message_type: "text", content: "typed text" },
      { sender_name: "Bob", content: "legacy text" },
      ...CHAT_EVENT_TYPES.map((message_type) => ({
        message_type,
        content: `${message_type} content`,
      })),
      { message_type: "unknown", content: "unrecognized content" },
      { sender_name: "Carol", message_type: "text", content: "after non-text" },
    ];
    const prompt = buildConversationPrompt({
      history: new HistoryProvider([outsideWindow, ...inWindow]),
      isSessionBootstrap: true,
      participantsMessage: null,
      contactsMessage: null,
      historyHeader: "[History]",
      currentMessage: "Current message",
      maxHistoryMessages: inWindow.length,
    });

    expect(prompt).toContain("[Alice]: typed text");
    expect(prompt).toContain("[Bob]: legacy text");
    expect(prompt).toContain("[Carol]: after non-text");
    expect(prompt).not.toContain("outside the window");
    for (const message_type of CHAT_EVENT_TYPES) {
      expect(prompt).not.toContain(`${message_type} content`);
    }
    expect(prompt).not.toContain("unrecognized content");
  });

  it("omits the history header when no bootstrap entries are text", () => {
    const prompt = buildConversationPrompt({
      history: new HistoryProvider([
        { message_type: "task", content: "session marker" },
        { message_type: "tool_call", content: "tool call" },
      ]),
      isSessionBootstrap: true,
      participantsMessage: null,
      contactsMessage: null,
      historyHeader: "[History]",
      currentMessage: "Current message",
    });

    expect(prompt).toBe("Current message");
  });
});

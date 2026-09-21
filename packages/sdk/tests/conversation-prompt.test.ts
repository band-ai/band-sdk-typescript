import { describe, expect, it } from "vitest";

import { buildConversationPrompt } from "../src/adapters/shared/conversationPrompt";
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
    const prompt = buildConversationPrompt({
      history: new HistoryProvider([
        { sender_name: "Old", content: "outside the window" },
        { message_type: "task", content: "session marker" },
        { sender_name: "Alice", message_type: "text", content: "typed text" },
        { sender_name: "Bob", content: "legacy text" },
        { message_type: "tool_call", content: JSON.stringify({ type: "tool_use_summary" }) },
        { message_type: "tool_result", content: "tool output" },
        { message_type: "thought", content: "internal reasoning" },
        { message_type: "error", content: "provider error" },
        { message_type: "unknown", content: "unrecognized content" },
      ]),
      isSessionBootstrap: true,
      participantsMessage: null,
      contactsMessage: null,
      historyHeader: "[History]",
      currentMessage: "Current message",
      maxHistoryMessages: 8,
    });

    expect(prompt).toContain("[Alice]: typed text");
    expect(prompt).toContain("[Bob]: legacy text");
    expect(prompt).not.toContain("outside the window");
    expect(prompt).not.toContain("session marker");
    expect(prompt).not.toContain("tool_use_summary");
    expect(prompt).not.toContain("tool output");
    expect(prompt).not.toContain("internal reasoning");
    expect(prompt).not.toContain("provider error");
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

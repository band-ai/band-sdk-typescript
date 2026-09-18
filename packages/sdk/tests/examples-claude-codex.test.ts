import { describe, expect, it } from "vitest";

import {
  buildClaudeSdkExampleAdapter,
  createClaudeSdkAgent,
} from "../examples/claude-sdk/01_basic_agent";
import { createCodexAgent } from "../examples/codex/01_basic_agent";
import { generateTomPrompt } from "../examples/prompts/characters";
import type { ClaudeSDKQuery } from "../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, makeMessage } from "./testUtils";

function claudeSuccessStream(sessionId = "session-example"): ReturnType<ClaudeSDKQuery> {
  return (async function* generator() {
    yield {
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text: "ok" }] },
    } as never;
    yield {
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: sessionId,
    } as never;
  })() as ReturnType<ClaudeSDKQuery>;
}

describe("claude/codex examples", () => {
  it("factories return agents that have not auto-started", () => {
    expect(createClaudeSdkAgent().state.status).toBe("not_started");
    expect(createCodexAgent().state.status).toBe("not_started");
  });

  it("Tom character customSection reaches the Claude SDK system prompt", async () => {
    let systemPrompt = "";
    const adapter = buildClaudeSdkExampleAdapter({
      customSection: generateTomPrompt("Tom").trim(),
      queryFn: ({
        options,
      }: {
        prompt: string;
        options?: { systemPrompt?: string };
      }) => {
        systemPrompt = typeof options?.systemPrompt === "string" ? options.systemPrompt : "";
        return claudeSuccessStream();
      },
    });

    await adapter.onStarted("Tom", "Character demo");
    await adapter.onMessage(
      makeMessage("hi", "room-claude"),
      new FakeTools(),
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-claude" },
    );

    expect(systemPrompt).toContain("Tom the Cat");
  });
});

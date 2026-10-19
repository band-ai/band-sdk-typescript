import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registry, ADAPTER } from "./baseline/toolkit/adapters";
import { activityPeer, json } from "./support/activityPeer";
import { scopedActivity } from "./support/scopedActivity";
import { turnInput } from "./turnOutcomeContract";
import { FakeRestApi } from "./testUtils";

afterEach(() => vi.unstubAllEnvs());

describe("baseline narration preference", () => {
  it.each([
    { reportToolCalls: false, narration: [] },
    { reportToolCalls: undefined, narration: ["tool_call", "tool_result"] },
  ])("honors an explicit false with custom tools while preserving omitted fallback (%j)", async ({ reportToolCalls, narration }) => {
    let requests = 0;
    await using peer = await activityPeer(({ response }) => json(response, {
      id: `msg-${++requests}`, type: "message", role: "assistant", model: "test-model",
      content: requests === 1 ? [{ type: "tool_use", id: "call", name: "lookup", input: { query: "private-marker" } }] : [{ type: "text", text: "Done." }],
      stop_reason: requests === 1 ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", peer.origin);
    const handler = vi.fn(() => "result");
    const adapter = registry.get(ADAPTER.anthropic).build({ prompt: "Run lookup", workDir: tmpdir(), reportToolCalls,
      customTools: [{ name: "lookup", schema: z.object({ query: z.string() }), handler }],
    });
    const rest = new FakeRestApi();
    const events = vi.spyOn(rest, "createChatEvent");
    await using scope = await scopedActivity(rest);
    await adapter.onStarted("Agent", "test");
    try { await adapter.onEvent(turnInput(scope.tools)); }
    finally { await adapter.onCleanup("room"); await adapter.onRuntimeStop?.(); }
    expect(handler).toHaveBeenCalledWith({ query: "private-marker" });
    expect(requests).toBe(2);
    expect(scope.reports.entries).toContainEqual({ kind: "tool_call", name: "lookup" });
    const narrated = events.mock.calls.map(([, event]) => event.messageType).filter((type) => type === "tool_call" || type === "tool_result");
    expect(narrated).toEqual(narration);
  });
});

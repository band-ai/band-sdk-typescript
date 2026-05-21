/**
 * Real ACP smoke test against a locally installed `codex-acp`.
 *
 * This stays outside the default Vitest suite. It is an operator-run harness
 * for validating that the ACP client adapter can:
 * - initialize a real ACP subprocess
 * - create and reuse a session
 * - auto-inject the Band MCP server
 * - round-trip visible room actions through Band tools
 *
 * Run:
 *   RUN_CODEX_ACP_E2E=1 npx tsx tests/integration/codex-acp-smoke.ts
 */

import { ACPClientAdapter } from "../../src/adapters/acp";
import { FakeTools, makeMessage } from "../testUtils";

const REQUIRED_FLAG = "RUN_CODEX_ACP_E2E";
const PROMPT_TIMEOUT_MS = 180_000;

function isEnabled(): boolean {
  return process.env[REQUIRED_FLAG] === "1";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  if (!isEnabled()) {
    console.log(
      `codex-acp smoke skipped. Set ${REQUIRED_FLAG}=1 to run this live integration harness.`,
    );
    return;
  }

  const timer = setTimeout(() => {
    console.error(`codex-acp smoke timed out after ${PROMPT_TIMEOUT_MS}ms`);
    process.exit(124);
  }, PROMPT_TIMEOUT_MS);
  timer.unref?.();

  const adapter = new ACPClientAdapter({
    command: ["codex-acp"],
    enableMcpTools: true,
  });

  const tools = new FakeTools();
  const roomId = "codex-acp-smoke-room";

  try {
    console.log("codex-acp smoke starting adapter...");
    await adapter.onStarted("ACP Smoke Agent", "Smoke-test agent for codex-acp");

    console.log("codex-acp smoke prompt 1...");
    await adapter.onMessage(
      makeMessage("What is 2 + 2? Reply with just the number.", roomId),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: true, roomId },
    );

    console.log("codex-acp smoke prompt 2...");
    await adapter.onMessage(
      makeMessage("What is 3 + 3? Reply with just the number.", roomId),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId },
    );

    const sessionEvents = tools.events.filter((event) =>
      event.messageType === "task"
      && typeof event.metadata?.acp_client_session_id === "string",
    );
    const toolCallEvents = tools.events.filter((event) => event.messageType === "tool_call");
    const toolResultEvents = tools.events.filter((event) => event.messageType === "tool_result");

    assert(tools.messages.length >= 2, `expected at least 2 messages, got ${tools.messages.length}`);
    assert(
      tools.messages.includes("4"),
      `expected a visible reply of "4"; got ${JSON.stringify(tools.messages)}`,
    );
    assert(
      tools.messages.includes("6"),
      `expected a visible reply of "6"; got ${JSON.stringify(tools.messages)}`,
    );
    assert(sessionEvents.length >= 2, `expected session marker events, got ${sessionEvents.length}`);
    assert(toolCallEvents.length >= 2, `expected MCP tool_call events, got ${toolCallEvents.length}`);
    assert(toolResultEvents.length >= 2, `expected MCP tool_result events, got ${toolResultEvents.length}`);

    const sessionIds = new Set(
      sessionEvents
        .map((event) => event.metadata?.acp_client_session_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    assert(sessionIds.size === 1, `expected exactly 1 reused ACP session, got ${sessionIds.size}`);

    const sendMessageCalls = toolCallEvents.filter((event) =>
      (event.metadata?.raw_input as Record<string, unknown> | undefined)?.tool === "band_send_message",
    );
    assert(
      sendMessageCalls.length >= 2,
      `expected band_send_message MCP calls, got ${sendMessageCalls.length}`,
    );

    console.log("codex-acp smoke passed");
    console.log(JSON.stringify({
      messages: tools.messages,
      sessionId: [...sessionIds][0] ?? null,
      toolCallCount: toolCallEvents.length,
      toolResultCount: toolResultEvents.length,
    }, null, 2));
  } finally {
    clearTimeout(timer);
    await adapter.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("codex-acp smoke failed:", error);
  process.exit(1);
});

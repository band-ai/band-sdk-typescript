/**
 * A locally installed `codex-acp` driven through the generic ACP client, off
 * the platform: a real ACP subprocess, one session reused across two prompts,
 * and each answer posted through the auto-injected Band MCP tools.
 *
 * Opt-in, for an operator with `codex-acp` installed and signed in.
 */
import { describe, expect, it } from "vitest";

import { ACPClientAdapter } from "../../../../src/adapters/acp";
import { ACP_SESSION_EVENT } from "../../../../src/converters/acp-client";
import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/runtime/tools/schemas";
import { FakeTools, makeMessage } from "../../../testUtils";
import { MESSAGE_TYPE } from "../../toolkit/observeMessages";
import { CATEGORY, FLAG_ON, scenarioId } from "../../toolkit/registry";

const SCENARIO = scenarioId(CATEGORY.adapters, "codexAcpSmoke");
const OPT_IN_ENV = "RUN_CODEX_ACP_E2E";
const CODEX_ACP_COMMAND = ["codex-acp"];
/** Two turns on one session, each with the one answer it must post. */
const TURNS = [
  { question: "What is 2 + 2? Reply with just the number.", answer: "4" },
  { question: "What is 3 + 3? Reply with just the number.", answer: "6" },
];
const ROOM_ID = "codex-acp-smoke-room";

async function ask(adapter: ACPClientAdapter, tools: FakeTools, question: string, isSessionBootstrap: boolean) {
  await adapter.onMessage(makeMessage(question, ROOM_ID), tools, { roomToSession: {} }, null, null, {
    isSessionBootstrap,
    roomId: ROOM_ID,
  });
}

describe(SCENARIO, () => {
  it("reuses one ACP session and answers through the Band MCP tools", async ({ skip }) => {
    if (process.env[OPT_IN_ENV] !== FLAG_ON) {
      skip(`set ${OPT_IN_ENV}=${FLAG_ON} to run against a local codex-acp`);
    }
    const adapter = new ACPClientAdapter({ command: CODEX_ACP_COMMAND, enableMcpTools: true });
    await using _stopped = { [Symbol.asyncDispose]: () => adapter.stop().catch(() => undefined) };
    const tools = new FakeTools();

    await adapter.onStarted("ACP Smoke Agent", "Smoke-test agent for codex-acp");
    for (const [index, { question }] of TURNS.entries()) {
      await ask(adapter, tools, question, index === 0);
    }

    expect(tools.messages).toEqual(expect.arrayContaining(TURNS.map(({ answer }) => answer)));
    const sessionIds = tools.events
      .filter((event) => event.messageType === MESSAGE_TYPE.Task)
      .map((event) => event.metadata?.[ACP_SESSION_EVENT.sessionIdKey])
      .filter((id) => typeof id === "string");
    expect(sessionIds.length).toBeGreaterThanOrEqual(TURNS.length);
    expect(new Set(sessionIds).size, "one reused ACP session").toBe(1);
    const sendCalls = tools.events.filter(
      (event) =>
        event.messageType === MESSAGE_TYPE.ToolCall &&
        (event.metadata?.raw_input as { tool?: string } | undefined)?.tool === SEND_MESSAGE_TOOL_NAME,
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(TURNS.length);
  });
});

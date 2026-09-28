/**
 * A locally installed `codex-acp` driven through the generic ACP client, off
 * the platform: a real ACP subprocess, one session reused across two prompts,
 * and each answer posted through the auto-injected Band MCP tools.
 *
 * Opt-in, for an operator with `codex-acp` installed and signed in.
 */
import { describe, expect, it } from "vitest";

import { ACPClientAdapter } from "../../../../src/adapters/acp";
import { FakeTools, makeMessage } from "../../../testUtils";

const OPT_IN_ENV = "RUN_CODEX_ACP_E2E";
const ROOM_ID = "codex-acp-smoke-room";

async function ask(adapter: ACPClientAdapter, tools: FakeTools, question: string, isSessionBootstrap: boolean) {
  await adapter.onMessage(makeMessage(question, ROOM_ID), tools, { roomToSession: {} }, null, null, {
    isSessionBootstrap,
    roomId: ROOM_ID,
  });
}

describe("adapters.codexAcpSmoke", () => {
  it("reuses one ACP session and answers through the Band MCP tools", async ({ skip }) => {
    if (process.env[OPT_IN_ENV] !== "1") {
      skip(`set ${OPT_IN_ENV}=1 to run against a local codex-acp`);
    }
    const adapter = new ACPClientAdapter({ command: ["codex-acp"], enableMcpTools: true });
    await using _stopped = { [Symbol.asyncDispose]: () => adapter.stop().catch(() => undefined) };
    const tools = new FakeTools();

    await adapter.onStarted("ACP Smoke Agent", "Smoke-test agent for codex-acp");
    await ask(adapter, tools, "What is 2 + 2? Reply with just the number.", true);
    await ask(adapter, tools, "What is 3 + 3? Reply with just the number.", false);

    expect(tools.messages).toEqual(expect.arrayContaining(["4", "6"]));
    const sessionIds = tools.events
      .filter((event) => event.messageType === "task")
      .map((event) => event.metadata?.acp_client_session_id)
      .filter((id) => typeof id === "string");
    expect(sessionIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sessionIds).size, "one reused ACP session").toBe(1);
    const sendCalls = tools.events.filter(
      (event) => event.messageType === "tool_call" && (event.metadata?.raw_input as { tool?: string } | undefined)?.tool === "band_send_message",
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
  });
});

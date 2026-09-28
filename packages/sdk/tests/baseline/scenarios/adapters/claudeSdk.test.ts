/**
 * Claude Agent SDK: the agent's Claude Code session is isolated from the
 * host's, with no tool that reaches other local sessions, no host plugins or
 * connectors, and the Band tools connected and listed from the first turn. A
 * reply the agent sends through band_send_message is its only reply.
 */
import { query, type McpServerStatus, type SDKAssistantMessage, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect } from "vitest";

import {
  DISALLOWED_CLAUDE_CODE_TOOLS,
  type ClaudeSDKQuery,
  type ClaudeSDKQueryParams,
} from "../../../../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, SEND_MESSAGE_TOOL_NAME } from "../../../../src/runtime/tools/schemas";
import { ADAPTER, buildClaudeSdk } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const INIT = { type: "system", subtype: "init" } as const satisfies Pick<SDKSystemMessage, "type" | "subtype">;
const MCP_CONNECTED = "connected" satisfies McpServerStatus["status"];
const REQUEST = "Reply with the single word: pineapple";
const SEND_MESSAGE_TOOL = `${MCP_TOOL_PREFIX}${SEND_MESSAGE_TOOL_NAME}`;

/** The real SDK `query`, passing every message through while keeping the last init, the tools called, and the options it was called with. */
function recordingQuery() {
  let init: SDKSystemMessage | undefined;
  let options: ClaudeSDKQueryParams["options"];
  const toolsCalled: string[] = [];
  const realQuery = query as ClaudeSDKQuery;

  return {
    get init() {
      return init;
    },
    get options() {
      return options;
    },
    toolsCalled,
    queryFn: async function* (params: ClaudeSDKQueryParams) {
      options = params.options;
      for await (const message of realQuery(params)) {
        // Init can be re-emitted; the last one describes the session that ran.
        if (message.type === INIT.type && message.subtype === INIT.subtype) {
          init = message as unknown as SDKSystemMessage;
        }
        if (message.type === "assistant") {
          for (const block of (message as unknown as SDKAssistantMessage).message.content) {
            if (block.type === "tool_use") toolsCalled.push(block.name);
          }
        }
        yield message;
      }
    } satisfies ClaudeSDKQuery,
  };
}

function assertToolIsolation(init: SDKSystemMessage | undefined, allowedTools: string[] | undefined): void {
  if (!init) throw new Error("the session emitted no system/init message");
  if (!allowedTools) throw new Error("the adapter registered no Band tools");
  const { tools, mcp_servers: mcpServers, plugins } = init;

  for (const denied of DISALLOWED_CLAUDE_CODE_TOOLS) {
    expect(tools, `init tools include the denied ${denied}`).not.toContain(denied);
  }
  expect(tools, "init lists every registered Band tool").toEqual(expect.arrayContaining(allowedTools));
  expect(mcpServers, "the Band MCP server alone, connected before the first turn").toEqual([
    expect.objectContaining({ name: MCP_SERVER_NAME, status: MCP_CONNECTED }),
  ]);
  expect(plugins, "no host plugins loaded").toEqual([]);
}

const tap = recordingQuery();

withAdapters(
  [ADAPTER.claudeSdk],
  scenarioId(CATEGORY.adapters, "claudeSdk.toolIsolation"),
  async ({ agents: [agent], room }) => {
    const sent = await Rooms.sendMention(room, agent!, REQUEST);
    assertReplied(await observeRoom(room).untilReply(agent!));
    assertDeliveryStatus(await observeAgent(agent!, room).untilProcessed(sent), DELIVERY_STATUS.processed);

    assertToolIsolation(tap.init, tap.options?.allowedTools);
  },
  { build: (_spec, options) => buildClaudeSdk(options, { queryFn: tap.queryFn }) },
);

const replyTap = recordingQuery();

withAdapters(
  [ADAPTER.claudeSdk],
  scenarioId(CATEGORY.adapters, "claudeSdk.repliesOnceThroughBandTool"),
  async ({ agents: [agent], room }) => {
    const sent = await Rooms.sendMention(room, agent!, `${REQUEST}. Send it with ${SEND_MESSAGE_TOOL_NAME}.`);
    const reply = await observeRoom(room).untilReply(agent!);
    assertReplied(reply);
    assertReplyContains(reply, "pineapple");
    // Every post lands before the turn is marked processed, so the stored history is complete here.
    assertDeliveryStatus(await observeAgent(agent!, room).untilProcessed(sent), DELIVERY_STATUS.processed);

    expect(replyTap.toolsCalled, "the agent replied through the Band tool").toContain(SEND_MESSAGE_TOOL);
    const replies = (await observeRoom(room).history(MESSAGE_TYPE.Text)).filter((message) => message.senderId === agent!.id);
    expect(replies.map((message) => message.content), "the agent's room messages").toEqual([reply.message.content]);
  },
  { build: (_spec, options) => buildClaudeSdk(options, { queryFn: replyTap.queryFn }) },
);

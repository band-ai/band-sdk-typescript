/**
 * Claude Agent SDK: the agent's Claude Code session is isolated from the
 * host's, with no tool that reaches other local sessions, no host plugins or
 * connectors, and the Band tools connected and listed from the first turn.
 */
import { query, type McpServerStatus, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect } from "vitest";

import {
  DISALLOWED_CLAUDE_CODE_TOOLS,
  type ClaudeSDKQuery,
  type ClaudeSDKQueryParams,
} from "../../../../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { MCP_SERVER_NAME } from "../../../../src/runtime/tools/schemas";
import { ADAPTER, buildClaudeSdk } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const INIT = { type: "system", subtype: "init" } as const satisfies Pick<SDKSystemMessage, "type" | "subtype">;
const MCP_CONNECTED = "connected" satisfies McpServerStatus["status"];
/** The path the CLI reports for a plugin bundled with it, which is not host config and loads on the CLI's own flags. */
const BUILTIN_PLUGIN_PATH = "builtin";
const REQUEST = "Reply with the single word: pineapple";

/** The real SDK `query`, passing every message through while keeping the last init and the options it was called with. */
function recordingQuery() {
  let init: SDKSystemMessage | undefined;
  let options: ClaudeSDKQueryParams["options"];
  const realQuery = query as ClaudeSDKQuery;

  return {
    get init() {
      return init;
    },
    get options() {
      return options;
    },
    queryFn: async function* (params: ClaudeSDKQueryParams) {
      options = params.options;
      for await (const message of realQuery(params)) {
        // Init can be re-emitted; the last one describes the session that ran.
        if (message.type === INIT.type && message.subtype === INIT.subtype) {
          init = message as unknown as SDKSystemMessage;
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
  expect(plugins.filter((plugin) => plugin.path !== BUILTIN_PLUGIN_PATH), "no host plugins loaded").toEqual([]);
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

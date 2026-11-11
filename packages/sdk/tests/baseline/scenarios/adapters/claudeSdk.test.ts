/**
 * Claude Agent SDK: the agent's Claude Code session is isolated from the
 * host's, with no tool that reaches other local sessions, no host plugins or
 * connectors, and the Band tools connected and listed from the first turn.
 * Every reply in the room was posted by a band_send_message the model made:
 * the turn's closing text is never relayed after it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { query, type McpServerStatus, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect } from "vitest";

import {
  DISALLOWED_CLAUDE_CODE_TOOLS,
  type ClaudeSDKQuery,
  type ClaudeSDKQueryParams,
} from "../../../../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { isFailedToolOutput } from "../../../../src/contracts/protocols";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../../../../src/contracts/toolSchemas";
import { parseToolPayload } from "../../../../src/converters/shared";
import { ADAPTER, buildClaudeSdk } from "../../toolkit/adapters";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { assertToolReply } from "../../toolkit/assertToolReply";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { eventsFrom, MESSAGE_TYPE, observeRoom, type ToolCallEvent, type ToolResultEvent } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { scenarioEvidence } from "../../toolkit/scenarioEvidence";

import { readText } from "../samples/files";
import { uniqueMarker } from "../samples/markers";
import { TOOL_REPLY_REQUEST, TOOL_REPLY_WORD } from "../samples/toolReply";

const INIT = { type: "system", subtype: "init" } as const satisfies Pick<SDKSystemMessage, "type" | "subtype">;
const MCP_CONNECTED = "connected" satisfies McpServerStatus["status"];
/** The path the CLI reports for a plugin bundled with it, which is not host config and loads on the CLI's own flags. */
const BUILTIN_PLUGIN_PATH = "builtin";
const REQUEST = `Reply with the single word: ${TOOL_REPLY_WORD}`;

/** A tool_result block's text: the SDK carries it as a string or as text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: { type?: string; text?: unknown }) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

/**
 * The real SDK `query`, passing every message through while keeping the last
 * init, the tools called, the options it was called with, each Band tool's
 * call and result as the model saw them, and the closing text.
 */
function recordingQuery() {
  let init: SDKSystemMessage | undefined;
  let options: ClaudeSDKQueryParams["options"];
  let closingText: string | undefined;
  const toolsCalled: string[] = [];
  const bandCalls: ToolCallEvent[] = [];
  const bandResults: ToolResultEvent[] = [];
  const realQuery = query as ClaudeSDKQuery;

  return {
    get init() {
      return init;
    },
    get options() {
      return options;
    },
    get closingText() {
      return closingText;
    },
    toolsCalled,
    bandCalls,
    bandResults,
    queryFn: async function* (params: ClaudeSDKQueryParams) {
      options = params.options;
      for await (const message of realQuery(params)) {
        // Init can be re-emitted; the last one describes the session that ran.
        if (message.type === INIT.type && message.subtype === INIT.subtype) {
          init = message;
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "tool_use") continue;
            toolsCalled.push(block.name);
            if (block.name.startsWith(MCP_TOOL_PREFIX)) {
              const name = block.name.slice(MCP_TOOL_PREFIX.length);
              bandCalls.push({ id: block.id, toolCallId: block.id, name, args: block.input as Record<string, unknown> });
            }
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== "tool_result") continue;
            const call = bandCalls.find((candidate) => candidate.toolCallId === block.tool_use_id);
            if (!call) continue;
            const text = toolResultText(block.content);
            const output = parseToolPayload(text) ?? text;
            bandResults.push({
              id: block.tool_use_id, name: call.name, toolCallId: block.tool_use_id, output,
              isError: block.is_error === true || isFailedToolOutput(output),
            });
          }
        }
        if (message.type === "result" && message.subtype === "success") {
          closingText = message.result;
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

const replyTap = recordingQuery();

withAdapters(
  [ADAPTER.claudeSdk],
  scenarioId(CATEGORY.adapters, "claudeSdk.repliesOnceThroughBandTool"),
  async ({ agents: [agent], room }) => {
    const evidence = scenarioEvidence(room, agent!);
    await evidence.run(async () => {
      const sent = await Rooms.sendMention(room, agent!, TOOL_REPLY_REQUEST);
      const [reply, delivery] = await Promise.all([
        observeRoom(room).untilReply(agent!), observeAgent(agent!, room).untilProcessed(sent),
      ]);
      const { bandCalls, bandResults, closingText } = replyTap;
      evidence.record({ sent, reply, delivery, bandCalls, bandResults, closingText });
      // Every post lands before the turn is marked processed, so the stored history is complete here.
      const stored = await evidence.read();
      assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
      assertReplied(reply);
      assertReplyContains(reply, TOOL_REPLY_WORD);
      // Without closing text there is nothing to relay, and the run would prove nothing.
      expect(closingText?.trim(), "the turn's closing text, which must not be relayed").toBeTruthy();
      const recipientId = stored.messages.find((message) => message.id === sent.id)?.senderId;
      if (!recipientId) throw new Error("the request's stored sender is missing");
      assertToolReply(bandCalls, bandResults, stored.replies, { marker: TOOL_REPLY_WORD, senderId: agent!.id, recipientId });
    });
  },
  { build: (_spec, options) => buildClaudeSdk(options, { queryFn: replyTap.queryFn }) },
);

const MARKER_TOOL = "write_marker";
const MARKER_FILE = "custom-tool-marker.txt";
const markerTap = recordingQuery();

withAdapters(
  [ADAPTER.claudeSdk],
  scenarioId(CATEGORY.adapters, "claudeSdk.customToolsAct"),
  async ({ agents: [agent], room, cells: [cell] }) => {
    const delivery = observeAgent(agent!, room);
    for (const marker of [uniqueMarker("first"), uniqueMarker("second")]) {
      const toolOffset = markerTap.toolsCalled.length;
      const sent = await Rooms.sendMention(room, agent!, `Call ${MCP_TOOL_PREFIX}${MARKER_TOOL} with marker="${marker}". Use that tool to save the marker; do not write files with other tools.`);
      assertDeliveryStatus(await delivery.untilProcessed(sent), DELIVERY_STATUS.processed);
      expect(delivery.history(sent), "first-attempt delivery").not.toContain(DELIVERY_STATUS.failed);
      expect(markerTap.toolsCalled.slice(toolOffset), "the portable MCP tool ran this turn").toContain(`${MCP_TOOL_PREFIX}${MARKER_TOOL}`);
      expect(await readText(join(cell!.workDir, MARKER_FILE))).toBe(marker);
    }
    expect(await eventsFrom(room, MESSAGE_TYPE.Error, agent!)).toEqual([]);
  },
  { build: (_spec, options) => buildClaudeSdk(options, {
    queryFn: markerTap.queryFn,
    customTools: [{
      name: MARKER_TOOL,
      description: "Save the supplied marker",
      schema: z.object({ marker: z.string() }),
      effect: "act",
      handler: async ({ marker }) => {
        await writeFile(join(options.workDir, MARKER_FILE), String(marker));
        return { ok: true };
      },
    }],
  }) },
);

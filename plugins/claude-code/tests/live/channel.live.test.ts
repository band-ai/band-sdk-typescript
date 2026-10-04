/**
 * The built plugin against the live platform, with an MCP client in Claude
 * Code's place and no LLM: what Band delivers is pushed, what the client calls
 * posts back, and the agent is held by one session at a time.
 */
import { describe, expect, it } from "vitest";

import { CHANNEL_CAPABILITY, EXIT_FAILED, EXIT_OK } from "../../src/channel";
import { Agents, type AgentIdentity } from "../../../../packages/sdk/tests/baseline/toolkit/agents";
import { DELIVERY_STATUS, observeAgent } from "../../../../packages/sdk/tests/baseline/toolkit/observeDelivery";
import { observeRoom, REPLY_WAIT } from "../../../../packages/sdk/tests/baseline/toolkit/observeMessages";
import { Rooms, type Room } from "../../../../packages/sdk/tests/baseline/toolkit/rooms";
import { PluginProcess } from "./support/pluginProcess";

const CONFLICT_CODE = "connection_conflict";

async function agentInRoom(label: string): Promise<{ identity: AgentIdentity; room: Room }> {
  const identity = await Agents.provision("claude-code", label);
  const room = await Rooms.create();
  await Rooms.addParticipant(room, identity);
  return { identity, room };
}

/** Resolves once `plugin` is connected to Band: a mention posted now reaches it. */
async function expectServing(plugin: PluginProcess, room: Room, identity: AgentIdentity, text: string): Promise<void> {
  const sent = await Rooms.sendMention(room, identity, text);
  expect((await plugin.pushOf(sent.id)).meta.room_id).toBe(room.id);
}

describe("the Claude Code plugin on the live platform", () => {
  it("pushes a mention, posts Claude's reply, and frees the agent when Claude Code exits", async () => {
    const { identity, room } = await agentInRoom("session");
    const plugin = await PluginProcess.start(identity);

    expect(plugin.client.getServerCapabilities()?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    const { tools } = await plugin.client.listTools();
    expect(tools.find((tool) => tool.name === "band_send_message")?.inputSchema.required).toContain("room_id");

    const sent = await Rooms.sendMention(room, identity, "ping");
    const push = await plugin.pushOf(sent.id);
    expect(push.meta).toMatchObject({ room_id: room.id, message_id: sent.id, sender_role: "owner", sender_type: "User" });
    expect((await observeAgent(identity, room).untilProcessed(sent)).status).toBe(DELIVERY_STATUS.processed);

    const reply = await plugin.client.callTool({
      name: "band_send_message",
      arguments: { room_id: push.meta.room_id, content: "pong", mentions: [push.meta.sender_id] },
    });
    expect(reply.isError).toBeFalsy();
    // The platform stores the reply behind its mention token.
    const posted = await observeRoom(room).untilReplyMatching(identity, (message) => message.content.endsWith(" pong"));
    expect(posted.kind).toBe(REPLY_WAIT.reply);

    expect((await plugin.leave()).code).toBe(EXIT_OK);
    await using next = await PluginProcess.start(identity);
    await expectServing(next, room, identity, "still there?");
  });

  it("refuses a second session while the first holds the agent", async () => {
    const { identity, room } = await agentInRoom("conflict");
    await using first = await PluginProcess.start(identity);
    await expectServing(first, room, identity, "first");

    const second = await PluginProcess.start(identity);
    const exit = await second.exited;

    expect(exit.code).toBe(EXIT_FAILED);
    expect(exit.stderr).toContain(CONFLICT_CODE);
    await expectServing(first, room, identity, "first still");
  });
});

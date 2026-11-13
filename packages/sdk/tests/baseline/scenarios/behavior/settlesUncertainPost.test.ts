/**
 * A reply post whose outcome Band leaves unknown is settled by reading the room
 * back, so the room holds it exactly once: a post Band stored is not sent
 * again, and one it never saw is resent. The fault is injected at the agent's
 * own HTTP boundary; Band, the runtime and the delivery are all real.
 */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { FaultyPosts, POST_FAULT, type PostFault } from "../../toolkit/faultyPosts";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { scenarioEvidence } from "../../toolkit/scenarioEvidence";

const SCENARIO = scenarioId(CATEGORY.behavior, "settlesUncertainPost");
const REPLY = "settled-reply-7f3a";

const replying = new GenericAdapter(async ({ message, tools }) => {
  await tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: REPLY, mentions: [message.senderId] });
});

describe(SCENARIO, () => {
  it.each<{ fault: PostFault; posts: number }>([
    { fault: POST_FAULT.lostAfterCommit, posts: 1 },
    { fault: POST_FAULT.unavailableBeforeCommit, posts: 2 },
  ])("leaves exactly one reply in the room after $fault, in $posts post(s)", async ({ fault, posts }) => {
    await using identity = await Agents.provision(SCENARIO, fault);
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const faulty = await FaultyPosts.create(identity, fault);
    await using _running = await Agents.runAs(identity, replying, { restApi: faulty.rest });
    const evidence = scenarioEvidence(room, identity);

    await evidence.run(async () => {
      const sent = await Rooms.sendMention(room, identity, "Reply once.");
      const delivery = await observeAgent(identity, room).untilProcessed(sent);
      const { replies } = await evidence.read();
      evidence.record({ sent, delivery, attempts: faulty.attempts });

      assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
      expect(faulty.attempts, "message POSTs the agent attempted").toBe(posts);
      // Band stores the reply with the mention's token prepended.
      expect(replies.map(({ content }) => content), "the agent's replies Band stored").toEqual([expect.stringContaining(REPLY)]);
    });
  });
});

import type { AgentIdentity } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { Rooms, type Room } from "../../toolkit/rooms";

/**
 * Says `request` to `agent` in `room` and waits until the turn is done and its
 * durable state (events, tool calls) is saved, ready to read from `history()`.
 */
export async function takeTurn(room: Room, agent: AgentIdentity, request: string): Promise<void> {
  const sent = await Rooms.sendMention(room, agent, request);
  assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);
}

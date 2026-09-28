/**
 * An agent's own link sees the whole room and contact lifecycle as validated
 * platform events, in order: added to a room, a participant joining, a
 * mention, a contact request, the participant leaving, and removal.
 */
import { describe, expect, it } from "vitest";

import type { BandLink } from "../../../../src/platform/BandLink";
import type { PlatformEvent } from "../../../../src/platform/events";
import { Agents } from "../../toolkit/agents";
import { Rooms } from "../../toolkit/rooms";

const EVENT_TIMEOUT_MS = 15_000;

async function nextEvent<T extends PlatformEvent["type"]>(link: BandLink, type: T): Promise<Extract<PlatformEvent, { type: T }>> {
  const event = await link.nextEvent(AbortSignal.timeout(EVENT_TIMEOUT_MS));
  expect(event?.type, `the next event is ${type}`).toBe(type);
  return event as Extract<PlatformEvent, { type: T }>;
}

describe("inspection.eventValidation", () => {
  it("delivers the room and contact lifecycle to the agent's link", async () => {
    await using receiver = await Agents.provision("event-validation", "receiver");
    await using sender = await Agents.provision("event-validation", "sender");
    await using participant = await Agents.provision("event-validation", "participant");
    await using connection = await Agents.connect(receiver);
    const { link } = connection;
    await link.subscribeAgentRooms();
    await link.subscribeAgentContacts();

    await using room = await Rooms.create();
    await Rooms.addParticipant(room, receiver);
    const roomAdded = await nextEvent(link, "room_added");
    expect(roomAdded.roomId).toBe(room.id);
    expect(roomAdded.payload).toMatchObject({ inserted_at: expect.any(String), updated_at: expect.any(String) });

    await link.subscribeRoom(room.id);
    await Rooms.addParticipant(room, participant);
    const joined = await nextEvent(link, "participant_added");
    expect(joined.payload).toMatchObject({ id: participant.id, name: expect.any(String), type: expect.any(String) });

    const sent = await Rooms.sendMention(room, receiver, "event validation");
    const message = await nextEvent(link, "message_created");
    expect(message.payload.id).toBe(sent.id);
    expect(message.payload.metadata?.mentions).toEqual(expect.any(Array));
    expect(message.payload.attachments).toEqual(expect.any(Array));
    expect(message.raw?.id).toBe(sent.id);

    await Agents.requestContact(sender, receiver);
    const contact = await nextEvent(link, "contact_request_received");
    expect(contact.payload).toMatchObject({ id: expect.any(String), from_handle: expect.any(String), inserted_at: expect.any(String) });

    await Rooms.removeParticipant(room, participant);
    const left = await nextEvent(link, "participant_removed");
    expect(left.payload).toMatchObject({ id: participant.id, name: expect.any(String), type: expect.any(String) });

    await Rooms.removeParticipant(room, receiver);
    const roomRemoved = await nextEvent(link, "room_removed");
    expect(roomRemoved.roomId).toBe(room.id);
    expect(roomRemoved.payload.id).toBe(room.id);
  });
});

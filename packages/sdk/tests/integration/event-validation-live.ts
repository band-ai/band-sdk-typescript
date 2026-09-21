/**
 * Live E2E: validates the production Phoenix event lifecycle through
 * BandLink and band-sdk-core's inbound normalization boundary.
 *
 * Run: BAND_API_KEY_USER=... npx tsx tests/integration/event-validation-live.ts
 */
import { randomUUID } from "node:crypto";

import { BandClient } from "@band-ai/rest-client";

import { BandLink } from "../../src/platform/BandLink";
import type { PlatformEvent } from "../../src/platform/events";
import { FernRestAdapter } from "../../src/rest";
import {
  createReporter,
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sweepOrphans,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "event-validation";
const EVENT_TIMEOUT_MS = 15_000;

const { assert, summarize } = createReporter();

async function nextEvent<TType extends PlatformEvent["type"]>(
  link: BandLink,
  expectedType: TType,
): Promise<Extract<PlatformEvent, { type: TType }>> {
  const event = await link.nextEvent(AbortSignal.timeout(EVENT_TIMEOUT_MS));
  if (!event) {
    throw new Error(`Timed out waiting for ${expectedType}`);
  }
  if (event.type !== expectedType) {
    throw new Error(`Expected ${expectedType}, got ${event.type}`);
  }
  return event as Extract<PlatformEvent, { type: TType }>;
}

async function main() {
  console.log("event-validation === live Core-validated WebSocket lifecycle ===");
  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);
  await sweepOrphans(userClient, runId);

  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let receiverLink: BandLink | null = null;

  try {
    const receiver = await provisionAgent(userClient, runId, TEST_NAME, "receiver");
    provisioned.push(receiver);
    const sender = await provisionAgent(userClient, runId, TEST_NAME, "sender");
    provisioned.push(sender);
    const participant = await provisionAgent(userClient, runId, TEST_NAME, "participant");
    provisioned.push(participant);

    const receiverRest = new FernRestAdapter(
      new BandClient({ baseUrl: restUrl, apiKey: receiver.apiKey }),
    );
    const senderRest = new FernRestAdapter(
      new BandClient({ baseUrl: restUrl, apiKey: sender.apiKey }),
    );
    const receiverIdentity = await receiverRest.getAgentMe();
    if (!receiverIdentity.handle) {
      throw new Error("Receiver identity has no handle");
    }

    receiverLink = new BandLink({
      agentId: receiver.id,
      apiKey: receiver.apiKey,
      wsUrl,
      restApi: receiverRest,
    });
    await receiverLink.connect();
    await receiverLink.subscribeAgentRooms();
    await receiverLink.subscribeAgentContacts();

    const chat = await senderRest.createChat();
    roomIds.push(chat.id);
    await senderRest.addChatParticipant(chat.id, {
      participantId: receiver.id,
      role: "member",
    });
    const roomAdded = await nextEvent(receiverLink, "room_added");
    assert(
      "receiver observes room_added with Core-normalized timestamps",
      roomAdded.roomId === chat.id
        && typeof roomAdded.payload.inserted_at === "string"
        && typeof roomAdded.payload.updated_at === "string",
      `event=${JSON.stringify(roomAdded)}`,
    );

    await receiverLink.subscribeRoom(chat.id);
    await senderRest.addChatParticipant(chat.id, {
      participantId: participant.id,
      role: "member",
    });
    const participantAdded = await nextEvent(receiverLink, "participant_added");
    assert(
      "receiver observes participant_added with Core-required identity",
      participantAdded.payload.id === participant.id
        && typeof participantAdded.payload.name === "string"
        && typeof participantAdded.payload.type === "string",
      `event=${JSON.stringify(participantAdded)}`,
    );

    const sent = await senderRest.createChatMessage(chat.id, {
      content: `@${receiverIdentity.handle} Core validation live flow`,
      mentions: [{ id: receiver.id, handle: receiverIdentity.handle }],
    });
    const message = await nextEvent(receiverLink, "message_created");
    assert(
      "receiver observes a normalized mentioned message and its raw payload",
      message.payload.id === sent.id
        && Array.isArray(message.payload.metadata?.mentions)
        && Array.isArray(message.payload.attachments)
        && message.raw?.id === sent.id,
      `event=${JSON.stringify(message)}`,
    );

    await senderRest.addContact({ handle: receiverIdentity.handle });
    const contact = await nextEvent(receiverLink, "contact_request_received");
    assert(
      "receiver observes contact_request_received",
      typeof contact.payload.id === "string"
        && typeof contact.payload.from_handle === "string"
        && typeof contact.payload.inserted_at === "string",
      `event=${JSON.stringify(contact)}`,
    );

    await senderRest.removeChatParticipant(chat.id, participant.id);
    const participantRemoved = await nextEvent(receiverLink, "participant_removed");
    assert(
      "receiver observes participant_removed with Core-required identity",
      participantRemoved.payload.id === participant.id
        && typeof participantRemoved.payload.name === "string"
        && typeof participantRemoved.payload.type === "string",
      `event=${JSON.stringify(participantRemoved)}`,
    );

    await senderRest.removeChatParticipant(chat.id, receiver.id);
    const roomRemoved = await nextEvent(receiverLink, "room_removed");
    assert(
      "receiver observes room_removed after the full lifecycle",
      roomRemoved.roomId === chat.id && roomRemoved.payload.id === chat.id,
      `event=${JSON.stringify(roomRemoved)}`,
    );
  } finally {
    if (receiverLink) {
      await receiverLink.disconnect().catch((error: unknown) => {
        console.warn("event-validation Failed to disconnect receiver link:", error);
      });
    }
    await reapProvisioned(
      userClient,
      restUrl,
      userApiKey,
      provisioned,
      roomIds,
      "event-validation",
    );
  }

  summarize("event-validation");
}

main().catch((error) => {
  console.error("event-validation FAILED:", error);
  process.exit(1);
});

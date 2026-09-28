/**
 * A running agent is routed a room message and a contact request over its
 * real channel joins. The agent joins the room before it starts, so it gets
 * the message only by subscribing to its existing rooms on connect.
 */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { RecordLog } from "../../../testUtils";
import type { PlatformEvent } from "../../../../src/platform/events";
import type { ContactEventStrategy } from "../../../../src/runtime/types";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { waitFor } from "../../toolkit/waitFor";

const SCENARIO = scenarioId(CATEGORY.inspection, "topicNaming");
const CONTACT_REQUEST_RECEIVED: PlatformEvent["type"] = "contact_request_received";
/** Contact events go to a callback, where the test records them. */
const CALLBACK_STRATEGY: ContactEventStrategy = "callback";

const ROUTE_TIMEOUT_MS = 15_000;
const GREETING = "hello from the topic-naming check";

describe(SCENARIO, () => {
  it("routes a room message and a contact request to the running agent", async () => {
    await using receiver = await Agents.provision(SCENARIO, "receiver");
    await using sender = await Agents.provision(SCENARIO, "sender");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, receiver);

    const messages = new RecordLog<string>();
    const contactEvents = new RecordLog<string>();
    await using _running = await Agents.runAs(
      receiver,
      new GenericAdapter(async ({ message }) => messages.record(message.content)),
      { contactConfig: { strategy: CALLBACK_STRATEGY, onEvent: async (event) => contactEvents.record(event.type) } },
    );

    await Rooms.sendMention(room, receiver, GREETING);
    const greeting = await waitFor(messages, () => messages.entries.find((content) => content.includes(GREETING)), ROUTE_TIMEOUT_MS);
    expect(greeting, "the message arrived over the room joins").toBeDefined();

    await Agents.requestContact(sender, receiver);
    const request = await waitFor(
      contactEvents,
      () => contactEvents.entries.find((type) => type === CONTACT_REQUEST_RECEIVED),
      ROUTE_TIMEOUT_MS,
    );
    expect(request, "the contact request arrived over the contacts join").toBeDefined();
  });
});

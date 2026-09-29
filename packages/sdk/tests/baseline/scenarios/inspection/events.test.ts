/**
 * The events an agent emits — its thoughts, tasks and errors — as they are
 * stored in the room and read back per sender. Each request drives exactly the
 * requested `band_send_event` calls, and each assertion looks for the injected
 * marker, never for an event's bare presence: an adapter reports an `error`
 * event of its own when a provider turn fails, so presence alone can be
 * satisfied by a failure. Every read follows `untilProcessed`, once the turn's
 * events are saved.
 *
 * Pinned to Anthropic: the readers are adapter-agnostic, so one reliable driver
 * is enough, and a model that only sometimes chooses to call the tool would make
 * this about the model. It is the driver band-sdk-python's events smokes use too.
 */
import { expect } from "vitest";

import { ADAPTER } from "../../toolkit/adapters";
import { MESSAGE_TYPE, eventsFrom } from "../../toolkit/observeMessages";
import { withAdapters, type Cast } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { EMITTED_EVENT_TYPES, emitEventRequest, emitEventsRequest, emitThoughtsRequest } from "../samples/events";
import { EXACT_TOOLS_PROMPT } from "../samples/exactTools";
import { uniqueMarker } from "../samples/markers";
import { takeTurn } from "../samples/turns";

const withAnthropic = (name: string, body: (cast: Cast) => Promise<void>) =>
  withAdapters([ADAPTER.anthropic], scenarioId(CATEGORY.inspection, `events.${name}`), body, { prompt: EXACT_TOOLS_PROMPT });

/** An event whose content carries `marker`. */
const carrying = (marker: string) => expect.objectContaining({ content: expect.stringContaining(marker) });

for (const type of EMITTED_EVENT_TYPES) {
  withAnthropic(`emitted.${type}`, async ({ agents: [agent], room }) => {
    const marker = uniqueMarker(type);
    await takeTurn(room, agent!, emitEventRequest(type, marker));

    expect(await eventsFrom(room, type, agent!)).toContainEqual(carrying(marker));
  });
}

withAnthropic("allTypesOneTurn", async ({ agents: [agent], room }) => {
  const emissions = EMITTED_EVENT_TYPES.map((type) => ({ type, marker: uniqueMarker(type) }));
  await takeTurn(room, agent!, emitEventsRequest(emissions));

  for (const { type, marker } of emissions) {
    expect(await eventsFrom(room, type, agent!), `${type} events`).toContainEqual(carrying(marker));
  }
});

withAnthropic("multipleThoughts", async ({ agents: [agent], room }) => {
  const markers = [uniqueMarker("first"), uniqueMarker("second")];
  await takeTurn(room, agent!, emitThoughtsRequest(markers));

  const thoughts = await eventsFrom(room, MESSAGE_TYPE.Thought, agent!);
  expect(thoughts.length, "thoughts emitted in the turn").toBeGreaterThanOrEqual(markers.length);
  for (const marker of markers) {
    expect(thoughts).toContainEqual(carrying(marker));
  }
});

withAnthropic("senderIsolation", async ({ agents: [agent], room, cells: [cell] }) => {
  await using other = await cell!.running("other");
  await Rooms.addParticipant(room, other.identity);
  const [mine, theirs] = [uniqueMarker("mine"), uniqueMarker("theirs")];

  await takeTurn(room, agent!, emitEventRequest(MESSAGE_TYPE.Thought, mine));
  await takeTurn(room, other.identity, emitEventRequest(MESSAGE_TYPE.Thought, theirs));

  const [agentThoughts, otherThoughts] = await Promise.all([
    eventsFrom(room, MESSAGE_TYPE.Thought, agent!),
    eventsFrom(room, MESSAGE_TYPE.Thought, other.identity),
  ]);
  expect(agentThoughts, "the first agent's thoughts").toContainEqual(carrying(mine));
  expect(agentThoughts, "the first agent's thoughts").not.toContainEqual(carrying(theirs));
  expect(otherThoughts, "the other agent's thoughts").toContainEqual(carrying(theirs));
  expect(otherThoughts, "the other agent's thoughts").not.toContainEqual(carrying(mine));
});

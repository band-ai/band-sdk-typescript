/**
 * Tool trajectories don't mix: a room's stored tool calls, read per sender,
 * hold only that sender's calls; one agent's calls in two rooms stay in their
 * own room; and a turn's calls are told apart from an earlier turn's. A coding
 * agent in two rooms works in two folders: a file it writes in one room is
 * absent from the other. Each
 * request drives an opaque lookup with a distinct key, so a leak shows as a
 * key where it doesn't belong. Every read follows `untilProcessed`, once the
 * turn's tool calls are saved.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { DEFAULT_WORKSPACE_DIRECTORY } from "../../../../src/adapters/shared/roomWorkspace";
import type { AgentIdentity } from "../../toolkit/agents";
import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CAPABILITY, CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type Room } from "../../toolkit/rooms";
import { readText } from "../samples/files";
import { KEY, WITH_LOOKUP, lookupCalls, lookupRequest, type LookupCall } from "../samples/lookupTool";
import { uniqueMarker } from "../samples/markers";
import { takeTurn } from "../samples/turns";

const lookUp = (room: Room, agent: AgentIdentity, key: string) => takeTurn(room, agent, lookupRequest(key));

// Which keys were looked up, not how often: a repeated lookup is no leak.
const keySet = (calls: LookupCall[]) => new Set(calls.map((call) => call.key));

const keysOf = async (room: Room, sender: AgentIdentity) => keySet(await lookupCalls(room, sender));

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perSender"),
  async ({ agent, room, cell }) => {
    await using other = await cell.running("other");
    await Rooms.addParticipant(room, other.identity);

    await lookUp(room, agent, KEY.alpha);
    await lookUp(room, other.identity, KEY.beta);

    const [agentKeys, otherKeys] = await Promise.all([keysOf(room, agent), keysOf(room, other.identity)]);
    expect(agentKeys, "the first agent's calls").toEqual(new Set([KEY.alpha]));
    expect(otherKeys, "the other agent's calls").toEqual(new Set([KEY.beta]));
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perRoom"),
  async ({ agent, room }) => {
    await using second = await Rooms.create();
    await Rooms.addParticipant(second, agent);

    await Promise.all([lookUp(room, agent, KEY.alpha), lookUp(second, agent, KEY.beta)]);

    const [firstKeys, secondKeys] = await Promise.all([keysOf(room, agent), keysOf(second, agent)]);
    expect(firstKeys, "the first room's calls").toEqual(new Set([KEY.alpha]));
    expect(secondKeys, "the second room's calls").toEqual(new Set([KEY.beta]));
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perTurn"),
  async ({ agent, room }) => {
    await lookUp(room, agent, KEY.alpha);
    const earlier = new Set((await lookupCalls(room, agent)).map((call) => call.id));

    await lookUp(room, agent, KEY.beta);
    const calls = await lookupCalls(room, agent);

    expect(keySet(calls), "the room holds both turns' calls").toEqual(new Set([KEY.alpha, KEY.beta]));
    expect(
      keySet(calls.filter((call) => !earlier.has(call.id))),
      "the second turn's calls, told apart from the first's",
    ).toEqual(new Set([KEY.beta]));
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perRoomWorkspace"),
  async ({ agent, room, cell }) => {
    await using second = await Rooms.create();
    await Rooms.addParticipant(second, agent);
    const workspace = (target: Room) => join(cell.workDir, DEFAULT_WORKSPACE_DIRECTORY, target.id);
    const fileName = `${uniqueMarker("room-file")}.txt`;
    const contents = uniqueMarker("CONTENTS");
    const written = uniqueMarker("WRITTEN");
    const present = uniqueMarker("PRESENT");
    const absent = uniqueMarker("ABSENT");

    await Rooms.sendMention(
      room,
      agent,
      `Create a file named ${fileName} in your current working directory containing exactly ${contents}, then reply with exactly ${written}.`,
    );
    assertReplied(await observeRoom(room).untilReplyMatching(agent, (message) => message.content.includes(written)));
    expect(await readText(join(workspace(room), fileName)), "the file landed in the first room's workspace").toContain(contents);

    await Rooms.sendMention(
      second,
      agent,
      `Check with a tool whether a file named ${fileName} exists in your current working directory. Reply with exactly ${present} if it does, or exactly ${absent} if it does not.`,
    );
    const answer = await observeRoom(second).untilReplyMatching(agent, ({ content }) => content.includes(present) || content.includes(absent));
    assertReplied(answer);
    expect(answer.message.content, "the second room's process does not see the first room's file").toContain(absent);
    expect(existsSync(workspace(second)), "the second room got its own workspace").toBe(true);
    expect(existsSync(join(workspace(second), fileName)), "nothing wrote the file into the second room's workspace").toBe(false);
  },
  { supports: [CAPABILITY.roomWorkspaces] },
);

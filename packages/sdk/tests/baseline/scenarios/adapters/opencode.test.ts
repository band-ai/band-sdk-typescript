/**
 * OpenCode through a working day, one agent across several rooms: it starts
 * cold in two rooms at once with Band's tools in both, takes an approved and a
 * rejected shell command in parallel, keeps each room's conversation to that
 * room, and after leaving every room starts again with its tools in a new one.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import type { TOOL_MODELS } from "../../../../src/runtime/tools/schemas";
import { ADAPTER } from "../../toolkit/adapters";
import type { AgentIdentity } from "../../toolkit/agents";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom, toolCalls } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type Room } from "../../toolkit/rooms";
import {
  OUTCOME,
  PATIENT_WAIT_MS,
  decide,
  dialectFor,
  requestGatedWrite,
  untilRequested,
  untilShown,
  type Decision,
  type InRoom,
} from "../samples/approvals";
import { uniqueMarker } from "../samples/markers";
import { takeTurn } from "../samples/turns";

const PROMPT = "Keep responses short. Use your tools when asked.";
const PARTICIPANTS_TOOL = "band_get_participants" satisfies keyof typeof TOOL_MODELS;
const TEXT = "utf8";

const dialect = dialectFor(ADAPTER.opencode);

/** Lists the room's participants through Band's tool: the call only runs if the tools were registered for this turn. */
async function listsParticipants(agent: AgentIdentity, room: Room): Promise<void> {
  const marker = uniqueMarker("roster");
  await takeTurn(room, agent, `Use your ${PARTICIPANTS_TOOL} tool to list who is in this room, then reply with ${marker} followed by their names.`);
  await untilShown({ agent, room }, marker);
  const called = (await toolCalls(room, agent)).map((call) => call.name);
  // OpenCode names an MCP tool after its server, so the Band tool's name is a suffix.
  expect(called.some((name) => name.endsWith(PARTICIPANTS_TOOL)), `the calls that fired: ${called.join(", ") || "none"}`).toBe(true);
}

/** One room's shell request, and how the user decides it. */
interface GatedWrite extends InRoom {
  decision: Decision;
  marker: string;
  target: string;
}

async function runsGatedWrite(write: GatedWrite): Promise<void> {
  await requestGatedWrite(write, write.marker, write.target);
  await decide(write, dialect, write.decision, await untilRequested(write, dialect));
}

async function recallsItsOwnCommand({ agent, room, marker }: GatedWrite, other: GatedWrite): Promise<void> {
  await Rooms.sendMention(room, agent, "Which marker was in the shell command I asked you to run in this room? Reply with just that marker.");
  const reply = await observeRoom(room).untilReply(agent);
  assertReplied(reply);
  assertReplyContains(reply, marker);
  expect(reply.message.content, "the other room's conversation stayed there").not.toContain(other.marker);
}

withAdapters(
  [ADAPTER.opencode],
  scenarioId(CATEGORY.adapters, "opencode.workday"),
  async ({ agents: [agent], room: first, cells: [cell] }) => {
    await using second = await Rooms.create();
    await Rooms.addParticipant(second, agent!);

    // The agent starts its OpenCode client on its first turn, so both rooms' first turns race that start.
    await Promise.all([first, second].map((room) => listsParticipants(agent!, room)));

    const gatedWrite = (room: Room, decision: Decision): GatedWrite => ({
      agent: agent!,
      room,
      decision,
      marker: uniqueMarker(decision),
      target: join(cell!.workDir, `${decision}.txt`),
    });
    const approved = gatedWrite(first, OUTCOME.approve);
    const rejected = gatedWrite(second, OUTCOME.reject);
    await Promise.all([approved, rejected].map(runsGatedWrite));
    expect((await readFile(approved.target, TEXT)).trim(), "the approved command ran").toBe(approved.marker);
    expect(existsSync(rejected.target), "the rejected command did not run").toBe(false);

    await Promise.all([recallsItsOwnCommand(approved, rejected), recallsItsOwnCommand(rejected, approved)]);

    // Leaving its last room shuts the client down; the next room starts it, and registers the tools, again.
    await Promise.all([first, second].map((room) => Rooms.removeParticipant(room, agent!)));
    await using third = await Rooms.create();
    await Rooms.addParticipant(third, agent!);
    await listsParticipants(agent!, third);
  },
  {
    prompt: PROMPT,
    build: (_spec, options) => dialect.build({ ...options, reportToolCalls: true }, PATIENT_WAIT_MS),
  },
);

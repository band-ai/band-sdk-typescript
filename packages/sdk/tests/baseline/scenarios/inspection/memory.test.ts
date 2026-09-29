/**
 * Memory, read at two layers. The call layer is what the agent asked its memory
 * tools for, from its stored tool-call events; the store layer is what the
 * platform kept, listed as the agent's own REST identity. Each memory carries a
 * unique marker, so the reads are collision-free, and each agent is steered to
 * make exactly the requested calls. The last two scenarios need no agent: they
 * are the platform's own answer to an organization scope this account can't use.
 * Every read follows `untilProcessed`, once the turn's calls and memories are saved.
 */
import { Band } from "@band-ai/rest-client";
import { describe, expect, it } from "vitest";

import {
  MEMORY_LIST_SCOPE,
  MEMORY_SEGMENT,
  MEMORY_STATUS,
  MEMORY_STORE_SCOPE,
  MEMORY_SYSTEM,
  MEMORY_TYPE,
  ORGANIZATION_SCOPE_REJECTED_CODE,
} from "../../../../src/contracts/memory";
import { MEMORY_TOOL_NAMES } from "../../../../src/runtime/tools/schemas";
import { Agents } from "../../toolkit/agents";
import { assertToolFired } from "../../toolkit/assertMessages";
import { liveRun } from "../../toolkit/liveRun";
import { toolCalls } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { uniqueMarker } from "../samples/markers";
import {
  MEMORY_TOOL,
  NOTE,
  ORGANIZATION_ID_FIELD,
  WITH_MEMORY,
  WITH_MEMORY_SECRETARY,
  inferredSubjectRequest,
  memoryCalls,
  memoryLike,
  rejection,
  storeListGetRequest,
  storeRequest,
  storeSubjectRequest,
  storeThenArchiveRequest,
  storeThenSupersedeRequest,
  storeTwoTiersRequest,
  storedMemories,
} from "../samples/memory";
import { takeTurn } from "../samples/turns";

const memory = (name: string) => scenarioId(CATEGORY.inspection, `memory.${name}`);

/** The agent's own private memories that carry `marker`. */
const privateWith = (marker: string) => ({ scope: MEMORY_LIST_SCOPE.agent, content_query: marker });

perAdapter(
  memory("stored"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("mem");
    await takeTurn(room, agent, storeRequest(marker));

    assertToolFired(await memoryCalls(room, agent), MEMORY_TOOL.store, { content: marker, ...NOTE });
    expect(await storedMemories(agent, privateWith(marker))).toContainEqual(memoryLike(marker, NOTE));
  },
  WITH_MEMORY,
);

perAdapter(
  memory("subjectScope"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("subjmem");
    await takeTurn(room, agent, storeSubjectRequest(marker, agent.id));

    const about = { scope: MEMORY_STORE_SCOPE.subject, subject_id: agent.id };
    assertToolFired(await memoryCalls(room, agent), MEMORY_TOOL.store, { content: marker, ...about });
    const stored = await storedMemories(agent, { scope: MEMORY_LIST_SCOPE.subject, subject_id: agent.id, content_query: marker });
    expect(stored).toContainEqual(memoryLike(marker, about));
  },
  WITH_MEMORY,
);

// Neither the scope nor the subject is spelled out: the agent gets them from the
// memory guidance in its prompt, and resolves the user's own id itself.
perAdapter(
  memory("subjectScopeInferred"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("subjinfer");
    const { env } = await liveRun();
    const userId = (await env.userClient.humanApiProfile.getMyProfile()).data.id;
    await takeTurn(room, agent, inferredSubjectRequest(marker));

    const about = { scope: MEMORY_STORE_SCOPE.subject, subject_id: userId };
    assertToolFired(await memoryCalls(room, agent), MEMORY_TOOL.store, { content: marker, ...about });
    const stored = await storedMemories(agent, { scope: MEMORY_LIST_SCOPE.subject, subject_id: userId, content_query: marker });
    expect(stored).toContainEqual(memoryLike(marker, about));
  },
  WITH_MEMORY_SECRETARY,
);

perAdapter(
  memory("excludedFromGeneralToolView"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("mem");
    await takeTurn(room, agent, storeRequest(marker));

    expect((await toolCalls(room, agent)).filter((call) => MEMORY_TOOL_NAMES.has(call.name)), "memory calls in the general view").toEqual([]);
    assertToolFired(await toolCalls(room, agent, { includeMemory: true }), MEMORY_TOOL.store);
    assertToolFired(await memoryCalls(room, agent), MEMORY_TOOL.store, { content: marker });
  },
  WITH_MEMORY,
);

const LIFECYCLE = [
  { name: "supersede", request: storeThenSupersedeRequest, tool: MEMORY_TOOL.supersede, status: MEMORY_STATUS.superseded },
  { name: "archive", request: storeThenArchiveRequest, tool: MEMORY_TOOL.archive, status: MEMORY_STATUS.archived },
] as const;

for (const { name, request, tool, status } of LIFECYCLE) {
  perAdapter(
    memory(name),
    async ({ agent, room }) => {
      const marker = uniqueMarker(name);
      await takeTurn(room, agent, request(marker));

      const calls = await memoryCalls(room, agent);
      assertToolFired(calls, MEMORY_TOOL.store, { content: marker });
      assertToolFired(calls, tool);
      // `status=all`, so the record is listed whatever became of it.
      const stored = await storedMemories(agent, { ...privateWith(marker), status: MEMORY_STATUS.all });
      expect(stored, `the record, ${status}`).toContainEqual(memoryLike(marker, { status }));
      expect(stored, "an active record").not.toContainEqual(memoryLike(marker, { status: MEMORY_STATUS.active }));
    },
    WITH_MEMORY,
  );
}

perAdapter(
  memory("recall"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("recall");
    await takeTurn(room, agent, storeListGetRequest(marker));

    const calls = await memoryCalls(room, agent);
    assertToolFired(calls, MEMORY_TOOL.store, { content: marker });
    assertToolFired(calls, MEMORY_TOOL.list);
    assertToolFired(calls, MEMORY_TOOL.get);
    expect(await storedMemories(agent, privateWith(marker))).toContainEqual(memoryLike(marker));
  },
  WITH_MEMORY,
);

perAdapter(
  memory("storeLayerFiltering"),
  async ({ agent, room }) => {
    const marker = uniqueMarker("multi");
    await takeTurn(room, agent, storeTwoTiersRequest(marker));

    const stored = await storedMemories(agent, privateWith(marker));
    expect(stored.length, "memories under the marker").toBeGreaterThanOrEqual(2);
    const inTier = (system: string) => stored.filter((record) => record.system === system);
    expect(inTier(MEMORY_SYSTEM.long_term)).toContainEqual(memoryLike(marker, { type: MEMORY_TYPE.semantic }));
    expect(inTier(MEMORY_SYSTEM.working)).toContainEqual(memoryLike(marker, { type: MEMORY_TYPE.episodic }));
  },
  WITH_MEMORY,
);

// An agent's private memory is its own alone; only the identity filter keeps it so.
// The reader never takes a turn: with no turn it has no calls, by construction.
perAdapter(
  memory("agentScopeIsolated"),
  async ({ agent, room, cell }) => {
    const marker = uniqueMarker("xagent");
    await takeTurn(room, agent, storeRequest(marker));

    assertToolFired(await memoryCalls(room, agent), MEMORY_TOOL.store, { content: marker });
    expect(await storedMemories(agent, privateWith(marker))).toContainEqual(memoryLike(marker));

    await using reader = await cell.provision("reader");
    expect(await storedMemories(reader, privateWith(marker)), "another agent's view of the writer's private memory").toEqual([]);
  },
  WITH_MEMORY,
);

// The platform refuses `organization` scope, rather than answering an empty 200 or
// minting an unreadable row, when the agent's owner belongs to no organization.
// Every identity this baseline provisions is such an agent.
describe(memory("organizationScopeRejectedOnList"), () => {
  it("rejects a read that asks for organization scope, with the platform's error code", async () => {
    await using agent = await Agents.provision(memory("organizationScopeRejectedOnList"), "org-list");

    const error = await agent.rest.listMemories({ scope: MEMORY_LIST_SCOPE.organization }).catch((caught: unknown) => caught);

    expect(rejection(error).error.code).toBe(ORGANIZATION_SCOPE_REJECTED_CODE);
  });
});

describe(memory("organizationScopeRejectedOnStore"), () => {
  it("rejects a store with organization scope, naming the missing organization", async () => {
    await using agent = await Agents.provision(memory("organizationScopeRejectedOnStore"), "org-store");

    const error = await agent.rest
      .storeMemory({
        content: uniqueMarker("orgreject"),
        ...NOTE,
        scope: MEMORY_STORE_SCOPE.organization,
        segment: MEMORY_SEGMENT.user,
        thought: "probing the organization-scope guard",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Band.UnprocessableEntityError);
    expect(rejection(error).error.details).toHaveProperty(ORGANIZATION_ID_FIELD);
  });
});

/** One call returns every peer the agent can reach, including a sibling agent of the same owner. */
import { describe, expect, it } from "vitest";

import { listAllPeers } from "../../../../src/rest";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";

const SCENARIO = scenarioId(CATEGORY.platform, "allPeers");

describe(SCENARIO, () => {
  it("lists a sibling agent among every peer", async () => {
    await using identity = await Agents.provision(SCENARIO, "lister");
    await using sibling = await Agents.provision(SCENARIO, "sibling");

    const peers = await listAllPeers(identity.rest);

    expect(peers.map((peer) => peer.id)).toContain(sibling.id);
  });
});

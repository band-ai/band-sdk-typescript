import { describe, expect, it } from "vitest";

import { generateTomPrompt } from "../examples/prompts/characters";
import {
  LETTA_EXAMPLE_MEMORY_BLOCKS,
  lettaMemoryBlocksExampleOptions,
} from "../examples/letta/02_memory_blocks";
import { buildLettaExampleAdapter, createLettaAgent } from "../examples/letta/01_basic_agent";
import { RecordingLettaClient } from "./fakes/RecordingLettaClient";
import { runLettaExampleRoomTurn } from "./helpers/lettaExampleTurn";
import { FakeTools } from "./testUtils";

describe("letta examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    const client = new RecordingLettaClient();
    expect(
      createLettaAgent({
        lettaBaseUrl: "http://127.0.0.1:8283",
        clientFactory: async () => client,
      }).state.status,
    ).toBe("not_started");
  });

  it("memory-blocks example seeds Letta memory blocks on agent creation", async () => {
    const client = new RecordingLettaClient();
    const adapter = buildLettaExampleAdapter({
      ...lettaMemoryBlocksExampleOptions({ lettaBaseUrl: "http://127.0.0.1:8283" }),
      clientFactory: async () => client,
    });
    const tools = new FakeTools();

    await runLettaExampleRoomTurn(adapter, tools);

    expect(client.lastAgentCreateParams?.memory_blocks).toEqual([...LETTA_EXAMPLE_MEMORY_BLOCKS]);
    expect(tools.messages).toEqual(["hi"]);
  });

  it("Tom character example embeds the shared persona in the Letta system prompt", async () => {
    const client = new RecordingLettaClient();
    const adapter = buildLettaExampleAdapter({
      clientFactory: async () => client,
      customSection: generateTomPrompt("Tom").trim(),
    });

    await runLettaExampleRoomTurn(adapter, new FakeTools(), "room-tom");

    expect(client.lastAgentCreateParams?.system).toContain("Tom the Cat");
  });
});

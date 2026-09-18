import { describe, expect, it } from "vitest";

import { openAIMemoryExampleOptions } from "../examples/openai/02_memory_agent";
import {
  buildOpenAIExampleAdapter,
  createOpenAIAgent,
} from "../examples/openai/01_basic_agent";
import { CaptureToolCallingModel } from "./helpers/captureToolCallingModel";
import { openAiToolNames, runToolCallingExampleTurn } from "./helpers/exampleTurn";

describe("openai examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    expect(createOpenAIAgent().state.status).toBe("not_started");
  });

  it("memory example adds Band memory tools and guidance to the model turn", async () => {
    const capture = new CaptureToolCallingModel();
    const adapter = buildOpenAIExampleAdapter({
      ...openAIMemoryExampleOptions(),
      toolCallingModel: capture,
    });

    const turn = await runToolCallingExampleTurn(
      adapter,
      capture,
      "remember my favorite color is blue",
    );

    expect(openAiToolNames(turn)).toEqual(
      expect.arrayContaining(["band_store_memory", "band_list_memories"]),
    );
    expect(turn.systemPrompt).toContain("band_store_memory");
    expect(turn.systemPrompt).toMatch(/remember durable facts/i);
  });
});

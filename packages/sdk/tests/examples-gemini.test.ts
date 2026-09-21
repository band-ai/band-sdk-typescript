import { describe, expect, it } from "vitest";

import {
  GEMINI_SUPPORT_CUSTOM_SECTION,
  geminiSupportExampleOptions,
} from "../examples/gemini/02_custom_instructions";
import {
  buildGeminiExampleAdapter,
  createGeminiAgent,
} from "../examples/gemini/01_basic_agent";
import { CaptureToolCallingModel } from "./helpers/captureToolCallingModel";
import { runToolCallingExampleTurn } from "./helpers/exampleTurn";

describe("gemini examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    expect(createGeminiAgent().state.status).toBe("not_started");
  });

  it("support example merges custom instructions with Band tool guidance on the model turn", async () => {
    const capture = new CaptureToolCallingModel();
    const adapter = buildGeminiExampleAdapter({
      ...geminiSupportExampleOptions(),
      toolCallingModel: capture,
    });

    const turn = await runToolCallingExampleTurn(adapter, capture, "the app crashes on launch");

    expect(turn.systemPrompt).toContain("Escalate to a human if you cannot resolve the issue");
    expect(turn.systemPrompt).toContain(GEMINI_SUPPORT_CUSTOM_SECTION.split("\n")[0]);
    expect(turn.systemPrompt).toContain("band_send_message");
  });
});

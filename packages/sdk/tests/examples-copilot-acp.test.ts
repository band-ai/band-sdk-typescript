import { describe, expect, it } from "vitest";

import {
  buildCopilotACPExampleAdapter,
  createCopilotACPAgent,
} from "../examples/copilot-acp/01_basic_agent";
import { firstAcpSystemPrompt } from "./helpers/exampleAcpTurn";

describe("copilot-acp examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    expect(createCopilotACPAgent().state.status).toBe("not_started");
  });

  it("character customSection appears in the first ACP system context", async () => {
    const prompt = await firstAcpSystemPrompt((connectionFactory) =>
      buildCopilotACPExampleAdapter({
        customSection: "Tom the cat chases Jerry.",
        command: ["copilot-acp-stub"],
        connectionFactory,
      }),
    );

    expect(prompt).toContain("[System Context]");
    expect(prompt).toContain("Tom the cat chases Jerry.");
  });
});

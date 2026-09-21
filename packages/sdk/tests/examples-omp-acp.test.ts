import { describe, expect, it } from "vitest";

import {
  buildOmpACPExampleAdapter,
  createOmpACPAgent,
} from "../examples/omp-acp/01_basic_agent";
import { firstAcpSystemPrompt } from "./helpers/exampleAcpTurn";

describe("omp-acp examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    expect(createOmpACPAgent().state.status).toBe("not_started");
  });

  it("character customSection appears in the first ACP system context", async () => {
    const prompt = await firstAcpSystemPrompt((connectionFactory) =>
      buildOmpACPExampleAdapter({
        customSection: "Jerry the mouse evades Tom.",
        command: ["omp-acp-stub"],
        connectionFactory,
      }),
    );

    expect(prompt).toContain("Jerry the mouse evades Tom.");
  });
});

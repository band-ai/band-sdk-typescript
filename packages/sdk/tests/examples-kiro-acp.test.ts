import { describe, expect, it } from "vitest";

import {
  buildKiroACPExampleAdapter,
  createKiroACPAgent,
} from "../examples/kiro-acp/01_basic_agent";
import { firstAcpSystemPrompt } from "./helpers/exampleAcpTurn";

describe("kiro-acp examples", () => {
  it("factory returns an agent that has not auto-started", () => {
    expect(createKiroACPAgent().state.status).toBe("not_started");
  });

  it("a configured customSection appears in the first ACP system context", async () => {
    const prompt = await firstAcpSystemPrompt((connectionFactory) =>
      buildKiroACPExampleAdapter({
        customSection: "Answer only in haiku.",
        command: ["kiro-acp-stub"],
        connectionFactory,
      }),
    );

    expect(prompt).toContain("[System Context]");
    expect(prompt).toContain("Answer only in haiku.");
  });
});

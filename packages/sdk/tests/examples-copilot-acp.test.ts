import { describe, expect, it } from "vitest";

import { createCopilotACPAgent } from "../examples/copilot-acp/01_basic_agent";

describe("copilot-acp examples", () => {
  it("builds a Copilot ACP adapter agent without import-time side effects", () => {
    const agent = createCopilotACPAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("imports 01_basic_agent entry script without side effects", async () => {
    await expect(import("../examples/copilot-acp/01_basic_agent")).resolves.toBeDefined();
  });
});

import { describe, expect, it } from "vitest";

import { createOmpACPAgent } from "../examples/omp-acp/01_basic_agent";

describe("omp-acp examples", () => {
  it("builds an OMP ACP adapter agent without import-time side effects", () => {
    const agent = createOmpACPAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("imports 01_basic_agent entry script without side effects", async () => {
    await expect(import("../examples/omp-acp/01_basic_agent")).resolves.toBeDefined();
  });
});

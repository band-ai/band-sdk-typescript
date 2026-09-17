import { describe, expect, it } from "vitest";

import { createA2ABridgeAgent } from "../examples/a2a-bridge/01_basic_agent";
import { createA2ABridgeAgentWithAuth } from "../examples/a2a-bridge/02_with_auth";

describe("a2a bridge examples", () => {
  it("builds an A2A bridge agent without import-time side effects", () => {
    const agent = createA2ABridgeAgent({ remoteUrl: "a2a-remote" });
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds an authenticated A2A bridge agent", () => {
    const agent = createA2ABridgeAgentWithAuth({
      remoteUrl: "a2a-remote",
      apiKey: "secret",
    });
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

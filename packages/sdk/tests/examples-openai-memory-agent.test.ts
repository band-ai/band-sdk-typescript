import { describe, expect, it } from "vitest";

import { createOpenAIMemoryAgent } from "../examples/openai/openai-memory-agent";

describe("openai-memory-agent example", () => {
  it("builds a memory-enabled OpenAI agent without side effects on import", () => {
    const agent = createOpenAIMemoryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });
});

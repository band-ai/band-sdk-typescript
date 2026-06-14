import { describe, expect, it } from "vitest";

import { createLangGraphMemoryAgent } from "../examples/langgraph/langgraph-memory-agent";

describe("langgraph-memory-agent example", () => {
  it("builds a memory-enabled LangGraph agent without side effects on import", () => {
    const agent = createLangGraphMemoryAgent({ llm: { provider: "test-llm" } });
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });
});

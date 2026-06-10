import { describe, expect, it } from "vitest";

import { createAnthropicAgent } from "../examples/anthropic/anthropic-agent";
import { createGeminiAgent } from "../examples/gemini/gemini-agent";
import { createOpenAIAgent } from "../examples/openai/openai-agent";
import { createOpenAIMemoryAgent } from "../examples/openai/openai-memory-agent";

describe("openai/anthropic examples", () => {
  it("builds an OpenAI adapter agent without import-time side effects", () => {
    const agent = createOpenAIAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds an Anthropic adapter agent without import-time side effects", () => {
    const agent = createAnthropicAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds a Gemini adapter agent without import-time side effects", () => {
    const agent = createGeminiAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("builds an OpenAI memory agent without import-time side effects", () => {
    const agent = createOpenAIMemoryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });
});

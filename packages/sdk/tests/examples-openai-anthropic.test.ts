import { describe, expect, it } from "vitest";

import { createAnthropicAgent } from "../examples/anthropic/01_basic_agent";
import { generateTomPrompt } from "../examples/prompts/characters";
import { renderSystemPrompt } from "../src/runtime/prompts";
import { createGeminiAgent } from "../examples/gemini/gemini-agent";
import { createOpenAIAgent } from "../examples/openai/openai-agent";

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

  it("builds an Anthropic agent with merged custom instructions options", () => {
    const systemPrompt = renderSystemPrompt({ customSection: "Support-style section." });
    expect(systemPrompt).toContain("band_send_message");
    const agent = createAnthropicAgent({
      systemPrompt,
      enableExecutionReporting: true,
    });
    expect(agent).toBeDefined();
  });

  it("imports 02_custom_instructions without side effects", async () => {
    await expect(import("../examples/anthropic/02_custom_instructions")).resolves.toBeDefined();
  });

  it("imports Tom and Jerry example scripts without side effects", async () => {
    await expect(import("../examples/anthropic/03_tom_agent")).resolves.toBeDefined();
    await expect(import("../examples/anthropic/04_jerry_agent")).resolves.toBeDefined();
  });

  it("builds Tom character prompt with Band tool guidance when merged", () => {
    const merged = renderSystemPrompt({ customSection: generateTomPrompt("Tom").trim() });
    expect(merged).toContain("Tom the Cat");
    expect(merged).toContain("band_send_message");
    expect(merged).toContain("band_lookup_peers");
  });

  it("builds a Gemini adapter agent without import-time side effects", () => {
    const agent = createGeminiAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });
});

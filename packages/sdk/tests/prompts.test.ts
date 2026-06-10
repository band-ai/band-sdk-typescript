import { describe, expect, it } from "vitest";

import { renderSystemPrompt, BASE_INSTRUCTIONS, TEMPLATES } from "../src/runtime/prompts";

describe("renderSystemPrompt", () => {
  it("renders default prompt with agent name and description", () => {
    const result = renderSystemPrompt({
      agentName: "TestBot",
      agentDescription: "a helpful test agent",
    });

    expect(result).toContain("You are TestBot, a helpful test agent.");
    expect(result).toContain(BASE_INSTRUCTIONS);
  });

  it("uses fallback name and description when not provided", () => {
    const result = renderSystemPrompt();

    expect(result).toContain("You are Agent, An AI assistant.");
    expect(result).toContain(BASE_INSTRUCTIONS);
  });

  it("includes custom section", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      customSection: "Always respond in French.",
    });

    expect(result).toContain("Always respond in French.");
  });

  it("excludes base instructions when includeBaseInstructions is false", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      includeBaseInstructions: false,
    });

    expect(result).toContain("You are Bot, helper.");
    expect(result).not.toContain("thenvoi_send_message");
  });

  it("falls back to default template for unknown template name", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      template: "nonexistent",
    });

    expect(result).toEqual(
      renderSystemPrompt({
        agentName: "Bot",
        agentDescription: "helper",
        template: "default",
      }),
    );
  });

  it("replaces all placeholders in the template", () => {
    const result = renderSystemPrompt({
      agentName: "MyAgent",
      agentDescription: "does things",
      customSection: "Extra info.",
    });

    expect(result).not.toContain("{agent_name}");
    expect(result).not.toContain("{agent_description}");
    expect(result).not.toContain("{custom_section}");
  });

  it("trims result when base instructions are excluded", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      customSection: "",
      includeBaseInstructions: false,
    });

    expect(result).not.toMatch(/\s$/);
  });

  it("includes memory instructions when memory capability is enabled", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      capabilities: { memory: true },
    });

    expect(result).toContain("## Memory Tools");
    expect(result).toContain("thenvoi_store_memory");
  });

  it("documents store_memory enum values in memory instructions", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      capabilities: { memory: true },
    });

    expect(result).toContain('- **system**: `"sensory"` | `"working"` | `"long_term"`');
    expect(result).toContain('  - sensory: `"iconic"` | `"echoic"` | `"haptic"`');
    expect(result).toContain('  - working: `"episodic"` | `"semantic"` | `"procedural"`');
    expect(result).toContain('- **segment**: `"user"` | `"agent"` | `"tool"` | `"guideline"`');
    expect(result).toContain('scope="subject"');
    expect(result).toContain('scope="organization"');
  });

  it("omits memory instructions by default", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
    });

    expect(result).not.toContain("## Memory Tools");
  });

  it("omits capability sections when base instructions are excluded", () => {
    const result = renderSystemPrompt({
      agentName: "Bot",
      agentDescription: "helper",
      includeBaseInstructions: false,
      capabilities: { memory: true, contacts: true },
    });

    expect(result).not.toContain("## Memory Tools");
    expect(result).not.toContain("## Contact Management Tools");
  });
});

describe("TEMPLATES", () => {
  it("has a default template", () => {
    expect(TEMPLATES.default).toBeDefined();
    expect(TEMPLATES.default).toContain("{agent_name}");
    expect(TEMPLATES.default).toContain("{agent_description}");
    expect(TEMPLATES.default).toContain("{custom_section}");
  });
});

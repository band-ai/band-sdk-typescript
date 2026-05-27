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
});

describe("TEMPLATES", () => {
  it("has a default template", () => {
    expect(TEMPLATES.default).toBeDefined();
    expect(TEMPLATES.default).toContain("{agent_name}");
    expect(TEMPLATES.default).toContain("{agent_description}");
    expect(TEMPLATES.default).toContain("{custom_section}");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  AcpSessionConfigError,
  FAILURE_CODE_SESSION_CONFIG,
  applySessionConfigSelections,
} from "../src/adapters/acp/sessionConfigReconciliation";
import { withTimeout } from "../src/adapters/shared/withTimeout";

const modelOption = (overrides: Record<string, unknown> = {}) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select" as const,
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet" },
    { value: "auto", name: "Auto" },
  ],
  ...overrides,
});

const effortOption = (overrides: Record<string, unknown> = {}) => ({
  id: "reasoning_effort",
  name: "Reasoning",
  category: "thought_level",
  type: "select" as const,
  currentValue: "medium",
  options: [
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
  ...overrides,
});

describe("applySessionConfigSelections", () => {
  it("applies OMP-style model then thinking against refreshed catalogs", async () => {
    const thinking = {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select" as const,
      currentValue: "off",
      options: [
        { value: "off", name: "Off" },
        { value: "medium", name: "Medium" },
      ],
    };
    const setOption = vi.fn(async ({ configId, value }: { configId: string; value: string }) => ({
      configOptions: [
        modelOption({ currentValue: configId === "model" ? value : "sonnet" }),
        { ...thinking, currentValue: configId === "thinking" ? value : thinking.currentValue },
      ],
    }));

    const result = await applySessionConfigSelections({
      provider: "omp-acp",
      sessionId: "s1",
      catalog: [modelOption(), thinking],
      selections: { model: "sonnet", thinking: "medium" },
      setOption,
      timeoutMs: 1_000,
      withTimeout,
    });

    expect(setOption).toHaveBeenCalledTimes(2);
    expect(result.catalog.find((o) => o.id === "thinking")).toMatchObject({ currentValue: "medium" });
  });

  it("applies Codex-style effort-only selection without requiring a model change", async () => {
    const setOption = vi.fn(async () => ({
      configOptions: [modelOption({ currentValue: "opus" }), effortOption({ currentValue: "high" })],
    }));

    await applySessionConfigSelections({
      provider: "acp",
      sessionId: "s1",
      catalog: [modelOption({ currentValue: "opus" }), effortOption()],
      selections: { reasoning_effort: "high" },
      setOption,
      timeoutMs: 1_000,
      withTimeout,
    });

    expect(setOption).toHaveBeenCalledWith({
      sessionId: "s1",
      configId: "reasoning_effort",
      value: "high",
    });
  });

  it("surfaces a structured failure with provider and option id", async () => {
    await expect(applySessionConfigSelections({
      provider: "omp-acp",
      sessionId: "s1",
      catalog: [modelOption()],
      selections: { thinking: "on" },
      setOption: vi.fn(),
      timeoutMs: 1_000,
      withTimeout,
    })).rejects.toMatchObject({
      name: "AcpSessionConfigError",
      provider: "omp-acp",
      optionId: "thinking",
      selectedValue: "on",
    });

    try {
      await applySessionConfigSelections({
        provider: "omp-acp",
        sessionId: "s1",
        catalog: [modelOption()],
        selections: { thinking: "on" },
        setOption: vi.fn(),
        timeoutMs: 1_000,
        withTimeout,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AcpSessionConfigError);
      expect((error as AcpSessionConfigError).toAgentFailure()).toMatchObject({
        provider: "omp-acp",
        code: FAILURE_CODE_SESSION_CONFIG,
      });
    }
  });
});

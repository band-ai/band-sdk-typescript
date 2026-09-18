import { describe, expect, it, vi } from "vitest";

import {
  AcpSessionConfigError,
  FAILURE_CODE_SESSION_CONFIG,
  applySessionConfigSelections,
} from "../src/adapters/acp/sessionConfigReconciliation";

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
        { value: "on", name: "On" },
      ],
    };
    const setOption = vi.fn()
      .mockResolvedValueOnce({
        configOptions: [modelOption({ currentValue: "sonnet" }), thinking],
      })
      .mockResolvedValueOnce({
        configOptions: [modelOption({ currentValue: "sonnet" }), { ...thinking, currentValue: "on" }],
      });

    const result = await applySessionConfigSelections({
      provider: "omp-acp",
      sessionId: "s1",
      catalog: [modelOption(), thinking],
      selections: { model: "sonnet", thinking: "on" },
      setOption,
      timeoutMs: 1_000,
    });

    expect(setOption).toHaveBeenCalledTimes(2);
    expect(result.catalog).toEqual([
      modelOption({ currentValue: "sonnet" }),
      { ...thinking, currentValue: "on" },
    ]);
  });

  it("skips setOption when the selected value is already current", async () => {
    const setOption = vi.fn().mockResolvedValue({
      configOptions: [modelOption({ currentValue: "opus" }), effortOption({ currentValue: "high" })],
    });

    await applySessionConfigSelections({
      provider: "acp",
      sessionId: "s1",
      catalog: [modelOption({ currentValue: "opus" }), effortOption()],
      selections: { reasoning_effort: "high" },
      setOption,
      timeoutMs: 1_000,
    });

    expect(setOption).toHaveBeenCalledWith({
      sessionId: "s1",
      configId: "reasoning_effort",
      value: "high",
    });
  });

  it("fails closed when a selected value is not advertised", async () => {
    const setOption = vi.fn();
    await expect(applySessionConfigSelections({
      provider: "omp-acp",
      sessionId: "s1",
      catalog: [modelOption()],
      selections: { model: "haiku" },
      setOption,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      name: "AcpSessionConfigError",
      provider: "omp-acp",
      sessionId: "s1",
      optionId: "model",
      selectedValue: "haiku",
    });
    expect(setOption).not.toHaveBeenCalled();
  });

  it("fails closed when a successful setter omits the refreshed catalog", async () => {
    const setOption = vi.fn().mockResolvedValue({});
    await expect(applySessionConfigSelections({
      provider: "acp",
      sessionId: "s1",
      catalog: [modelOption(), effortOption()],
      selections: { model: "auto", reasoning_effort: "high" },
      setOption,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      name: "AcpSessionConfigError",
      optionId: "model",
      selectedValue: "auto",
      detail: { reason: "missing_config_options" },
    });
    expect(setOption).toHaveBeenCalledTimes(1);
  });

  it("surfaces a structured failure with provider, session id, and option id", async () => {
    const rejection = applySessionConfigSelections({
      provider: "omp-acp",
      sessionId: "s1",
      catalog: [modelOption()],
      selections: { thinking: "on" },
      setOption: vi.fn(),
      timeoutMs: 1_000,
    });

    await expect(rejection).rejects.toBeInstanceOf(AcpSessionConfigError);
    const error = await rejection.catch((value: unknown) => value) as AcpSessionConfigError;
    expect(error).toMatchObject({
      provider: "omp-acp",
      sessionId: "s1",
      optionId: "thinking",
      selectedValue: "on",
    });
    expect(error.toAgentFailure()).toMatchObject({
      provider: "omp-acp",
      code: FAILURE_CODE_SESSION_CONFIG,
      detail: {
        sessionId: "s1",
        optionId: "thinking",
        selectedValue: "on",
      },
    });
  });
});

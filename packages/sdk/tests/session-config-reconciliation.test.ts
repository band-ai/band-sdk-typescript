import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { ExecutionContext, type ExecutionContextOptions } from "../src/runtime/ExecutionContext";
import { BandLink } from "../src/platform/BandLink";
import { ValidationError } from "../src/core/errors";
import { FakeRestApi, FakeTransport } from "./testUtils";
import { describe, expect, it, vi } from "vitest";

import {
  AcpSessionConfigError,
  FAILURE_CODE_SESSION_CONFIG,
  MISSING_CONFIG_OPTIONS_REASON,
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

  it("preserves explicit selection order for numeric-like config ids", async () => {
    const first = modelOption({ id: "10" });
    const second = modelOption({ id: "2" });
    const setOption = vi.fn()
      .mockResolvedValueOnce({
        configOptions: [modelOption({ id: "10", currentValue: "sonnet" }), second],
      })
      .mockResolvedValueOnce({
        configOptions: [modelOption({ id: "10", currentValue: "sonnet" }), modelOption({ id: "2", currentValue: "auto" })],
      });

    await applySessionConfigSelections({
      provider: "acp",
      sessionId: "s1",
      catalog: [first, second],
      selections: [
        { configId: "10", value: "sonnet" },
        { configId: "2", value: "auto" },
      ],
      setOption,
      timeoutMs: 1_000,
    });

    expect(setOption).toHaveBeenNthCalledWith(1, {
      sessionId: "s1",
      configId: "10",
      value: "sonnet",
    });
    expect(setOption).toHaveBeenNthCalledWith(2, {
      sessionId: "s1",
      configId: "2",
      value: "auto",
    });
  });

  it("skips setOption when the selected value is already current", async () => {
    const setOption = vi.fn().mockResolvedValue({
      configOptions: [modelOption({ currentValue: "opus" }), effortOption({ currentValue: "high" })],
    });

    await applySessionConfigSelections({
      provider: "acp",
      sessionId: "s1",
      catalog: [modelOption({ currentValue: "opus" }), effortOption()],
      selections: { model: "opus", reasoning_effort: "high" },
      setOption,
      timeoutMs: 1_000,
    });

    expect(setOption).toHaveBeenCalledTimes(1);
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
      detail: { reason: MISSING_CONFIG_OPTIONS_REASON },
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


describe("runtime working-state session configuration", () => {
  it.each([
    { workingKeepAliveSeconds: 0 }, { workingKeepAliveSeconds: 5 },
    { workingKeepAliveSeconds: Infinity }, { workingKeepAliveSeconds: NaN },
    { workingRequestTimeoutSeconds: 0 }, { workingRequestTimeoutSeconds: 3 },
    { workingRequestTimeoutSeconds: Infinity }, { workingRequestTimeoutSeconds: NaN },
    // Each report can succeed and still land after the TTL: a 3.9s response, a 4s cadence, then a 3.9s request.
    { workingKeepAliveSeconds: 4, workingRequestTimeoutSeconds: 3.9 },
    { maxWorkingStateSeconds: 0 }, { maxWorkingStateSeconds: -1 },
    { maxWorkingStateSeconds: Infinity }, { maxWorkingStateSeconds: NaN },
  ])("rejects invalid enabled timing at construction: %o", (sessionConfig) => {
    expect(() => new PlatformRuntime({ agentId: "agent", apiKey: "key", sessionConfig })).toThrow(ValidationError);
  });

  it("forwards defaults and fractional settings through the custom context factory", () => {
    for (const sessionConfig of [undefined, { workingKeepAliveSeconds: 0.5, workingRequestTimeoutSeconds: 0.2, maxWorkingStateSeconds: 0.7 }]) {
      let received: ExecutionContextOptions | undefined;
      const runtime = new AgentRuntime({
        agentId: "agent", link: new BandLink({ agentId: "agent", apiKey: "key", restApi: new FakeRestApi(), transport: new FakeTransport() }),
        sessionConfig, onExecute: async () => {},
        contextFactory: (_roomId, defaults) => { received = defaults; return new ExecutionContext(defaults); },
      });
      runtime.getOrCreateContext("room");
      expect(received).toMatchObject({ enableWorkingState: true, workingKeepAliveSeconds: 3, workingRequestTimeoutSeconds: 2, ...sessionConfig });
      expect(received?.maxWorkingStateSeconds).toBe(sessionConfig?.maxWorkingStateSeconds);
    }
  });

  it("accepts dormant timing when disabled", () => {
    expect(() => new PlatformRuntime({ agentId: "agent", apiKey: "key", sessionConfig: {
      enableWorkingState: false, workingKeepAliveSeconds: NaN, workingRequestTimeoutSeconds: Infinity, maxWorkingStateSeconds: -1,
    } })).not.toThrow();
  });
});

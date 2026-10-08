import { createPartFromFunctionCall, createPartFromFunctionResponse } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicToolCallingModel } from "../../../src/adapters/anthropic/model";
import { GeminiToolCallingModel } from "../../../src/adapters/gemini/model";
import type { ToolCallingModelRequest } from "../../../src/adapters/tool-calling";
import { ADAPTER } from "./adapters";
import { fakeSpec } from "./fakeSpec";
import { runScenario, type OpenCast } from "./perAdapter";
import type { Room } from "./rooms";
import {
  anthropicDiagnosticFactory,
  currentProviderTrace,
  geminiDiagnosticFactory,
  runWithProviderTrace,
} from "./providerDiagnostics";
import { CATEGORY, scenarioId } from "./registry";

const SEND_SCENARIO = scenarioId(CATEGORY.behavior, "repliesOnceThroughSendTool");
const MEMORY_SCENARIO = scenarioId(CATEGORY.inspection, "memory.subjectScopeInferred");

afterEach(() => vi.unstubAllEnvs());

describe("provider diagnostics", () => {
  it("leaves providers untouched unless both the opt-in and scenario allowlist match", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "");
    const load = vi.fn();
    await runWithProviderTrace(SEND_SCENARIO, async () => {
      expect(anthropicDiagnosticFactory(load)).toBeUndefined();
      expect(geminiDiagnosticFactory(load)).toBeUndefined();
    });
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    await runWithProviderTrace(scenarioId(CATEGORY.behavior, "anotherScenario"), async () => {
      expect(anthropicDiagnosticFactory(load)).toBeUndefined();
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("captures the actual provider conversion and preserves parsed responses", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    const secret = "a-provider-key-without-a-known-prefix";
    const nativeAnthropic = { content: [{ type: "tool_use", id: "store", name: "band_store_memory", input: { scope: "subject" } }] };
    const nativeGemini = { functionCalls: [{ id: "send", name: "band_send_message", args: { content: "pineapple" } }] };
    await runWithProviderTrace(SEND_SCENARIO, async () => {
      const anthropic = new AnthropicToolCallingModel({
        model: "anthropic-model", apiKey: secret,
        clientFactory: anthropicDiagnosticFactory(async () => ({ messages: { create: async () => nativeAnthropic } })),
      });
      const gemini = new GeminiToolCallingModel({
        model: "gemini-model", apiKey: secret,
        partFactory: { createPartFromFunctionCall, createPartFromFunctionResponse },
        clientFactory: geminiDiagnosticFactory(async () => ({ models: { generateContent: async () => nativeGemini } })),
      });
      const request: ToolCallingModelRequest = { systemPrompt: "Memory policy", messages: [{ role: "user", content: `user ${secret}` }, { role: "system", content: "Current participants" }], tools: [] };
      expect(await anthropic.complete(request)).toMatchObject({ toolCalls: [{ name: "band_store_memory", input: { scope: "subject" } }] });
      expect(await gemini.complete(request)).toMatchObject({ toolCalls: [{ name: "band_send_message", input: { content: "pineapple" } }] });
      const trace = currentProviderTrace();
      expect(trace[0]).toMatchObject({ provider: "anthropic", request: { model: "anthropic-model", system: "Memory policy", messages: [{ role: "user" }] }, response: nativeAnthropic });
      expect(trace[1]).toMatchObject({ provider: "gemini", request: { model: "gemini-model", config: { systemInstruction: "Memory policy" }, contents: [{ role: "user", parts: [{ text: "user [REDACTED]" }, { text: "[System]: Current participants" }] }] }, response: nativeGemini });
      expect(JSON.stringify(trace)).not.toContain(secret);
      nativeAnthropic.content[0].input.scope = "agent";
      expect(trace[0]).toMatchObject({ response: { content: [{ input: { scope: "subject" } }] } });
      expect(request.messages[0].content).toContain(secret);
    });
  });

  it("retains an in-flight request and records a sanitized rejection without replacing the error", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "opaque-private-value");
    await runWithProviderTrace(MEMORY_SCENARIO, async () => {
      let reject!: (reason: Error) => void;
      const pending = new Promise<never>((_, rejectRequest) => { reject = rejectRequest; });
      const client = await anthropicDiagnosticFactory(async () => ({ messages: { create: async () => pending } }))!({});
      const error = new Error("request failed with opaque-private-value");
      const result = client.messages.create({ messages: [{ content: "remember me" }] });
      expect(currentProviderTrace()).toMatchObject([{ provider: "anthropic", request: { messages: [{ content: "remember me" }] } }]);
      reject(error);
      await expect(result).rejects.toBe(error);
      expect(currentProviderTrace()[0]).toMatchObject({ error: { message: "request failed with [REDACTED]" } });
    });
  });

  it("keeps concurrent scenario buffers separate through asynchronous client initialization", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    const buffers = await Promise.all([SEND_SCENARIO, MEMORY_SCENARIO].map(async (scenario) => runWithProviderTrace(scenario, async () => {
      const trace = currentProviderTrace();
      const factory = geminiDiagnosticFactory(async () => {
        await Promise.resolve();
        return { models: { generateContent: async () => ({ text: scenario }) } };
      })!;
      const client = await factory({});
      await client.models.generateContent({ scenario });
      expect(currentProviderTrace()).toBe(trace);
      return trace;
    })));
    expect(buffers[0]).toMatchObject([{ request: { scenario: SEND_SCENARIO } }]);
    expect(buffers[1]).toMatchObject([{ request: { scenario: MEMORY_SCENARIO } }]);
    expect(currentProviderTrace()).toEqual([]);
  });

  it("starts the scenario trace before acquiring adapters and retains it through resource release", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    let trace: ReturnType<typeof currentProviderTrace> = [];
    const released = vi.fn();
    const open: OpenCast = async () => {
      trace = currentProviderTrace();
      const factory = anthropicDiagnosticFactory(async () => ({ messages: { create: async () => ({ content: [] }) } }));
      expect(factory).toBeDefined();
      const client = await factory!({});
      await client.messages.create({ messages: [{ content: "adapter startup" }] });
      return { agents: [], cells: [], room: { id: "room" } as Room, [Symbol.asyncDispose]: async () => {
        expect(currentProviderTrace()).toBe(trace);
        released();
      } };
    };
    await runScenario([fakeSpec(ADAPTER.anthropic)], async () => {
      expect(currentProviderTrace()).toBe(trace);
      expect(trace).toMatchObject([{ request: { messages: [{ content: "adapter startup" }] } }]);
    }, { scenario: SEND_SCENARIO, prompt: "prompt" }, open);
    expect(released).toHaveBeenCalledOnce();
    expect(currentProviderTrace()).toEqual([]);
  });

  it("bounds oversized and repeated provider payloads while retaining the latest exchanges", async () => {
    vi.stubEnv("BAND_BASELINE_PROVIDER_TRACE", "1");
    await runWithProviderTrace(SEND_SCENARIO, async () => {
      const client = await geminiDiagnosticFactory(async () => ({ models: { generateContent: async () => ({ text: "done" }) } }))!({});
      for (let turn = 0; turn < 40; turn++) await client.models.generateContent({ turn, text: "x".repeat(100_000) });
      const trace = currentProviderTrace();
      expect(trace.length).toBeLessThan(40);
      expect(trace.at(-1)).toMatchObject({ request: { truncated: true, preview: expect.stringContaining('"turn":39') }, response: { text: "done" } });
      expect(JSON.stringify(trace).length).toBeLessThan(3_000_000);
    });
  });
});

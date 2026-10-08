import { AsyncLocalStorage } from "node:async_hooks";

import type { AnthropicClientFactory } from "../../../src/adapters/anthropic/model";
import type { GeminiClientFactory } from "../../../src/adapters/gemini/model";
import { redactDiagnostics } from "../../support/redactDiagnostics";
import { CATEGORY, scenarioId, type ScenarioId } from "./registry";

const TRACE_ENV = "BAND_BASELINE_PROVIDER_TRACE";
const TRACED_SCENARIOS = new Set<ScenarioId>([
  scenarioId(CATEGORY.behavior, "repliesOnceThroughSendTool"),
  scenarioId(CATEGORY.inspection, "memory.subjectScopeInferred"),
]);
const MAX_EXCHANGES = 32;
const MAX_PAYLOAD_CHARACTERS = 65_536;
const traceScope = new AsyncLocalStorage<ProviderExchange[]>();

export interface ProviderExchange {
  provider: "anthropic" | "gemini";
  request: unknown;
  response?: unknown;
  error?: unknown;
}

/** Start before adapter construction so background provider calls retain this scenario's buffer. */
export async function runWithProviderTrace<T>(scenario: ScenarioId | undefined, operation: () => Promise<T>): Promise<T> {
  if (process.env[TRACE_ENV] !== "1" || !scenario || !TRACED_SCENARIOS.has(scenario)) return operation();
  return traceScope.run([], operation);
}

/** The live buffer also exposes requests still in flight when a test times out. */
export function currentProviderTrace(): ProviderExchange[] {
  return traceScope.getStore() ?? [];
}

function snapshot(value: unknown, secrets: readonly string[]): unknown {
  const sanitized = redactDiagnostics(value, secrets);
  const serialized = JSON.stringify(sanitized);
  return serialized && serialized.length > MAX_PAYLOAD_CHARACTERS
    ? { truncated: true, preview: serialized.slice(0, MAX_PAYLOAD_CHARACTERS) }
    : sanitized;
}

async function capture<T>(
  trace: ProviderExchange[],
  provider: ProviderExchange["provider"],
  request: Record<string, unknown>,
  secrets: readonly string[],
  invoke: () => Promise<T>,
): Promise<T> {
  const entry: ProviderExchange = { provider, request: snapshot(request, secrets) };
  if (trace.length === MAX_EXCHANGES) trace.shift();
  trace.push(entry);
  try {
    const response = await invoke();
    entry.response = snapshot(response, secrets);
    return response;
  } catch (error) {
    entry.error = snapshot(error, secrets);
    throw error;
  }
}

async function loadAnthropicClient(input: { apiKey?: string }): ReturnType<AnthropicClientFactory> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic(input) as unknown as Awaited<ReturnType<AnthropicClientFactory>>;
}

async function loadGeminiClient(input: { apiKey?: string }): ReturnType<GeminiClientFactory> {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI(input) as unknown as Awaited<ReturnType<GeminiClientFactory>>;
}

export function anthropicDiagnosticFactory(load: AnthropicClientFactory = loadAnthropicClient): AnthropicClientFactory | undefined {
  const trace = traceScope.getStore();
  if (!trace) return undefined;
  return async (input) => {
    const client = await load(input);
    return { messages: { create: async (request, options) => capture(
      trace, "anthropic", request, [input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ""], () => client.messages.create(request, options),
    ) } };
  };
}

export function geminiDiagnosticFactory(load: GeminiClientFactory = loadGeminiClient): GeminiClientFactory | undefined {
  const trace = traceScope.getStore();
  if (!trace) return undefined;
  return async (input) => {
    const client = await load(input);
    return { models: { generateContent: async (request) => capture(
      trace, "gemini", request, [input.apiKey ?? ""], () => client.models.generateContent(request),
    ) } };
  };
}

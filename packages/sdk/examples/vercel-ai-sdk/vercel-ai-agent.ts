/**
 * Vercel AI SDK adapter example.
 *
 * Bridges Thenvoi platform tools into the [Vercel AI SDK](https://sdk.vercel.ai)
 * tool-calling loop. You supply a language model from any
 * `@ai-sdk/*` provider (OpenAI, Anthropic, Google, Mistral, Groq, …)
 * and the adapter handles tool schema generation, conversation
 * history, function-call dispatch, and retries.
 *
 * The Vercel AI SDK is the right pick when:
 *   - you already use `ai` in your app and want one model abstraction
 *     across providers, or
 *   - you want easy provider swaps (OpenAI today, Claude tomorrow,
 *     Groq on staging) without changing agent code.
 *
 * For provider-native shapes, see `examples/openai/`, `examples/anthropic/`,
 * and `examples/gemini/`.
 */
import {
  Agent,
  VercelAISDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

/**
 * Lazy-load `@ai-sdk/openai` so the SDK doesn't hard-depend on it.
 * Swap this for `@ai-sdk/anthropic`, `@ai-sdk/google`, etc. — the rest
 * of the example is unchanged.
 */
async function loadDefaultModel(modelId: string): Promise<unknown> {
  let mod: { openai: (id: string) => unknown };
  try {
    // @ts-expect-error optional peer dep — install @ai-sdk/openai (or
    // any other @ai-sdk provider) and swap this import to use it.
    mod = await import("@ai-sdk/openai");
  } catch {
    throw new Error(
      "@ai-sdk/openai is not installed. Run: pnpm add ai @ai-sdk/openai\n" +
      "Or replace `loadDefaultModel` with another @ai-sdk provider.",
    );
  }
  return mod.openai(modelId);
}

interface VercelAgentOptions {
  /** A Vercel AI SDK language model (e.g. `openai("gpt-5.5")`). */
  model?: unknown;
  /** Default model ID used when `model` isn't supplied. */
  modelId?: string;
}

export async function createVercelAgent(
  options: VercelAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const model = options.model ?? (await loadDefaultModel(options.modelId ?? "gpt-5.5"));

  const adapter = new VercelAISDKAdapter({
    model,
    enableExecutionReporting: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "vercel-ai-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  // The `ai` SDK + provider package read the provider's API key from
  // the env automatically (e.g. OPENAI_API_KEY for @ai-sdk/openai).
  // Fail fast here so the error message is obvious.
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "Set OPENAI_API_KEY (or swap loadDefaultModel to a provider whose key is set) to run this example.",
    );
  }
  const config = loadAgentConfig("vercel_ai_agent");
  void createVercelAgent({}, config).then((agent) => agent.run());
}

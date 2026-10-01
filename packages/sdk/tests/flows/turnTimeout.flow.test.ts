/**
 * A tool-calling turn is bounded, through the real platform runtime, for each
 * built-in adapter. A provider request that never answers fails its own message
 * when the turn budget runs out, instead of holding the room's queue, and the
 * message behind it still runs.
 */
import { describe, expect, it } from "vitest";

import { GeminiToolCallingModel } from "../../src/adapters";
import type { FrameworkAdapter } from "../../src/contracts/protocols";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import { FAILURE_CODE_TIMEOUT } from "../../src/core/providerFailure";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, VercelAISDKAdapter } from "../../src/index";
import { SHORT_TURN_TIMEOUT_MS, hangUntilAborted } from "../testUtils";
import { AGENT_ID, BandPlatform, person } from "./support/bandPlatform";

const USER = "user-1";
const REPLY = "back to normal";

interface HangingProvider {
  adapter: FrameworkAdapter;
  /** The first provider request, which never answers until it is aborted. */
  hung: ReturnType<typeof hangUntilAborted>;
}

/** A provider request: the first hangs until aborted, every later one answers `answer`. */
function hangsFirstRequest<T>(answer: T) {
  const hung = hangUntilAborted();
  let calls = 0;
  const request = (signal?: AbortSignal): Promise<T> => (++calls === 1 ? hung.request(signal) : Promise.resolve(answer));
  return { hung, request };
}

const PROVIDERS: Array<{ provider: string; build: () => HangingProvider }> = [
  {
    provider: "anthropic",
    build: () => {
      const { hung, request } = hangsFirstRequest({ content: [{ type: "text", text: REPLY }] });
      const client = { messages: { create: (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => request(options?.signal) } };
      return { hung, adapter: new AnthropicAdapter({ clientFactory: async () => client, turnTimeoutMs: SHORT_TURN_TIMEOUT_MS }) };
    },
  },
  {
    provider: "openai",
    build: () => {
      const { hung, request } = hangsFirstRequest({ choices: [{ message: { content: REPLY } }] });
      const client = {
        chat: { completions: { create: (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => request(options?.signal) } },
      };
      return { hung, adapter: new OpenAIAdapter({ clientFactory: async () => client, turnTimeoutMs: SHORT_TURN_TIMEOUT_MS }) };
    },
  },
  {
    provider: "gemini",
    build: () => {
      const { hung, request } = hangsFirstRequest({ text: REPLY });
      const model = new GeminiToolCallingModel({
        model: "gemini-3-flash-preview",
        clientFactory: async () => ({
          models: { generateContent: (params: Record<string, unknown>) => request((params.config as { abortSignal?: AbortSignal }).abortSignal) },
        }),
        partFactory: {
          createPartFromFunctionCall: (name, args) => ({ functionCall: { name, args } }),
          createPartFromFunctionResponse: (id, name, response) => ({ functionResponse: { id, name, response } }),
        },
      });
      return { hung, adapter: new GeminiAdapter({ model, turnTimeoutMs: SHORT_TURN_TIMEOUT_MS }) };
    },
  },
  {
    provider: "vercel-ai-sdk",
    build: () => {
      const { hung, request } = hangsFirstRequest({ text: REPLY });
      const adapter = new VercelAISDKAdapter({
        model: { id: "test-model" },
        generateText: (params) => request(params.abortSignal as AbortSignal | undefined),
        toolFactory: (definition) => definition,
        turnTimeoutMs: SHORT_TURN_TIMEOUT_MS,
      });
      return { hung, adapter };
    },
  },
];

describe("A tool-calling turn that hangs", () => {
  it.each(PROVIDERS)("fails its own message on $provider and still runs the one behind it", async ({ provider, build }) => {
    const { adapter, hung } = build();
    await using session = await BandPlatform.join(adapter, [person(USER)]);
    const { room } = session;

    const first = await room.say(USER, `@[[${AGENT_ID}]] this turn hangs`);
    const last = await room.say(USER, `@[[${AGENT_ID}]] this one must not wait for it`);

    expect(await room.outcome(first)).toBe("failed");
    expect(await room.outcome(last)).toBe("processed");
    expect(hung.signal?.aborted).toBe(true);
    expect(room.messages.map((posted) => posted.content)).toEqual([REPLY]);
    expect(room.events(FAILURE_EVENT_TYPE).map((posted) => posted.metadata?.failure)).toEqual([
      expect.objectContaining({ provider, code: FAILURE_CODE_TIMEOUT }),
    ]);
  });
});

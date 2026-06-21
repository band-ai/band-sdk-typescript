/**
 * INT-853 — LangGraph streaming adapter: live e2e test (showcases the fix).
 *
 * Drives the REAL stack end-to-end — a real Claude model wired into a real
 * LangGraph `createReactAgent`, running as a real Thenvoi agent ("tom") on the
 * dev platform, driven by a second real agent ("jery") — and asserts the correct
 * post-fix behavior. It doubles as a live regression guard for
 * `packages/sdk/src/adapters/langgraph/LangGraphAdapter.ts`.
 *
 * Coverage of the six INT-853 issues:
 *   1. streamEvents version on config (arg 2)  ── asserted here (agent replies at all;
 *      the unfixed adapter throws here and the agent stays silent).
 *   3. AIMessage/AIMessageChunk parsing         ── asserted here (a non-empty reply
 *      can only surface if the streamed AIMessageChunk is parsed).
 *   4. __end__/__start__ markers filtered        ── asserted here (reply is marker-free).
 *   6. single system prompt on createReactAgent  ── asserted here (via PromptRecorder).
 *   2. on_chain_end chain filtering              ── covered deterministically by the unit
 *      test "ignores LangGraph routing markers and parses LangChain assistant messages".
 *   5. history replayed every turn               ── covered deterministically by the unit
 *      test "includes room history on follow-up messages".
 *   (Issues 2 & 5 are unit-tested rather than asserted live: the shared "tom" test agent
 *    does not reliably process a second message in a room within one session, which makes
 *    a live multi-turn assertion flaky. See packages/sdk/tests/langgraph-adapter.test.ts.)
 *
 * OPT-IN / skipped by default: runs only when `E2E_TESTS_ENABLED=true` is set in
 * the environment (the `pnpm test:e2e` script sets it). The normal `pnpm test`
 * run never sets it, so this suite is skipped — keeping the unit suite offline.
 *
 * Requires `.env.test` (repo root) with Anthropic + tom/jery + platform
 * credentials, and the `@langchain/anthropic` dev dependency.
 *
 * Run:  cd packages/sdk && pnpm test:e2e
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { ThenvoiClient } from "@thenvoi/rest-client";

import { Agent } from "../../src/index";
import { LangGraphAdapter } from "../../src/adapters/langgraph";
import { ConsoleLogger } from "../../src/core";
import { FernRestAdapter } from "../../src/rest";
import type { PlatformChatMessage, RestApi } from "../../src/client/rest/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function mask(value: string): string { return value.length <= 8 ? "****" : `${value.slice(0, 8)}****`; }

/** Plain-text view of a LangChain message's content. */
function messageText(m: BaseMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** Render a LangChain message list compactly so the test output is readable. */
function describePrompt(messages: BaseMessage[]): string {
  return messages
    .map((m, i) => {
      const preview = messageText(m).replace(/\s+/g, " ").slice(0, 80);
      return `    [${i}] ${m.getType()}: ${preview}`;
    })
    .join("\n");
}

/** Parse .env.test (repo root) without a dotenv dependency. */
function loadEnvTest(): Record<string, string> {
  const envPath = fileURLToPath(new URL("../../../../.env.test", import.meta.url));
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`.env.test is missing required key: ${key}`);
  return value;
}

// Captures exactly what the real model receives each call — the observation point
// for issue 6 (single system prompt). Just a callback on the real ChatAnthropic;
// no model faking or wrapping.
class PromptRecorder extends BaseCallbackHandler {
  public readonly name = "int853-prompt-recorder";
  /** One entry per model call: the message list the model was given. */
  public readonly calls: BaseMessage[][] = [];

  override handleChatModelStart(_llm: unknown, messages: BaseMessage[][]): void {
    const prompt = messages[0] ?? [];
    this.calls.push(prompt);
    console.log(`int853   🧠 model call #${this.calls.length} received ${prompt.length} message(s):`);
    console.log(describePrompt(prompt));
  }
}

/**
 * Wait for a NEW text message from `agentId`, deduped by message id (server
 * timestamps can't be compared against the local clock reliably). `seen` is
 * mutated with every message id observed.
 */
async function waitForNewAgentText(
  rest: RestApi,
  chatId: string,
  agentId: string,
  seen: Set<string>,
  timeoutMs: number,
): Promise<PlatformChatMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await rest.listMessages?.({ chatId, page: 1, pageSize: 50 });
    const fresh = (page?.data ?? []).filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.add(m.id);
    const texts = fresh.filter((m) => m.sender_id === agentId && m.message_type === "text");
    if (texts.length > 0) return texts;
    await sleep(1500);
  }
  return [];
}

// ── Gated live suite ─────────────────────────────────────────────────────────
// `pnpm test:e2e` sets E2E_TESTS_ENABLED=true; the normal `pnpm test` does not.

const E2E_ENABLED = process.env.E2E_TESTS_ENABLED === "true";

describe.skipIf(!E2E_ENABLED)("INT-853 LangGraph streaming adapter (live e2e)", () => {
  const recorder = new PromptRecorder();
  let cleanup: (() => Promise<void>) | undefined;

  // Captured once in beforeAll; each test is a pure assertion on this state.
  let replyTexts: PlatformChatMessage[] = [];

  beforeAll(async () => {
    const env = loadEnvTest();
    const restUrl = requireEnv(env, "BAND_REST_URL");
    const anthropicKey = requireEnv(env, "ANTHROPIC_API_KEY");
    const model = env.E2E_ANTHROPIC_MODEL || env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const tomKey = requireEnv(env, "BAND_API_KEY");
    const jeryKey = requireEnv(env, "BAND_API_KEY_2");
    const wsUrl = env.BAND_WS_URL;
    const timeoutMs = Math.max((Number(env.E2E_TIMEOUT) || 30) * 1000, 90_000);

    const logger = new ConsoleLogger();
    console.log(`int853 platform: ${restUrl}  model: ${model} (key ${mask(anthropicKey)})`);

    const tomRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: restUrl, apiKey: tomKey }));
    const jeryRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: restUrl, apiKey: jeryKey }));

    const tomMe = await tomRest.getAgentMe();
    const jeryMe = await jeryRest.getAgentMe();
    console.log(`int853 tom="${tomMe.name}" (${tomMe.id})  jery="${jeryMe.name}" (${jeryMe.id})`);

    // Real model → real createReactAgent (built inside the adapter's `llm` path).
    const llm = new ChatAnthropic({ model, apiKey: anthropicKey, callbacks: [recorder] });
    const adapter = new LangGraphAdapter({
      llm,
      emitExecutionEvents: true,
      customSection: "Reply to the user conversationally in plain text.",
      logger,
    });

    // Start tom WITHOUT auto-subscribing to its existing rooms — otherwise it would
    // bootstrap tom's entire real backlog (slow + costly). tom subscribes to our chat
    // dynamically via the platform's `room_added` event below.
    const tom = Agent.create({
      adapter,
      agentId: tomMe.id,
      apiKey: tomKey,
      ...(wsUrl ? { wsUrl } : {}),
      restUrl,
      linkOptions: { restApi: tomRest, logger },
      agentConfig: { autoSubscribeExistingRooms: false },
    });
    await tom.start();

    // jery creates the room and adds tom → tom gets `room_added` and subscribes.
    const chat = await jeryRest.createChat();
    await jeryRest.addChatParticipant(chat.id, { participantId: tomMe.id, role: "member" });
    console.log(`int853 chat ${chat.id} created; tom added`);
    cleanup = async () => {
      try { await jeryRest.removeChatParticipant(chat.id, tomMe.id); } catch { /* best-effort */ }
      try { await tom.stop(5000); } catch { /* best-effort */ }
    };
    await sleep(4000); // let tom receive room_added and subscribe before the trigger

    // Track existing message ids so reply detection is by-id, never by timestamp.
    const seen = new Set<string>();
    const existing = await jeryRest.listMessages?.({ chatId: chat.id, page: 1, pageSize: 50 });
    for (const m of existing?.data ?? []) seen.add(m.id);

    // jery introduces a name; tom must produce a clean greeting through the full
    // streamEvents → AIMessageChunk-parse → reply path. (Pre-fix, the adapter throws
    // on streamEvents and tom stays silent.)
    await jeryRest.createChatMessage(chat.id, {
      content: `@${tomMe.name} Hi, my name is Alex. Please greet me by name.`,
      mentions: [{ id: tomMe.id, handle: tomMe.name }],
    });
    replyTexts = await waitForNewAgentText(jeryRest, chat.id, tomMe.id, seen, timeoutMs);
    console.log(`int853 reply: ${JSON.stringify(replyTexts.map((m) => m.content))}`);
  }, 240_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("issues 1 & 3: the agent emits a reply (streamEvents v2 + AIMessageChunk parsing)", () => {
    const reply = replyTexts.map((m) => m.content).join("\n").trim();
    expect(replyTexts.length).toBeGreaterThan(0);
    expect(reply.length).toBeGreaterThan(0);
  });

  it("issue 4: the reply contains no internal LangGraph markers", () => {
    const reply = replyTexts.map((m) => m.content).join("\n");
    expect(reply).not.toContain("__end__");
    expect(reply).not.toContain("__start__");
  });

  it("issue 6: the createReactAgent path injects exactly one system prompt", () => {
    const systemCounts = recorder.calls.map(
      (call) => call.filter((m) => m.getType() === "system").length,
    );
    expect(systemCounts.length).toBeGreaterThan(0);
    // No call may carry a doubled system prompt, and at least one must carry the prompt.
    expect(systemCounts.every((n) => n <= 1)).toBe(true);
    expect(systemCounts.some((n) => n === 1)).toBe(true);
  });
});

/**
 * Live E2E: retry exhaustion via sync-recovery, gated by BAND_E2E_LANE="core".
 *
 * Sending one message to an always-throwing handler over a live WebSocket
 * cannot reach `maxMessageRetries` attempts: `PlatformRuntime.executeAdapter`
 * calls `markFailed` once and re-throws on a live WS adapter throw, and
 * `Execution.executeEvent` stops the whole execution on that same throw —
 * neither path ever touches `RetryTracker`. `recordAttempt`/
 * `isPermanentlyFailed` are called only inside `Execution.executeSyncMessage`,
 * which runs exclusively during startup backlog/stale-message recovery.
 *
 * So this seeds a message via REST *before* connecting the agent (it must
 * sit unprocessed in a room the agent already belongs to at startup), starts
 * the agent with `agentConfig: { autoSubscribeExistingRooms: true }` (so
 * `subscribeExistingRooms()` actually hydrates the existing room and calls
 * `getOrCreateExecution`, whose constructor runs the sync pass that picks up
 * the seeded message) and `maxMessageRetries: 0` (so the very first
 * `recordAttempt` already exceeds). Spies on the real
 * `rest.markMessageFailed` call (write-only — no read-back endpoint exists,
 * so "live" means everything up to that call is real: REST backlog fetch,
 * real `Execution` sync-recovery path, real wasm `RetryTracker.recordAttempt`;
 * only the final call is wrapped-and-forwarded, not replaced).
 *
 * Run:  BAND_E2E_LANE=core npx tsx tests/integration/core-retry-participant-live.ts
 */
import { BandClient } from "@band-ai/rest-client";

import { Agent, GenericAdapter, loadAgentConfig } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import { shouldRunLane } from "./lanes";

const DEFAULT_REST_URL = "https://app.band.ai/";

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

function pass(name: string) { results.push({ name, passed: true }); console.log(`  ✅ ${name}`); }
function fail(name: string, error: string) { results.push({ name, passed: false, error }); console.log(`  ❌ ${name}: ${error}`); }
function assert(name: string, condition: boolean, errorMsg: string) { condition ? pass(name) : fail(name, errorMsg); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  if (!shouldRunLane("core")) {
    return;
  }

  console.log("core-retry === retry exhaustion via sync-recovery ===");

  const testConfig = loadAgentConfig("basic_agent");
  const senderConfig = loadAgentConfig("planner_agent");
  const restUrl = testConfig.restUrl ?? DEFAULT_REST_URL;

  const testRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: testConfig.apiKey }));
  const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderConfig.apiKey }));

  const testMe = await testRest.getAgentMe();
  const senderMe = await senderRest.getAgentMe();
  console.log(`core-retry Test agent: "${testMe.name}" (${testMe.id})`);

  // The test agent's own room — it's already a participant at creation.
  const chat = await testRest.createChat();
  await testRest.addChatParticipant(chat.id, { participantId: senderMe.id, role: "member" });
  console.log(`core-retry Created chat: ${chat.id}`);

  // Seed the message via REST *before* the agent connects, from a
  // different identity (self-authored messages are skipped by the
  // preprocessor before ever reaching RetryTracker).
  const seeded = await senderRest.createChatMessage(chat.id, {
    content: `@${testMe.name} this must permanently fail on the first sync-recovery attempt`,
    mentions: [{ id: testMe.id, handle: testMe.name }],
  });
  const seededId = String(seeded.id ?? "");
  assert("seeded message has an id", seededId.length > 0, `seeded=${JSON.stringify(seeded)}`);

  const markMessageFailedCalls: Array<{ chatId: string; messageId: string; error: string }> = [];
  const originalMarkMessageFailed = testRest.markMessageFailed.bind(testRest);
  testRest.markMessageFailed = async (chatId, messageId, error, options) => {
    markMessageFailedCalls.push({ chatId, messageId, error });
    return originalMarkMessageFailed(chatId, messageId, error, options);
  };

  const adapter = new GenericAdapter(async () => {
    throw new Error("this adapter must never run — maxMessageRetries: 0 exhausts before it's called");
  });

  const agent = Agent.create({
    adapter,
    agentId: testConfig.agentId,
    apiKey: testConfig.apiKey,
    linkOptions: { restApi: testRest },
    sessionConfig: { maxMessageRetries: 0 },
    agentConfig: { autoSubscribeExistingRooms: true },
  });

  console.log("core-retry Starting agent (autoSubscribeExistingRooms: true)...");
  await agent.start();

  console.log("core-retry Waiting for startup sync-recovery to process the backlog...");
  await sleep(8000);

  await agent.stop(5000);

  assert(
    "rest.markMessageFailed called exactly once, for the seeded message",
    markMessageFailedCalls.length === 1
      && markMessageFailedCalls[0]?.chatId === chat.id
      && markMessageFailedCalls[0]?.messageId === seededId,
    `calls=${JSON.stringify(markMessageFailedCalls)}`,
  );
  assert(
    "marked with the permanently-failed error string",
    markMessageFailedCalls[0]?.error === "Message permanently failed after max retries",
    `error=${markMessageFailedCalls[0]?.error}`,
  );

  const failed = results.filter((r) => !r.passed);
  console.log(`\ncore-retry ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("core-retry FAILED:", err);
  process.exit(1);
});

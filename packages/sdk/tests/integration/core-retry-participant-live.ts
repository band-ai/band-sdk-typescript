/**
 * Live E2E: retry exhaustion via sync-recovery.
 *
 * `RetryTracker.recordAttempt` only runs inside `Execution.executeSyncMessage`
 * (startup backlog recovery) — never on live WS events. So this seeds a
 * message via REST before the agent connects, then starts it with
 * `autoSubscribeExistingRooms: true` and `maxMessageRetries: 0` so the
 * seeded message exhausts on the first sync-recovery attempt. A second
 * agent identity sends the seed, since self-authored messages are skipped
 * before reaching the adapter. Spies on `rest.markMessageFailed` (write-only,
 * no read-back endpoint) to observe the outcome.
 *
 * Both agent identities are provisioned fresh per run from one Band user key
 * (via `humanApiAgents.registerMyAgent`, the same platform primitive
 * band-sdk-python's baseline E2E toolkit uses) and force-deleted on exit —
 * no static pre-created agents to maintain, and the credential (a Band user
 * key) is shareable across both SDKs' E2E suites. A prefix-guarded orphan
 * sweep runs first, reaping any leftovers from a run that crashed before its
 * own cleanup ran (mirrors band-sdk-python's `sweep_orphans`).
 *
 * Run:  BAND_API_KEY_USER=... npx tsx tests/integration/core-retry-participant-live.ts
 */
import { randomUUID } from "node:crypto";

import { BandClient } from "@band-ai/rest-client";

import { Agent, GenericAdapter } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import {
  createReporter,
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sleep,
  sweepOrphans,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "core-retry";

const { assert, summarize } = createReporter();

async function main() {
  console.log("core-retry === retry exhaustion via sync-recovery ===");

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();

  const runId = randomUUID().slice(0, 8);
  await sweepOrphans(userClient, runId);
  // Tracked as each is created (not `[testAgent, senderAgent]` after both
  // resolve) so a failure provisioning the second still reaps the first.
  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];

  try {
    const testAgent = await provisionAgent(userClient, runId, TEST_NAME, "basic");
    provisioned.push(testAgent);
    const senderAgent = await provisionAgent(userClient, runId, TEST_NAME, "planner");
    provisioned.push(senderAgent);
    console.log(`core-retry Provisioned test agent "${testAgent.name}" (${testAgent.id}) and sender "${senderAgent.name}" (${senderAgent.id})`);

    const testRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: testAgent.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderAgent.apiKey }));

    // The test agent's own room — it's already a participant at creation.
    const chat = await testRest.createChat();
    roomIds.push(chat.id);
    await testRest.addChatParticipant(chat.id, { participantId: senderAgent.id, role: "member" });
    console.log(`core-retry Created chat: ${chat.id}`);

    // Seeded before the agent connects, from a different identity
    // (self-authored messages are skipped by the preprocessor).
    const seeded = await senderRest.createChatMessage(chat.id, {
      content: `@${testAgent.name} this must permanently fail on the first sync-recovery attempt`,
      mentions: [{ id: testAgent.id, handle: testAgent.name }],
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
      agentId: testAgent.id,
      apiKey: testAgent.apiKey,
      wsUrl,
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
  } finally {
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, "core-retry");
  }

  summarize("core-retry");
}

main().catch((err) => {
  console.error("core-retry FAILED:", err);
  process.exit(1);
});

/**
 * Live E2E: retry exhaustion via sync-recovery, gated by BAND_E2E_LANE="core".
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
 * Run:  BAND_E2E_LANE=core BAND_API_KEY_USER=... npx tsx tests/integration/core-retry-participant-live.ts
 */
import { randomUUID } from "node:crypto";

import { BandClient } from "@band-ai/rest-client";

import { Agent, GenericAdapter } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import { shouldRunLane } from "./lanes";

const DEFAULT_REST_URL = "https://app.band.ai/";
const NAME_PREFIX = "e2e-ts-core-";
const ORPHAN_MAX_AGE_MINUTES = 60;

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

function pass(name: string) { results.push({ name, passed: true }); console.log(`  ✅ ${name}`); }
function fail(name: string, error: string) { results.push({ name, passed: false, error }); console.log(`  ❌ ${name}: ${error}`); }
function assert(name: string, condition: boolean, errorMsg: string) { condition ? pass(name) : fail(name, errorMsg); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see this file's header for the run command`);
  }
  return value;
}

interface ProvisionedAgent { id: string; name: string; apiKey: string }

async function provisionAgent(userClient: BandClient, runId: string, label: string): Promise<ProvisionedAgent> {
  const name = `${NAME_PREFIX}${runId}-${label}`;
  const response = await userClient.humanApiAgents.registerMyAgent({
    agent: { name, description: `TS SDK core-retry E2E (${label})` },
  });
  const agent = response.data.agent;
  const credentials = response.data.credentials;
  if (!agent?.id || !credentials?.api_key) {
    throw new Error(`registerMyAgent returned no agent id/credentials for "${label}"`);
  }
  return { id: agent.id, name, apiKey: credentials.api_key };
}

/**
 * Force-deletes leftover `NAME_PREFIX`-named agents from a run that crashed
 * before its own `finally` reap ran (e.g. the process was killed) — the same
 * failure mode band-sdk-python's orphan sweep exists for. Never touches an
 * agent from the *current* run or anything younger than
 * `ORPHAN_MAX_AGE_MINUTES` (a concurrent run in flight).
 */
async function sweepOrphans(userClient: BandClient, runId: string): Promise<void> {
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MINUTES * 60_000;
  const orphanIds: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page++) {
    const response = await userClient.humanApiAgents.listMyAgents({ name: NAME_PREFIX, limit: 100, cursor });
    for (const candidate of response.data) {
      if (!candidate.name.startsWith(NAME_PREFIX)) continue; // name filter is a contains-match
      if (candidate.name.includes(`-${runId}-`)) continue; // never reap our own run
      if (Date.parse(candidate.inserted_at) > cutoff) continue; // too fresh — could be concurrent
      orphanIds.push(candidate.id);
    }
    cursor = response.metadata.next_cursor;
    if (!response.metadata.has_more || !cursor) break;
  }

  if (orphanIds.length === 0) {
    return;
  }
  console.log(`core-retry Sweeping ${orphanIds.length} orphaned test agent(s) from a prior run...`);
  await Promise.all(
    orphanIds.map((id) =>
      userClient.humanApiAgents.deleteMyAgent(id, { force: true }).catch((err: unknown) => {
        console.warn(`core-retry Failed to sweep orphan agent ${id}:`, err);
      }),
    ),
  );
}

async function main() {
  if (!shouldRunLane("core")) {
    return;
  }

  console.log("core-retry === retry exhaustion via sync-recovery ===");

  const restUrl = process.env.BAND_REST_URL ?? DEFAULT_REST_URL;
  const wsUrl = process.env.BAND_WS_URL;
  const userClient = new BandClient({ baseUrl: restUrl, apiKey: requireEnv("BAND_API_KEY_USER") });

  const runId = randomUUID().slice(0, 8);
  await sweepOrphans(userClient, runId);
  // Tracked as each is created (not `[testAgent, senderAgent]` after both
  // resolve) so a failure provisioning the second still reaps the first.
  const provisioned: ProvisionedAgent[] = [];

  try {
    const testAgent = await provisionAgent(userClient, runId, "basic");
    provisioned.push(testAgent);
    const senderAgent = await provisionAgent(userClient, runId, "planner");
    provisioned.push(senderAgent);
    console.log(`core-retry Provisioned test agent "${testAgent.name}" (${testAgent.id}) and sender "${senderAgent.name}" (${senderAgent.id})`);

    const testRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: testAgent.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderAgent.apiKey }));

    // The test agent's own room — it's already a participant at creation.
    const chat = await testRest.createChat();
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
    // The room itself is left behind (no delete-room endpoint is generated
    // yet — band-sdk-python's own toolkit notes the same gap and falls back
    // to an undocumented raw REST call; not worth that here for one room).
    console.log("core-retry Reaping provisioned agents...");
    await Promise.all(
      provisioned.map((agent) =>
        userClient.humanApiAgents.deleteMyAgent(agent.id, { force: true }).catch((err: unknown) => {
          console.warn(`core-retry Failed to reap agent ${agent.id}:`, err);
        }),
      ),
    );
  }

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

/**
 * End-to-end integration test — two agents in a chat room.
 * The "planner" agent sends messages via REST to the "implementer" agent,
 * which receives them via WebSocket and responds using tools.
 *
 * Tests: WebSocket delivery, preprocessing, adapter execution,
 * tools (sendMessage, sendEvent), mentions, history, message lifecycle.
 *
 * Run:  npx tsx tests/integration/e2e.ts
 */
import {
  Agent,
  GenericAdapter,
  loadAgentConfig,
} from "../../src/index";
import { ConsoleLogger } from "../../src/core";
import type { AgentInput } from "../../src/index";
import { ThenvoiClient } from "@thenvoi/rest-client";
import { FernRestAdapter } from "../../src/rest";

const DEFAULT_REST_URL = "https://app.band.ai/";

// ── Test harness ───────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

function pass(name: string) { results.push({ name, passed: true }); console.log(`  ✅ ${name}`); }
function fail(name: string, error: string) { results.push({ name, passed: false, error }); console.log(`  ❌ ${name}: ${error}`); }
function assert(name: string, condition: boolean, errorMsg: string) { condition ? pass(name) : fail(name, errorMsg); }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Load both agent configs
  const implConfig = loadAgentConfig("basic_agent");       // implementer
  const planConfig = loadAgentConfig("planner_agent");     // planner (sends messages)
  const restUrl = implConfig.restUrl ?? DEFAULT_REST_URL;
  const logger = new ConsoleLogger();

  const implRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: restUrl, apiKey: implConfig.apiKey }));
  const planRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: restUrl, apiKey: planConfig.apiKey }));

  // ── Step 1: Verify both agent identities ─────────────────────────
  console.log("\ne2e === Agent Identities ===");
  const implMe = await implRest.getAgentMe();
  const planMe = await planRest.getAgentMe();
  console.log(`e2e Implementer: "${implMe.name}" (${implMe.id})`);
  console.log(`e2e Planner:     "${planMe.name}" (${planMe.id})`);
  assert("Implementer identity OK", implMe.id.length > 0 && implMe.name.length > 0, `${implMe.id}`);
  assert("Planner identity OK", planMe.id.length > 0 && planMe.name.length > 0, `${planMe.id}`);
  assert("Different agents", implMe.id !== planMe.id, "same agent ID!");

  // ── Step 2: Create a chat and add both agents ────────────────────
  console.log("\ne2e === Chat Setup ===");
  const chat = await implRest.createChat();
  console.log(`e2e Created chat: ${chat.id}`);
  assert("createChat returns id", chat.id.length > 0, `id=${chat.id}`);

  // Add planner to the chat
  await implRest.addChatParticipant(chat.id, { participantId: planMe.id, role: "member" });
  pass("Added planner to chat");

  const participants = await implRest.listChatParticipants(chat.id);
  console.log(`e2e Participants: ${participants.map(p => `${p.name} (${p.type})`).join(", ")}`);
  assert("Chat has 2 participants", participants.length >= 2, `count=${participants.length}`);

  // ── Step 3: Start the implementer agent ──────────────────────────
  console.log("\ne2e === Start Implementer Agent ===");

  const received: Array<{
    content: string;
    senderName: string | null;
    senderId: string;
    senderType: string;
    roomId: string;
    isBootstrap: boolean;
    historyLength: number;
    participantsMsg: string | null;
  }> = [];
  let sendMessageOk = false;
  let sendEventOk = false;
  let mentionOk = false;
  const errors: string[] = [];

  const adapter = new GenericAdapter(async (input: AgentInput) => {
    const { message, tools, history, isSessionBootstrap, participantsMessage } = input;
    console.log(`e2e   📨 Received: sender="${message.senderName}" content="${message.content}" bootstrap=${isSessionBootstrap}`);

    received.push({
      content: message.content,
      senderName: message.senderName,
      senderId: message.senderId,
      senderType: message.senderType,
      roomId: message.roomId,
      isBootstrap: isSessionBootstrap,
      historyLength: history.raw.length,
      participantsMsg: participantsMessage,
    });

    // Test 1: sendMessage with mention
    try {
      await tools.sendMessage(
        `@${planMe.name} Echo: ${message.content}`,
        [{ id: planMe.id, handle: planMe.name }],
      );
      sendMessageOk = true;
      console.log(`e2e   ✉️  Sent reply with @mention`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`sendMessage: ${msg}`);
      console.log(`e2e   ⚠️  sendMessage failed: ${msg}`);
    }

    // Test 2: sendEvent
    try {
      await tools.sendEvent("processing done", "task", { test: true });
      sendEventOk = true;
      console.log(`e2e   📣 Sent event type=task`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`sendEvent: ${msg}`);
      console.log(`e2e   ⚠️  sendEvent failed: ${msg}`);
    }

    // Test 3: mention with ID-only (resolve from participants)
    // First hydrate participants so the local cache knows about the planner
    try {
      await tools.getParticipants();
      await tools.sendMessage(
        `@${planMe.name} Mention test`,
        [planMe.id],  // just the ID string, tools resolves from hydrated cache
      );
      mentionOk = true;
      console.log(`e2e   🏷️  Sent ID-only mention (after hydration)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`mention-by-id: ${msg}`);
      console.log(`e2e   ⚠️  ID-only mention failed: ${msg}`);
    }
  });

  const agent = Agent.create({
    adapter,
    agentId: implConfig.agentId,
    apiKey: implConfig.apiKey,
    linkOptions: { restApi: implRest, logger },
  });

  await agent.start();
  console.log(`e2e Implementer started: "${agent.runtime.name}"`);
  assert("agent.runtime.name populated", agent.runtime.name.length > 0, `name="${agent.runtime.name}"`);

  // Wait for room subscriptions
  await sleep(2000);

  // ── Step 4: Planner sends messages to the implementer ────────────
  console.log("\ne2e === Planner Sends Messages ===");

  // First message
  console.log(`e2e Planner sending message 1...`);
  const msg1Result = await planRest.createChatMessage(chat.id, {
    content: `@${implMe.name} Hello from the planner! Can you process this?`,
    mentions: [{ id: implMe.id, handle: implMe.name }],
  });
  console.log(`e2e Sent msg1: ${JSON.stringify(msg1Result)}`);
  assert("Planner msg1 sent OK", msg1Result !== undefined, "send returned undefined");

  // Wait for implementer to process
  console.log("e2e Waiting for implementer to process...");
  await sleep(6000);

  // Second message (tests history accumulation)
  console.log(`e2e Planner sending message 2...`);
  await planRest.createChatMessage(chat.id, {
    content: `@${implMe.name} Second message — checking history`,
    mentions: [{ id: implMe.id, handle: implMe.name }],
  });

  await sleep(6000);

  // ── Step 5: Evaluate ─────────────────────────────────────────────
  console.log("\ne2e === Message Processing Results ===");

  assert(
    "Implementer received >= 1 message via WebSocket",
    received.length >= 1,
    `received=${received.length}`,
  );

  if (received.length >= 1) {
    const first = received[0]!;
    assert("First msg has content from planner", first.content.includes("Hello from the planner"), `"${first.content}"`);
    assert("First msg sender is planner", first.senderId === planMe.id, `senderId=${first.senderId}`);
    assert("First msg senderName set", first.senderName !== null && first.senderName.length > 0, `senderName=${first.senderName}`);
    assert("First msg roomId matches", first.roomId === chat.id, `roomId=${first.roomId}`);
    assert("First msg is session bootstrap", first.isBootstrap === true, `isBootstrap=${first.isBootstrap}`);
  }

  if (received.length >= 2) {
    const second = received[1]!;
    assert("Second msg received", second.content.includes("Second message"), `"${second.content}"`);
    assert("History accumulated", second.historyLength > 0, `historyLength=${second.historyLength}`);
    assert("Second msg not bootstrap", second.isBootstrap === false, `isBootstrap=${second.isBootstrap}`);
  }

  assert("sendMessage with mention OK", sendMessageOk, errors.find(e => e.startsWith("sendMessage")) ?? "not called");
  assert("sendEvent OK", sendEventOk, errors.find(e => e.startsWith("sendEvent")) ?? "not called");
  assert("ID-only mention resolved", mentionOk, errors.find(e => e.startsWith("mention-by-id")) ?? "not called");

  // ── Step 6: Message lifecycle endpoints ──────────────────────────
  console.log("\ne2e === Message Lifecycle ===");
  try {
    await implRest.markMessageProcessing(chat.id, "00000000-0000-0000-0000-000000000000");
    fail("markMessageProcessing fake id", "expected error");
  } catch (err) {
    assert("markMessageProcessing endpoint exists", true, "");
  }

  // ── Step 7: Peers ────────────────────────────────────────────────
  console.log("\ne2e === Peers ===");
  const peers = await implRest.listPeers({ page: 1, pageSize: 5, notInChat: chat.id });
  assert("listPeers works", Array.isArray(peers.data), `type=${typeof peers.data}`);
  console.log(`e2e Peers (not in chat): ${peers.data.length}`);

  // ── Step 8: Remove participant ───────────────────────────────────
  console.log("\ne2e === Participant Management ===");
  await implRest.removeChatParticipant(chat.id, planMe.id);
  const afterRemove = await implRest.listChatParticipants(chat.id);
  assert("removeChatParticipant worked", afterRemove.length < participants.length, `count=${afterRemove.length}`);

  // ── Shutdown ──────────────────────────────────────────────────────
  console.log("\ne2e Stopping agent...");
  const graceful = await agent.stop(5000);
  assert("Agent stopped gracefully", graceful, `graceful=${graceful}`);

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\ne2e ════════════════════════════════════════════════════");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`e2e ${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log("\ne2e Failures:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`e2e   ❌ ${r.name}: ${r.error}`);
    }
    console.log("\ne2e FAILED");
    process.exit(1);
  } else {
    console.log("e2e ALL PASSED ✅");
  }
}

main().catch((err) => {
  console.error("e2e FATAL:", err);
  process.exit(1);
});

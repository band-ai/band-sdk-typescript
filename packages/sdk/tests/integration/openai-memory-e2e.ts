/**
 * Live E2E harness for OpenAI ToolCalling memory tool usage.
 *
 * Verifies that an OpenAI agent with `includeMemoryTools: true` stores a durable
 * preference via `thenvoi_store_memory` when prompted in a Thenvoi chat room.
 *
 * Run:
 *   pnpm test:openai-memory-e2e
 *
 * Requires:
 *   - agent_config.yaml with openai_memory_agent credentials
 *   - OPENAI_API_KEY
 *   - THENVOI_API_KEY_USER (user REST client to send trigger messages)
 */
import { randomUUID } from "node:crypto";

import { ThenvoiClient } from "@thenvoi/rest-client";

import { loadAgentConfig } from "../../src/config";
import type { MemoryRecord } from "../../src/contracts/dtos";
import { FernRestAdapter } from "../../src/rest";
import { createOpenAIMemoryAgent } from "../../examples/openai/openai-memory-agent";

const REQUIRED_FLAG = "RUN_OPENAI_MEMORY_E2E";
const DEFAULT_REST_URL = "https://app.thenvoi.com/";
const DEFAULT_E2E_TIMEOUT_MS = 30_000;
const MEMORY_POLL_INTERVAL_MS = 5_000;
const ROOM_SUBSCRIBE_WAIT_MS = 2_000;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function pass(name: string): void {
  results.push({ name, passed: true });
  console.log(`  ✅ ${name}`);
}

function fail(name: string, error: string): void {
  results.push({ name, passed: false, error });
  console.log(`  ❌ ${name}: ${error}`);
}

function assert(name: string, condition: boolean, errorMsg: string): void {
  if (condition) {
    pass(name);
  } else {
    fail(name, errorMsg);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnabled(): boolean {
  return process.env[REQUIRED_FLAG] === "1";
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for this harness`);
  }
  return value;
}

function e2eTimeoutMs(): number {
  const parsed = Number(process.env.E2E_TIMEOUT ?? String(DEFAULT_E2E_TIMEOUT_MS / 1000));
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_E2E_TIMEOUT_MS;
}

async function listMemoriesContaining(
  agentRest: FernRestAdapter,
  marker: string,
  subjectIds: string[],
): Promise<MemoryRecord[]> {
  const queries: Array<{ pageSize: number; status: "active"; scope?: "organization"; subject_id?: string }> = [
    { pageSize: 50, status: "active", scope: "organization" },
    ...subjectIds.map((subjectId) => ({
      pageSize: 50,
      status: "active" as const,
      subject_id: subjectId,
    })),
  ];

  const matches: MemoryRecord[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const response = await agentRest.listMemories(query);
    for (const memory of response.data ?? []) {
      const memoryId = memory.id;
      const content = memory.content ?? "";
      if (memoryId && !seen.has(memoryId) && content.includes(marker)) {
        seen.add(memoryId);
        matches.push(memory);
      }
    }
  }

  return matches;
}

async function waitForMemoriesContaining(
  agentRest: FernRestAdapter,
  marker: string,
  subjectIds: string[],
  timeoutMs: number,
): Promise<MemoryRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: MemoryRecord[] = [];

  while (Date.now() < deadline) {
    lastResult = await listMemoriesContaining(agentRest, marker, subjectIds);
    if (lastResult.length > 0) {
      return lastResult;
    }
    await sleep(MEMORY_POLL_INTERVAL_MS);
  }

  return lastResult;
}

async function waitForAgentReply(
  agentRest: FernRestAdapter,
  chatId: string,
  agentId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await agentRest.listMessages({
      chatId,
      page: 1,
      pageSize: 50,
    });
    const agentMessages = (response.data ?? []).filter(
      (message) => message.sender_id === agentId && message.sender_type === "Agent",
    );
    if (agentMessages.length > 0) {
      return true;
    }
    await sleep(2_000);
  }

  return false;
}

async function main(): Promise<void> {
  if (!isEnabled()) {
    console.log(
      `openai-memory e2e skipped. Set ${REQUIRED_FLAG}=1 to run this live integration harness.`,
    );
    return;
  }

  requireEnv("OPENAI_API_KEY");
  const userApiKey = requireEnv("THENVOI_API_KEY_USER");

  const agentConfig = loadAgentConfig("openai_memory_agent");
  const restUrl = agentConfig.restUrl ?? DEFAULT_REST_URL;
  const timeoutMs = e2eTimeoutMs();
  const marker = `OPENAI_MEMORY_E2E_${randomUUID().replace(/-/g, "")}`;

  const agentRest = new FernRestAdapter(
    new ThenvoiClient({ baseUrl: restUrl, apiKey: agentConfig.apiKey }),
  );
  const userClient = new ThenvoiClient({ baseUrl: restUrl, apiKey: userApiKey });

  console.log("\nopenai-memory e2e === Setup ===");
  const agentMe = await agentRest.getAgentMe();
  console.log(`openai-memory e2e Agent: "${agentMe.name}" (${agentMe.id})`);
  assert("Agent identity OK", agentMe.id.length > 0 && agentMe.name.length > 0, `${agentMe.id}`);

  const peers = await agentRest.listPeers({ page: 1, pageSize: 50, notInChat: "" });
  const userPeer = peers.data.find((peer) => peer.type === "User");
  if (!userPeer?.id) {
    throw new Error("No User peer available for E2E test");
  }
  pass(`Found user peer "${userPeer.name ?? userPeer.id}"`);

  console.log("\nopenai-memory e2e === Start Agent ===");
  const agent = createOpenAIMemoryAgent(
    { apiKey: process.env.OPENAI_API_KEY },
    agentConfig,
  );
  await agent.start();
  console.log(`openai-memory e2e Agent started: "${agent.runtime.name}"`);

  let chatId = "";
  try {
    console.log("\nopenai-memory e2e === Chat Setup ===");
    const chat = await agentRest.createChat();
    chatId = chat.id;
    console.log(`openai-memory e2e Created chat: ${chatId}`);
    assert("createChat returns id", chatId.length > 0, `id=${chatId}`);

    await agentRest.addChatParticipant(chatId, {
      participantId: userPeer.id,
      role: "member",
    });
    pass("Added user peer to chat");

    await sleep(ROOM_SUBSCRIBE_WAIT_MS);

    console.log("\nopenai-memory e2e === Trigger Message ===");
    const prompt =
      "Remember this durable preference exactly: " +
      `${marker} means I prefer concise memory test responses. ` +
      "Store it as a long-term semantic user memory, then acknowledge it briefly.";

    await userClient.humanApiMessages.sendMyChatMessage(chatId, {
      message: {
        content: `@${agentMe.name} ${prompt}`,
        mentions: [{ id: agentMe.id, handle: agentMe.name, name: agentMe.name }],
      },
    });
    pass("Sent trigger message with agent mention");

    console.log("\nopenai-memory e2e === Wait For Agent Processing ===");
    const memories = await waitForMemoriesContaining(
      agentRest,
      marker,
      [userPeer.id, agentMe.id],
      timeoutMs,
    );
    assert(
      "Agent stored memory containing marker",
      memories.length > 0,
      `expected memory containing ${marker}`,
    );
    if (memories.length > 0) {
      console.log(`openai-memory e2e Found memory: ${memories[0]?.id}`);
    }

    const replied = await waitForAgentReply(agentRest, chatId, agentMe.id, 5_000);
    if (replied) {
      pass("Agent replied in chat");
    } else {
      console.log("openai-memory e2e note: no text reply observed (memory store succeeded)");
    }
  } finally {
    console.log("\nopenai-memory e2e === Shutdown ===");
    const graceful = await agent.stop(timeoutMs);
    assert("Agent stopped gracefully", graceful, `graceful=${graceful}`);
  }

  console.log("\nopenai-memory e2e ════════════════════════════════════════════════════");
  const passed = results.filter((result) => result.passed).length;
  const failed = results.filter((result) => !result.passed).length;
  console.log(`openai-memory e2e ${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log("\nopenai-memory e2e Failures:");
    for (const result of results.filter((item) => !item.passed)) {
      console.log(`openai-memory e2e   ❌ ${result.name}: ${result.error}`);
    }
    console.log("\nopenai-memory e2e FAILED");
    process.exit(1);
  }

  console.log("openai-memory e2e ALL PASSED ✅");
}

main().catch((error: unknown) => {
  console.error("openai-memory e2e FATAL:", error);
  process.exit(1);
});

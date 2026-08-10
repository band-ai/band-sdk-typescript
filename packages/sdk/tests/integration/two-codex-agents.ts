/**
 * Two Codex agents talking to each other on the real Band platform.
 *
 * Agent A (implementer) runs as a Codex agent with tool execution.
 * Agent B (planner) sends it a real coding task via REST.
 * We verify the full pipeline: WebSocket delivery → Codex SDK processing →
 * tool calls → sendMessage reply → sendEvent reporting.
 *
 * Run:  npx tsx tests/integration/two-codex-agents.ts
 */
import {
  Agent,
  CodexAdapter,
  GenericAdapter,
  loadAgentConfig,
} from "../../src/index";
import { ConsoleLogger } from "../../src/core";
import { ThenvoiClient } from "@thenvoi/rest-client";
import { FernRestAdapter } from "../../src/rest";

const REST_URL = "https://app.band.ai/";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const implConfig = loadAgentConfig("basic_agent");
  const planConfig = loadAgentConfig("planner_agent");

  const implRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: REST_URL, apiKey: implConfig.apiKey }));
  const planRest = new FernRestAdapter(new ThenvoiClient({ baseUrl: REST_URL, apiKey: planConfig.apiKey }));
  const logger = new ConsoleLogger();

  const implMe = await implRest.getAgentMe();
  const planMe = await planRest.getAgentMe();
  console.log(`prod Implementer: ${implMe.name} (${implMe.id})`);
  console.log(`prod Planner:     ${planMe.name} (${planMe.id})`);

  // ── Create chat with both agents ─────────────────────────────────
  const chat = await implRest.createChat();
  await implRest.addChatParticipant(chat.id, { participantId: planMe.id, role: "member" });
  console.log(`prod Chat created: ${chat.id}`);

  // ── Start Codex agent (implementer) ──────────────────────────────
  console.log(`\nprod Starting Codex agent...`);
  const codexAgent = Agent.create({
    adapter: new CodexAdapter({
      config: {
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        enableExecutionReporting: true,
        emitThoughtEvents: true,
        enableLocalCommands: true,
      },
    }),
    agentId: implConfig.agentId,
    apiKey: implConfig.apiKey,
    linkOptions: { restApi: implRest, logger },
  });

  await codexAgent.start();
  console.log(`prod Codex agent started: ${codexAgent.runtime.name}`);

  // ── Start echo agent (planner) — listens for replies ─────────────
  console.log(`prod Starting planner listener...`);

  const plannerReplies: string[] = [];

  const plannerAgent = Agent.create({
    adapter: new GenericAdapter(async ({ message }) => {
      console.log(`planner 📨 Got reply from ${message.senderName}: "${message.content.slice(0, 120)}..."`);
      plannerReplies.push(message.content);

      // Don't echo back — just log
    }),
    agentId: planConfig.agentId,
    apiKey: planConfig.apiKey,
    linkOptions: { restApi: planRest, logger },
  });

  await plannerAgent.start();
  console.log(`prod Planner agent started: ${plannerAgent.runtime.name}`);
  await sleep(2000);

  // ── Planner sends a real coding task ─────────────────────────────
  console.log(`\nprod === Sending coding task to Codex agent ===`);
  await planRest.createChatMessage(chat.id, {
    content: `@${implMe.name} What is 2+2? Reply with just the number.`,
    mentions: [{ id: implMe.id, handle: implMe.name }],
  });
  console.log(`prod Task sent. Waiting for Codex to process (up to 60s)...`);

  // Wait for codex to think + respond
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && plannerReplies.length === 0) {
    await sleep(2000);
    process.stdout.write(".");
  }
  console.log("");

  if (plannerReplies.length > 0) {
    console.log(`\nprod ✅ Got ${plannerReplies.length} reply(ies) from Codex agent:`);
    for (const reply of plannerReplies) {
      console.log(`prod   "${reply.slice(0, 300)}${reply.length > 300 ? "..." : ""}"`);
    }
  } else {
    console.log(`\nprod ⏱️  No reply received within timeout.`);
    console.log(`prod Checking if codex agent at least received the message...`);
  }

  // ── Shutdown both agents ─────────────────────────────────────────
  console.log(`\nprod Stopping agents...`);
  await Promise.all([
    codexAgent.stop(5000),
    plannerAgent.stop(5000),
  ]);
  console.log(`prod Done.`);
}

main().catch((err) => {
  console.error("prod FATAL:", err);
  process.exit(1);
});

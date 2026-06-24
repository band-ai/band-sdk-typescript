/**
 * Integration smoke test — connects to the real Band platform,
 * verifies agent identity, starts the basic echo agent, and shuts down.
 *
 * Run:  npx tsx tests/integration/smoke.ts
 */
import { ThenvoiClient } from "@thenvoi/rest-client";

import { Agent, GenericAdapter, loadAgentConfig } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";

const DEFAULT_REST_URL = "https://app.band.ai/";

async function main() {
  const config = loadAgentConfig("basic_agent");
  const restUrl = config.restUrl ?? DEFAULT_REST_URL;

  console.log("smoke Agent ID:", config.agentId);

  const restApi = new FernRestAdapter(new ThenvoiClient({ baseUrl: restUrl, apiKey: config.apiKey }));

  // --- Step 1: Test REST identity ---
  console.log("smoke Fetching agent identity...");
  const me = await restApi.getAgentMe();
  console.log(`smoke Identity: name="${me.name}", description="${me.description}"`);

  // --- Step 2: Full Agent lifecycle (uses default ws_url/rest_url) ---
  const received: string[] = [];

  const adapter = new GenericAdapter(async ({ message, tools }) => {
    console.log(`smoke Message from ${message.senderName}: "${message.content}"`);
    received.push(message.content);
    await tools.sendMessage(`Echo: ${message.content}`, [
      { id: message.senderId, handle: message.senderName ?? message.senderType },
    ]);
    console.log("smoke Sent echo reply");
  });

  const agent = Agent.create({
    adapter,
    agentId: config.agentId,
    apiKey: config.apiKey,
    linkOptions: { restApi },
  });

  console.log("smoke Starting agent...");
  await agent.start();
  console.log("smoke Agent started! Name:", agent.runtime.name);

  console.log("smoke Listening for 10 seconds...");
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  console.log("smoke Stopping agent...");
  await agent.stop(5000);
  console.log(`smoke Stopped. Received ${received.length} message(s).`);
  console.log("smoke PASSED");
}

main().catch((err) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});

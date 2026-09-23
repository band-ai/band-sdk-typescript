/**
 * Real AWS Kiro CLI ACP smoke test. The discovered live workflow runs this
 * only when its CLI/authentication prerequisites are configured.
 *
 * Run: BAND_API_KEY_USER=... KIRO_API_KEY=... npx tsx tests/integration/kiro-acp-live.ts
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { Agent, DEFAULT_KIRO_ACP_COMMAND, KiroACPAdapter } from "../../src/index";
import { BandLink } from "../../src/platform/BandLink";
import { FernRestAdapter } from "../../src/rest";
import {
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sweepOrphans,
  waitForEvent,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "kiro-acp";
const KIRO_API_KEY_ENV = "KIRO_API_KEY";

function hasKiroCli(): boolean {
  return spawnSync(DEFAULT_KIRO_ACP_COMMAND[0], ["--version"], { stdio: "ignore" }).status === 0;
}

function hasKiroAuth(): boolean {
  return Boolean(process.env[KIRO_API_KEY_ENV]);
}

async function main(): Promise<void> {
  if (!hasKiroCli()) {
    console.log("kiro-acp skipped: Kiro CLI is not installed");
    return;
  }
  if (!hasKiroAuth()) {
    console.log(`kiro-acp skipped: ${KIRO_API_KEY_ENV} is not configured`);
    return;
  }

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);
  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let agent: Agent | null = null;
  let observer: BandLink | null = null;

  try {
    await sweepOrphans(userClient, runId);
    const kiroIdentity = await provisionAgent(userClient, runId, TEST_NAME, "kiro");
    provisioned.push(kiroIdentity);
    const senderIdentity = await provisionAgent(userClient, runId, TEST_NAME, "sender");
    provisioned.push(senderIdentity);
    const helperIdentity = await provisionAgent(userClient, runId, TEST_NAME, "helper");
    provisioned.push(helperIdentity);

    const kiroRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: kiroIdentity.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderIdentity.apiKey }));
    const chat = await kiroRest.createChat();
    roomIds.push(chat.id);
    await kiroRest.addChatParticipant(chat.id, { participantId: senderIdentity.id, role: "member" });
    observer = new BandLink({
      agentId: senderIdentity.id,
      apiKey: senderIdentity.apiKey,
      wsUrl,
      restApi: senderRest,
    });
    await observer.connect();
    await observer.subscribeRoom(chat.id);

    agent = Agent.create({
      adapter: new KiroACPAdapter({}),
      agentId: kiroIdentity.id,
      apiKey: kiroIdentity.apiKey,
      wsUrl,
      linkOptions: { restApi: kiroRest },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await agent.start();

    const firstMarker = `FIRST-${runId}`;
    const mcpMarker = `MCP-${runId}`;
    await senderRest.createChatMessage(chat.id, {
      content: `@${kiroIdentity.name} Reply with exactly ${firstMarker}.`,
      mentions: [{ id: kiroIdentity.id, handle: kiroIdentity.name }],
    });
    await waitForEvent(
      observer,
      (event) => event.type === "message_created"
        && event.payload.sender_id === kiroIdentity.id
        && event.payload.content.includes(firstMarker),
      "first Kiro response was not visible",
    );

    await senderRest.createChatMessage(chat.id, {
      content: `@${kiroIdentity.name} Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcpMarker}, then SECOND-${runId}.`,
      mentions: [{ id: kiroIdentity.id, handle: kiroIdentity.name }],
    });
    let helperAdded = false;
    let secondResponseReceived = false;
    await waitForEvent(observer, (event) => {
      if (event.type === "participant_added" && event.payload.id === helperIdentity.id) {
        helperAdded = true;
      }
      if (event.type === "message_created" && event.payload.sender_id === kiroIdentity.id
        && event.payload.content.includes(firstMarker)
        && event.payload.content.includes(mcpMarker)
        && event.payload.content.includes(`SECOND-${runId}`)) {
        secondResponseReceived = true;
      }
      return helperAdded && secondResponseReceived;
    }, "Kiro did not add the helper through MCP and complete the second response");

    console.log("kiro-acp passed: MCP roster change and second response observed");
  } finally {
    if (agent) await agent.stop(5_000).catch(() => undefined);
    if (observer) await observer.disconnect().catch(() => undefined);
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME);
  }
}

main().catch((error) => {
  console.error("kiro-acp failed:", error);
  process.exitCode = 1;
});

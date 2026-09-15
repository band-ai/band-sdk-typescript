/**
 * Real GitHub Copilot CLI ACP smoke test. The discovered live workflow runs
 * this only when its CLI/authentication prerequisites are configured.
 *
 * Run: BAND_API_KEY_USER=... COPILOT_GITHUB_TOKEN=... npx tsx tests/integration/copilot-acp-live.ts
 * Or:  BAND_API_KEY_USER=... COPILOT_PROVIDER_BASE_URL=... COPILOT_MODEL=... [COPILOT_PROVIDER_API_KEY=...] npx tsx tests/integration/copilot-acp-live.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { Agent, CopilotACPAdapter } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import {
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sleep,
  sweepOrphans,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "copilot-acp";
const TIMEOUT_MS = 180_000;

function hasCopilotCli(): boolean {
  return spawnSync("copilot", ["--version"], { stdio: "ignore" }).status === 0;
}

function hasByok(): boolean {
  return ["COPILOT_PROVIDER_BASE_URL", "COPILOT_MODEL"]
    .every((name) => process.env[name]);
}

function hasHostedAuthentication(): boolean {
  return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((name) => process.env[name]);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(1_000);
  }
}

async function main(): Promise<void> {
  if (!hasCopilotCli()) {
    console.log("copilot-acp skipped: Copilot CLI is not installed");
    return;
  }
  if (!hasHostedAuthentication() && !hasByok()) {
    console.log("copilot-acp skipped: configure a Copilot GitHub token or complete BYOK provider environment");
    return;
  }

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);
  const copilotHome = await mkdtemp(join(tmpdir(), "band-copilot-acp-"));
  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let agent: Agent | null = null;

  try {
    await sweepOrphans(userClient, runId);
    const copilotIdentity = await provisionAgent(userClient, runId, TEST_NAME, "copilot");
    provisioned.push(copilotIdentity);
    const senderIdentity = await provisionAgent(userClient, runId, TEST_NAME, "sender");
    provisioned.push(senderIdentity);
    const helperIdentity = await provisionAgent(userClient, runId, TEST_NAME, "helper");
    provisioned.push(helperIdentity);

    const copilotRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: copilotIdentity.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderIdentity.apiKey }));
    const chat = await copilotRest.createChat();
    roomIds.push(chat.id);
    await copilotRest.addChatParticipant(chat.id, { participantId: senderIdentity.id, role: "member" });

    agent = Agent.create({
      adapter: new CopilotACPAdapter({
        env: { COPILOT_HOME: copilotHome, COPILOT_ALLOW_ALL: "true" },
      }),
      agentId: copilotIdentity.id,
      apiKey: copilotIdentity.apiKey,
      wsUrl,
      linkOptions: { restApi: copilotRest },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await agent.start();

    const firstMarker = `FIRST-${runId}`;
    const mcpMarker = `MCP-${runId}`;
    await senderRest.createChatMessage(chat.id, {
      content: `@${copilotIdentity.name} Reply with exactly ${firstMarker}.`,
      mentions: [{ id: copilotIdentity.id, handle: copilotIdentity.name }],
    });
    await waitFor(async () => (await senderRest.listMessages({ chatId: chat.id, page: 1, pageSize: 100 })).data.some((message) => message.sender_id === copilotIdentity.id && message.content.includes(firstMarker)), "first Copilot response was not visible");

    await senderRest.createChatMessage(chat.id, {
      content: `@${copilotIdentity.name} Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply with exactly ${mcpMarker} and then exactly SECOND-${runId}.`,
      mentions: [{ id: copilotIdentity.id, handle: copilotIdentity.name }],
    });
    await waitFor(async () => {
      const messages = (await senderRest.listMessages({ chatId: chat.id, page: 1, pageSize: 100 })).data;
      const participants = await copilotRest.listChatParticipants(chat.id);
      return participants.some((participant) => participant.id === helperIdentity.id)
        && messages.some((message) => message.sender_id === copilotIdentity.id && message.content.includes(mcpMarker))
        && messages.some((message) => message.sender_id === copilotIdentity.id && message.content.includes(`SECOND-${runId}`));
    }, "Copilot did not add the helper through MCP and complete the second response");

    console.log("copilot-acp passed: MCP roster change and second response observed");
  } finally {
    if (agent) await agent.stop(5_000).catch(() => undefined);
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME);
    await rm(copilotHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("copilot-acp failed:", error);
  process.exitCode = 1;
});

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

import { Agent, CopilotACPAdapter, DEFAULT_COPILOT_ACP_COMMAND } from "../../src/index";
import { BandLink } from "../../src/platform/BandLink";
import type { PlatformEvent } from "../../src/platform/events";
import { FernRestAdapter } from "../../src/rest";
import {
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sweepOrphans,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "copilot-acp";
const TIMEOUT_MS = 180_000;
const COPILOT_HOSTED_AUTH_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const COPILOT_BYOK_REQUIRED_ENV = ["COPILOT_PROVIDER_BASE_URL", "COPILOT_MODEL"] as const;
const COPILOT_HOME_ENV = "COPILOT_HOME";
const COPILOT_ALLOW_ALL_ENV = "COPILOT_ALLOW_ALL";
const COPILOT_ALLOW_ALL_VALUE = "true";

function hasCopilotCli(): boolean {
  return spawnSync(DEFAULT_COPILOT_ACP_COMMAND[0], ["--version"], { stdio: "ignore" }).status === 0;
}

function hasByok(): boolean {
  return COPILOT_BYOK_REQUIRED_ENV.every((name) => process.env[name]);
}

function hasHostedAuthentication(): boolean {
  return COPILOT_HOSTED_AUTH_ENV.some((name) => process.env[name]);
}

async function waitForEvent(
  link: BandLink,
  predicate: (event: PlatformEvent) => boolean,
  message: string,
): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    while (true) {
      const event = await link.nextEvent(timeout.signal);
      if (!event) {
        throw new Error(message);
      }
      if (predicate(event)) {
        return;
      }
    }
  } finally {
    clearTimeout(timer);
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
  let observer: BandLink | null = null;

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
    observer = new BandLink({
      agentId: senderIdentity.id,
      apiKey: senderIdentity.apiKey,
      wsUrl,
      restApi: senderRest,
    });
    await observer.connect();
    await observer.subscribeRoom(chat.id);

    agent = Agent.create({
      adapter: new CopilotACPAdapter({
        env: { [COPILOT_HOME_ENV]: copilotHome, [COPILOT_ALLOW_ALL_ENV]: COPILOT_ALLOW_ALL_VALUE },
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
    await waitForEvent(
      observer,
      (event) => event.type === "message_created"
        && event.payload.sender_id === copilotIdentity.id
        && event.payload.content.includes(firstMarker),
      "first Copilot response was not visible",
    );

    await senderRest.createChatMessage(chat.id, {
      content: `@${copilotIdentity.name} Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcpMarker}, then SECOND-${runId}.`,
      mentions: [{ id: copilotIdentity.id, handle: copilotIdentity.name }],
    });
    let helperAdded = false;
    let secondResponseReceived = false;
    await waitForEvent(observer, (event) => {
      if (event.type === "participant_added" && event.payload.id === helperIdentity.id) {
        helperAdded = true;
      }
      if (event.type === "message_created" && event.payload.sender_id === copilotIdentity.id
        && event.payload.content.includes(firstMarker)
        && event.payload.content.includes(mcpMarker)
        && event.payload.content.includes(`SECOND-${runId}`)) {
        secondResponseReceived = true;
      }
      return helperAdded && secondResponseReceived;
    }, "Copilot did not add the helper through MCP and complete the second response");

    console.log("copilot-acp passed: MCP roster change and second response observed");
  } finally {
    if (agent) await agent.stop(5_000).catch(() => undefined);
    if (observer) await observer.disconnect().catch(() => undefined);
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME);
    await rm(copilotHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("copilot-acp failed:", error);
  process.exitCode = 1;
});

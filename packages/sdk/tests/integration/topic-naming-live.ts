/**
 * Live E2E: the refactored Phoenix Channels topic functions still route real
 * events end-to-end (INT-1425 migrated BandLink/PhoenixChannelsTransport from
 * hand-built topic-string template literals to `@band-ai/band-sdk-core`'s
 * `agentRoomsTopic`/`chatRoomTopic`/`roomParticipantsTopic`/`agentContactsTopic`
 * functions). Every existing unit test for this code replaces `phoenix` or the
 * transport with a fake, proving only "the string I built matches the string I
 * expected" — this proves a real Phoenix Channels server actually routes on
 * these strings, through the SDK's unmodified public API (`Agent.create`,
 * `GenericAdapter`, `contactConfig`), no internal plumbing exposed here.
 *
 * Two disposable agents are provisioned; agent B is added to a chat room via
 * REST before it starts (`autoSubscribeExistingRooms: true` picks it up on
 * connect). Agent A then REST-triggers two round trips agent B observes over
 * its real WebSocket:
 *   - a chat message, proving `agentRoomsTopic` (agent B's own room feed),
 *     `chatRoomTopic`, and `roomParticipantsTopic` still route
 *     `message_created`.
 *   - a contact request, proving `agentContactsTopic` still routes
 *     `contact_request_received`.
 *
 * `agent_control` (the 5th topic) is deliberately NOT covered here — there is
 * no reliable, on-demand way to trigger a live session-supersede. It stays
 * covered by the existing `FakeSocket`-based unit test
 * (phoenix-channels-transport.test.ts) plus band-sdk-core-bundler.ts's
 * literal-output check.
 *
 * Run:  BAND_API_KEY_USER=... npx tsx tests/integration/topic-naming-live.ts
 */
import { randomUUID } from "node:crypto";

import { BandClient } from "@band-ai/rest-client";

import { Agent, GenericAdapter } from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import {
  createReporter,
  DEFAULT_REST_URL,
  deleteRoomsBulk,
  provisionAgent,
  requireEnv,
  sweepOrphans,
  waitUntil,
  type ProvisionedAgent,
} from "./support/liveHarness";

const { pass, fail, summarize } = createReporter();

async function main() {
  console.log("topic-naming === live channel routing for the refactored topic functions ===");

  // `||`, not `??`: an unset GitHub Actions secret expands to "", which `??`
  // would pass through as a real URL.
  const restUrl = process.env.BAND_REST_URL || DEFAULT_REST_URL;
  const wsUrl = process.env.BAND_WS_URL || undefined;
  const userApiKey = requireEnv("BAND_API_KEY_USER");
  const userClient = new BandClient({ baseUrl: restUrl, apiKey: userApiKey });

  const runId = randomUUID().slice(0, 8);
  await sweepOrphans(userClient, runId);
  // Tracked as each is created so a failure provisioning the second still
  // reaps the first.
  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let runningAgentB: Agent | null = null;

  try {
    const agentA = await provisionAgent(userClient, runId, "sender", "TS SDK topic-naming E2E (sender)");
    provisioned.push(agentA);
    const agentB = await provisionAgent(userClient, runId, "receiver", "TS SDK topic-naming E2E (receiver)");
    provisioned.push(agentB);
    console.log(`topic-naming Provisioned sender "${agentA.name}" (${agentA.id}) and receiver "${agentB.name}" (${agentB.id})`);

    const restA = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: agentA.apiKey }));
    const restB = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: agentB.apiKey }));

    // `AddContactArgs.handle` is the platform's `owner_handle/agent_slug`
    // identifier (`AgentMe.handle`), not the plain `name` passed at
    // registration — verified live against `agentApiIdentity.getAgentMe()`.
    const agentBHandle = (await restB.getAgentMe()).handle;
    if (!agentBHandle) {
      throw new Error(`receiver agent has no handle: ${JSON.stringify(agentB)}`);
    }

    // Agent B is added before it starts, so its live receipt of the message
    // below depends on `autoSubscribeExistingRooms` picking up this room —
    // not on a `room_added` event delivered after connect.
    const chat = await restA.createChat();
    roomIds.push(chat.id);
    await restA.addChatParticipant(chat.id, { participantId: agentB.id, role: "member" });
    console.log(`topic-naming Created chat: ${chat.id}`);

    const received = { messages: [] as string[], contactEvents: [] as string[] };

    const adapter = new GenericAdapter(async ({ message }) => {
      received.messages.push(message.content);
    });

    runningAgentB = Agent.create({
      adapter,
      agentId: agentB.id,
      apiKey: agentB.apiKey,
      wsUrl,
      linkOptions: { restApi: restB },
      agentConfig: { autoSubscribeExistingRooms: true },
      contactConfig: {
        strategy: "callback",
        onEvent: async (event) => {
          received.contactEvents.push(event.type);
        },
      },
    });

    console.log("topic-naming Starting receiver agent (autoSubscribeExistingRooms: true)...");
    await runningAgentB.start();

    console.log("topic-naming Sending a chat message from the sender...");
    await restA.createChatMessage(chat.id, {
      content: `@${agentB.name} hello from A`,
      mentions: [{ id: agentB.id, handle: agentB.name }],
    });
    try {
      await waitUntil(() => received.messages.some((m) => m.includes("hello from A")), { timeoutMs: 15_000 });
      pass("receiver got the sender's message over its real chat_room/agent_rooms/room_participants joins");
    } catch (error) {
      fail(
        "receiver got the sender's message over its real chat_room/agent_rooms/room_participants joins",
        `messages=${JSON.stringify(received.messages)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }

    console.log("topic-naming Sending a contact request from the sender...");
    await restA.addContact({ handle: agentBHandle });
    try {
      await waitUntil(() => received.contactEvents.includes("contact_request_received"), { timeoutMs: 15_000 });
      pass("receiver got a live contact_request_received event over its real agent_contacts join");
    } catch (error) {
      fail(
        "receiver got a live contact_request_received event over its real agent_contacts join",
        `contactEvents=${JSON.stringify(received.contactEvents)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (runningAgentB) {
      await runningAgentB.stop(5000);
    }
    console.log("topic-naming Reaping provisioned agents and rooms...");
    await Promise.all([
      ...provisioned.map((agent) =>
        userClient.humanApiAgents.deleteMyAgent(agent.id, { force: true }).catch((err: unknown) => {
          console.warn(`topic-naming Failed to reap agent ${agent.id}:`, err);
        }),
      ),
      deleteRoomsBulk(restUrl, userApiKey, roomIds).catch((err: unknown) => {
        console.warn("topic-naming Failed to bulk-delete rooms:", err);
      }),
    ]);
  }

  summarize("topic-naming");
}

main().catch((err) => {
  console.error("topic-naming FAILED:", err);
  process.exit(1);
});

/**
 * Real OMP ACP smoke test. Unlike every other `*-live.ts` script, a missing
 * provider credential is the ONLY permitted skip here — once one is present
 * (always true in CI once the secret exists), a missing/broken OMP binary, a
 * handshake error, a scenario timeout, or an unrouted permission request are
 * all hard failures (`process.exitCode = 1`), never a skip. A broken CI setup
 * must show up as a red nightly job, not a silently-green "skipped" one.
 *
 * Run: BAND_API_KEY_USER=... GEMINI_API_KEY=... npx tsx tests/integration/omp-acp-live.ts
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { Agent, OmpACPAdapter, DEFAULT_OMP_ACP_COMMAND } from "../../src/index";
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

const TEST_NAME = "omp-acp";
const TIMEOUT_MS = 180_000;
const OMP_MODEL = "google/gemini-2.5-flash";
const OMP_COMMAND = [...DEFAULT_OMP_ACP_COMMAND, "--model", OMP_MODEL];
const OMP_STATE_DIR_ENV = "PI_CODING_AGENT_DIR";
// The exact client-gated tool kinds per OMP's approval-mode docs — not the
// generic "write" an earlier draft of this plan assumed.
const GATED_TOOL_KINDS = new Set(["execute", "edit", "delete", "move"]);
// Representative core provider env vars (docs/providers.md's "Core
// providers" table). Presence of any is the only permitted skip signal.
// Deliberately incomplete — OMP supports 60+ providers — so an operator on
// an uncommon one gets an unneeded local skip, never a false pass.
const CORE_PROVIDER_ENV_VARS = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_OAUTH_TOKEN",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
] as const;

function hasProviderCredentials(): boolean {
  return CORE_PROVIDER_ENV_VARS.some((name) => process.env[name]);
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
  // Governing rule: absence of every listed credential env var is the ONLY
  // permitted skip. Everything from here on is a hard requirement.
  if (!hasProviderCredentials()) {
    console.log("omp-acp skipped: no OMP provider credentials configured");
    return;
  }

  if (spawnSync(DEFAULT_OMP_ACP_COMMAND[0], ["--version"], { stdio: "ignore" }).status !== 0) {
    throw new Error(
      "omp-acp failed: OMP CLI is not installed or not on PATH, but provider credentials are configured " +
      "(a credential being configured means this environment is expected to have a working `omp`)",
    );
  }

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);
  const ompStateDir = await mkdtemp(join(tmpdir(), "band-omp-acp-state-"));
  const ompCwd = await mkdtemp(join(tmpdir(), "band-omp-acp-cwd-"));
  const guardedFile = join(ompCwd, "guarded.txt");
  await writeFile(guardedFile, "do not touch\n");

  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  let agent: Agent | null = null;
  let observer: BandLink | null = null;
  let deniedRequestSeen = false;

  try {
    await sweepOrphans(userClient, runId);
    const ompIdentity = await provisionAgent(userClient, runId, TEST_NAME, "omp");
    provisioned.push(ompIdentity);
    const senderIdentity = await provisionAgent(userClient, runId, TEST_NAME, "sender");
    provisioned.push(senderIdentity);
    const helperIdentity = await provisionAgent(userClient, runId, TEST_NAME, "helper");
    provisioned.push(helperIdentity);

    const ompRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: ompIdentity.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderIdentity.apiKey }));
    const chat = await ompRest.createChat();
    roomIds.push(chat.id);
    await ompRest.addChatParticipant(chat.id, { participantId: senderIdentity.id, role: "member" });
    observer = new BandLink({
      agentId: senderIdentity.id,
      apiKey: senderIdentity.apiKey,
      wsUrl,
      restApi: senderRest,
    });
    await observer.connect();
    await observer.subscribeRoom(chat.id);

    agent = Agent.create({
      adapter: new OmpACPAdapter({
        command: OMP_COMMAND,
        cwd: ompCwd,
        env: { [OMP_STATE_DIR_ENV]: ompStateDir },
        // Never yolo: the constraint below keeps OMP's client permission gate
        // active so the resolver below is actually exercised (see the module
        // doc and the ticket's non-negotiables) — no --yolo/--auto-approve/
        // --approval-mode yolo flag or config overlay is ever passed.
        resolvePermission: async (request) => {
          if (GATED_TOOL_KINDS.has(request.toolCall.kind ?? "")) {
            deniedRequestSeen = true;
            return (
              request.options.find((option) => option.kind === "reject_once")?.optionId
              ?? request.options.find((option) => option.kind === "reject_always")?.optionId
            );
          }
          return (
            request.options.find((option) => option.kind === "allow_once")?.optionId
            ?? request.options.find((option) => option.kind === "allow_always")?.optionId
            ?? request.options[0]?.optionId
          );
        },
      }),
      agentId: ompIdentity.id,
      apiKey: ompIdentity.apiKey,
      wsUrl,
      linkOptions: { restApi: ompRest },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await agent.start();

    const firstMarker = `FIRST-${runId}`;
    const mcpMarker = `MCP-${runId}`;
    await senderRest.createChatMessage(chat.id, {
      content: `@${ompIdentity.name} Reply with exactly ${firstMarker}.`,
      mentions: [{ id: ompIdentity.id, handle: ompIdentity.name }],
    });
    await waitForEvent(
      observer,
      (event) =>
        event.type === "message_created"
        && event.payload.sender_id === ompIdentity.id
        && event.payload.content.includes(firstMarker),
      "first OMP response was not visible",
    );

    await senderRest.createChatMessage(chat.id, {
      content: `@${ompIdentity.name} Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcpMarker}, then SECOND-${runId}.`,
      mentions: [{ id: ompIdentity.id, handle: ompIdentity.name }],
    });
    let helperAdded = false;
    let secondResponseReceived = false;
    await waitForEvent(observer, (event) => {
      if (event.type === "participant_added" && event.payload.id === helperIdentity.id) {
        helperAdded = true;
      }
      if (
        event.type === "message_created"
        && event.payload.sender_id === ompIdentity.id
        && event.payload.content.includes(firstMarker)
        && event.payload.content.includes(mcpMarker)
        && event.payload.content.includes(`SECOND-${runId}`)
      ) {
        secondResponseReceived = true;
      }
      return helperAdded && secondResponseReceived;
    }, "OMP did not add the helper through MCP and complete the second response");

    const messagesSoFar = await senderRest.listMessages({ chatId: chat.id, page: 1, pageSize: 100 });
    const toolCallMessage = messagesSoFar.data.find(
      (message) =>
        message.message_type === "tool_call"
        && JSON.stringify(message.metadata?.raw_input ?? "").includes(helperIdentity.name),
    );
    if (!toolCallMessage) {
      throw new Error("OMP's band_add_participant tool_call message was not observed (corroborating evidence)");
    }
    const toolResultMessage = messagesSoFar.data.find(
      (message) =>
        message.message_type === "tool_result"
        && message.metadata?.tool_call_id === toolCallMessage.metadata?.tool_call_id,
    );
    if (!toolResultMessage) {
      throw new Error("OMP's band_add_participant tool_result message was not observed (corroborating evidence)");
    }

    const taskMessages = messagesSoFar.data.filter((message) => message.message_type === "task");
    const sessionIds = new Set(taskMessages.map((message) => message.metadata?.acp_client_session_id));
    if (sessionIds.size !== 1 || sessionIds.has(undefined)) {
      throw new Error(`expected exactly one ACP session id across task events, saw: ${[...sessionIds].join(", ")}`);
    }

    console.log("omp-acp passed: MCP roster change, session reuse, and tool_call/tool_result trail observed");

    const permissionMarker = `PERM-${runId}`;
    await senderRest.createChatMessage(chat.id, {
      content: `@${ompIdentity.name} Delete the file named guarded.txt in your current working directory, then reply with exactly ${permissionMarker} once you are done attempting it.`,
      mentions: [{ id: ompIdentity.id, handle: ompIdentity.name }],
    });
    await waitForEvent(
      observer,
      (event) =>
        event.type === "message_created"
        && event.payload.sender_id === ompIdentity.id
        && event.payload.content.includes(permissionMarker),
      "OMP did not respond to the permission-gated deletion request",
    );

    if (!deniedRequestSeen) {
      throw new Error("OMP never routed the delete through session/request_permission");
    }
    const guardedFileContents = await readFile(guardedFile, "utf8").catch(() => null);
    if (guardedFileContents !== "do not touch\n") {
      throw new Error("the guarded file was modified despite the permission resolver denying the request");
    }

    console.log("omp-acp passed: permission-gated delete was routed through resolvePermission and denied");
  } finally {
    if (agent) await agent.stop(5_000).catch(() => undefined);
    if (observer) await observer.disconnect().catch(() => undefined);
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME);
    await rm(ompStateDir, { recursive: true, force: true });
    await rm(ompCwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("omp-acp failed:", error);
  process.exitCode = 1;
});

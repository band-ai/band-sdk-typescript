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
// `Agent.stop`'s timeout only bounds per-room turn-draining — the underlying
// ACP subprocess's SIGTERM/exit wait has no timeout of its own, so this
// script races it separately (see `stopAgentWithFallback`) rather than
// trusting the call to return within this bound.
const AGENT_STOP_TIMEOUT_MS = 5_000;
const OMP_MODEL = "google/gemini-2.5-flash";
const OMP_COMMAND = [...DEFAULT_OMP_ACP_COMMAND, "--model", OMP_MODEL];
const OMP_STATE_DIR_ENV = "PI_CODING_AGENT_DIR";
// The exact client-gated tool kinds per OMP's approval-mode docs — OMP has
// no generic "write" kind.
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

/**
 * `agent.stop(timeoutMs)` doesn't actually bound the wait: `PlatformRuntime`
 * passes `timeoutMs` only to per-room turn-draining, then unconditionally
 * awaits the adapter's own shutdown, and `ACPClientAdapter`'s spawned-process
 * stop sends SIGTERM and waits for `exit`/`close` with no timeout at all. A
 * slow-to-exit `omp acp` process would otherwise hang this whole script's
 * `finally` block — and everything after it (reaping the real Band
 * agents/room, removing temp dirs) — for as long as the child takes to die.
 */
async function stopAgentWithFallback(target: Agent, timeoutMs: number): Promise<void> {
  const stopped = target.stop(timeoutMs).then(
    () => true,
    (error) => {
      console.warn("omp-acp cleanup: agent.stop rejected:", error);
      return true;
    },
  );
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs * 2);
  });
  const finishedInTime = await Promise.race([stopped, timedOut]);
  clearTimeout(timer!);
  if (!finishedInTime) {
    console.warn(
      `omp-acp cleanup: agent.stop did not complete within ${timeoutMs * 2}ms — the underlying ` +
      "omp acp subprocess may still be running; proceeding with the rest of cleanup regardless",
    );
  }
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

  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  const tempDirs: string[] = [];
  let agent: Agent | null = null;
  let observer: BandLink | null = null;
  let deniedRequestSeen = false;

  try {
    // Tracked in `tempDirs` (not local `const`s) and created inside the try
    // block so a failure partway through setup still reaches `finally` with
    // whichever dir(s) already exist recorded for cleanup.
    const ompStateDir = await mkdtemp(join(tmpdir(), "band-omp-acp-state-"));
    tempDirs.push(ompStateDir);
    const ompCwd = await mkdtemp(join(tmpdir(), "band-omp-acp-cwd-"));
    tempDirs.push(ompCwd);
    const guardedFile = join(ompCwd, "guarded.txt");
    await writeFile(guardedFile, "do not touch\n");

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
        // Never yolo: --yolo/--auto-approve/--approval-mode yolo (or a config
        // overlay setting tools.approvalMode: yolo) would bypass the
        // permission gate this test exists to exercise, so none is ever
        // passed here.
        resolvePermission: async (request) => {
          if (GATED_TOOL_KINDS.has(request.toolCall.kind ?? "")) {
            deniedRequestSeen = true;
            const rejectId = request.options.find((option) => option.kind === "reject_once")?.optionId
              ?? request.options.find((option) => option.kind === "reject_always")?.optionId;
            if (!rejectId) {
              console.warn(
                `omp-acp: gated request for kind "${request.toolCall.kind}" offered no reject option ` +
                `(offered: ${request.options.map((option) => option.kind).join(", ")})`,
              );
            }
            return rejectId;
          }
          const allowId = request.options.find((option) => option.kind === "allow_once")?.optionId
            ?? request.options.find((option) => option.kind === "allow_always")?.optionId;
          if (!allowId) {
            console.warn(
              `omp-acp: non-gated request for kind "${request.toolCall.kind}" offered no allow option ` +
              `(offered: ${request.options.map((option) => option.kind).join(", ")}); ` +
              "falling back to the first offered option",
            );
          }
          return allowId ?? request.options[0]?.optionId;
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

    // Reset here, not just declared once at the top: `resolvePermission` is
    // active for the whole agent lifetime, so an incidental gated call during
    // an earlier turn (e.g. OMP inspecting its cwd) could otherwise leave
    // this already `true` before this scenario ever runs, making the check
    // below pass without ever observing a permission request for this delete.
    deniedRequestSeen = false;
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
    if (agent) {
      await stopAgentWithFallback(agent, AGENT_STOP_TIMEOUT_MS);
    }
    if (observer) {
      await observer.disconnect().catch((error: unknown) => {
        console.warn("omp-acp cleanup: observer.disconnect failed:", error);
      });
    }
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME).catch((error: unknown) => {
      console.warn("omp-acp cleanup: reapProvisioned failed:", error);
    });
    await Promise.all(
      tempDirs.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          console.warn(`omp-acp cleanup: failed to remove ${dir}:`, error);
        }),
      ),
    );
  }
}

main().catch((error) => {
  console.error("omp-acp failed:", error);
  process.exitCode = 1;
});

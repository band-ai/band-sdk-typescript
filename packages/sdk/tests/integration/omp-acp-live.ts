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

import type { ToolCall, ToolKind } from "@agentclientprotocol/sdk";
import { BandClient } from "@band-ai/rest-client";

import {
  Agent,
  OmpACPAdapter,
  DEFAULT_OMP_ACP_COMMAND,
  type OmpACPAdapterOptions,
} from "../../src/index";
import { withTimeout } from "../../src/adapters/shared/withTimeout";
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

const TEST_NAME = "omp-acp";
const OMP_PROBE_TIMEOUT_MS = 10_000;
const AGENT_STOP_TIMEOUT_MS = 5_000;
const OMP_MODEL = "google/gemini-2.5-flash";
const OMP_COMMAND = [...DEFAULT_OMP_ACP_COMMAND, "--model", OMP_MODEL];
const OMP_STATE_DIR_ENV = "PI_CODING_AGENT_DIR";
// The exact client-gated tool kinds per OMP's approval-mode docs — OMP has
// no generic "write" kind.
const GATED_TOOL_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["execute", "edit", "delete", "move"]);
const GUARDED_FILE_NAME = "guarded.txt";
const GUARDED_FILE_CONTENTS = "do not touch\n";

interface PermissionObservation {
  resolvePermission: NonNullable<OmpACPAdapterOptions["resolvePermission"]>;
  resetDeniedRequest(): void;
  assertPermissionWasDenied(): void;
}

interface McpSessionScenario {
  observer: BandLink;
  senderRest: FernRestAdapter;
  roomId: string;
  ompIdentity: ProvisionedAgent;
  helperIdentity: ProvisionedAgent;
  runId: string;
}

interface PermissionScenario {
  observer: BandLink;
  senderRest: FernRestAdapter;
  roomId: string;
  ompIdentity: ProvisionedAgent;
  guardedFile: string;
  runId: string;
  observation: PermissionObservation;
}

function hasModelCredentials(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function assertOmpAvailable(): void {
  const ompProbe = spawnSync(DEFAULT_OMP_ACP_COMMAND[0], ["--version"], {
    stdio: "ignore",
    timeout: OMP_PROBE_TIMEOUT_MS,
  });
  if (ompProbe.error || ompProbe.signal || ompProbe.status !== 0) {
    const outcome = ompProbe.error?.message
      ?? (ompProbe.signal ? `terminated by ${ompProbe.signal}` : `exited with status ${ompProbe.status}`);
    throw new Error(
      "omp-acp failed: OMP CLI is not installed or not on PATH, but provider credentials are configured " +
      `(a credential being configured means this environment is expected to have a working \`omp\`): ${outcome}`,
    );
  }
}

// A gated request's `toolCall.kind` alone doesn't say *which* file it's
// about — an incidental gated call unrelated to the guarded-delete scenario
// would otherwise satisfy that scenario's assertion too. `locations` is the
// structured signal; `rawInput` is the same substring-matching fallback this
// file already uses to corroborate the MCP tool_call below, for an agent that
// doesn't populate `locations`.
function toolCallTargetsGuardedFile(toolCall: ToolCall): boolean {
  const locations = toolCall.locations ?? [];
  return (
    locations.some((location) => location.path.endsWith(GUARDED_FILE_NAME))
    || JSON.stringify(toolCall.rawInput ?? "").includes(GUARDED_FILE_NAME)
  );
}

function createPermissionObservation(): PermissionObservation {
  let deniedRequestSeen = false;
  let permissionMismatch: string | null = null;

  return {
    resolvePermission: async (request) => {
      if (request.toolCall.kind && GATED_TOOL_KINDS.has(request.toolCall.kind)) {
        if (toolCallTargetsGuardedFile(request.toolCall)) {
          deniedRequestSeen = true;
        }
        const rejectId = request.options.find((option) => option.kind === "reject_once")?.optionId
          ?? request.options.find((option) => option.kind === "reject_always")?.optionId;
        if (!rejectId) {
          permissionMismatch =
            `gated request for kind "${request.toolCall.kind}" offered no reject option ` +
            `(offered: ${request.options.map((option) => option.kind).join(", ")})`;
        }
        return rejectId;
      }
      const allowId = request.options.find((option) => option.kind === "allow_once")?.optionId
        ?? request.options.find((option) => option.kind === "allow_always")?.optionId;
      if (!allowId) {
        permissionMismatch =
          `non-gated request for kind "${request.toolCall.kind}" offered no allow option ` +
          `(offered: ${request.options.map((option) => option.kind).join(", ")})`;
      }
      return allowId ?? request.options[0]?.optionId;
    },
    resetDeniedRequest: () => {
      // Ignore an incidental gated call from an earlier scenario.
      deniedRequestSeen = false;
    },
    assertPermissionWasDenied: () => {
      if (!deniedRequestSeen) {
        throw new Error("OMP never routed the guarded-file delete through session/request_permission");
      }
      // A mismatch anywhere in the resolver's lifetime must fail the test.
      // Throwing from the resolver would be swallowed as a non-answer.
      if (permissionMismatch) {
        throw new Error(`resolvePermission: ${permissionMismatch}`);
      }
    },
  };
}

async function stopAgentWithFallback(target: Agent, timeoutMs: number): Promise<void> {
  const stopped = target.stop(timeoutMs).catch((error: unknown) => {
    console.warn("omp-acp cleanup: agent.stop rejected:", error);
  });
  await withTimeout(stopped, timeoutMs * 2, `agent.stop did not complete within ${timeoutMs * 2}ms`).catch(
    (error: unknown) => {
      console.warn(
        `omp-acp cleanup: ${(error as Error).message} — the underlying omp acp subprocess may still be ` +
        "running; proceeding with the rest of cleanup regardless",
      );
    },
  );
}

function flushOutput(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

async function sendMentionedMessage(
  rest: FernRestAdapter,
  roomId: string,
  recipient: ProvisionedAgent,
  content: string,
): Promise<void> {
  await rest.createChatMessage(roomId, {
    content,
    mentions: [{ id: recipient.id, handle: recipient.name }],
  });
}

async function assertMcpToolTrail(
  senderRest: FernRestAdapter,
  roomId: string,
  helperName: string,
): Promise<void> {
  const messages = await senderRest.listMessages({ chatId: roomId, page: 1, pageSize: 100 });
  const toolCallMessage = messages.data.find(
    (message) =>
      message.message_type === "tool_call"
      && JSON.stringify(message.metadata?.raw_input ?? "").includes(helperName),
  );
  if (!toolCallMessage) {
    throw new Error("OMP's band_add_participant tool_call message was not observed (corroborating evidence)");
  }
  const toolResultMessage = messages.data.find(
    (message) =>
      message.message_type === "tool_result"
      && message.metadata?.tool_call_id === toolCallMessage.metadata?.tool_call_id,
  );
  if (!toolResultMessage) {
    throw new Error("OMP's band_add_participant tool_result message was not observed (corroborating evidence)");
  }
}

function assertSingleSession(sessionEventIds: readonly string[]): void {
  const sessionIds = new Set(sessionEventIds);
  if (sessionEventIds.length !== 2 || sessionIds.size !== 1) {
    throw new Error(`expected exactly one ACP session id across task events, saw: ${[...sessionIds].join(", ")}`);
  }
}

async function runMcpSessionScenario({
  observer,
  senderRest,
  roomId,
  ompIdentity,
  helperIdentity,
  runId,
}: McpSessionScenario): Promise<void> {
  const firstMarker = `FIRST-${runId}`;
  const mcpMarker = `MCP-${runId}`;
  await sendMentionedMessage(senderRest, roomId, ompIdentity, `@${ompIdentity.name} Reply with exactly ${firstMarker}.`);
  await waitForEvent(
    observer,
    (event) =>
      event.type === "message_created"
      && event.payload.sender_id === ompIdentity.id
      && event.payload.content.includes(firstMarker),
    "first OMP response was not visible",
  );

  await sendMentionedMessage(
    senderRest,
    roomId,
    ompIdentity,
    `@${ompIdentity.name} Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcpMarker}, then SECOND-${runId}.`,
  );
  let helperAdded = false;
  let secondResponseReceived = false;
  const sessionEventIds: string[] = [];
  await waitForEvent(observer, (event) => {
    if (event.type === "participant_added" && event.payload.id === helperIdentity.id) {
      helperAdded = true;
    }
    if (
      event.type === "message_created"
      && event.payload.sender_id === ompIdentity.id
      && event.payload.message_type === "task"
      && event.payload.content === "ACP client session"
      && typeof event.payload.metadata?.acp_client_session_id === "string"
    ) {
      sessionEventIds.push(event.payload.metadata.acp_client_session_id);
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
    return helperAdded && secondResponseReceived && sessionEventIds.length >= 2;
  }, "OMP did not add the helper through MCP, complete the second response, and persist both session markers");

  await assertMcpToolTrail(senderRest, roomId, helperIdentity.name);
  assertSingleSession(sessionEventIds);
  console.log("omp-acp passed: MCP roster change, session reuse, and tool_call/tool_result trail observed");
}

async function runPermissionScenario({
  observer,
  senderRest,
  roomId,
  ompIdentity,
  guardedFile,
  runId,
  observation,
}: PermissionScenario): Promise<void> {
  observation.resetDeniedRequest();
  const permissionMarker = `PERM-${runId}`;
  await sendMentionedMessage(
    senderRest,
    roomId,
    ompIdentity,
    `@${ompIdentity.name} Delete the file named ${GUARDED_FILE_NAME} in your current working directory, then reply with exactly ${permissionMarker} once you are done attempting it.`,
  );
  await waitForEvent(
    observer,
    (event) =>
      event.type === "message_created"
      && event.payload.sender_id === ompIdentity.id
      && event.payload.content.includes(permissionMarker),
    "OMP did not respond to the permission-gated deletion request",
  );

  observation.assertPermissionWasDenied();
  const guardedFileContents = await readFile(guardedFile, "utf8").catch(() => null);
  if (guardedFileContents !== GUARDED_FILE_CONTENTS) {
    throw new Error("the guarded file was modified despite the permission resolver denying the request");
  }
  console.log("omp-acp passed: permission-gated delete was routed through resolvePermission and denied");
}

async function main(): Promise<void> {
  // Governing rule: absence of every listed credential env var is the ONLY
  // permitted skip. Everything from here on is a hard requirement.
  if (!hasModelCredentials()) {
    console.log("omp-acp skipped: GEMINI_API_KEY is not configured for the pinned Google model");
    return;
  }

  assertOmpAvailable();

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);

  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  const tempDirs: string[] = [];
  let agent: Agent | null = null;
  let observer: BandLink | null = null;
  const permissionObservation = createPermissionObservation();

  try {
    // Tracked in `tempDirs` (not local `const`s) and created inside the try
    // block so a failure partway through setup still reaches `finally` with
    // whichever dir(s) already exist recorded for cleanup.
    const ompStateDir = await mkdtemp(join(tmpdir(), "band-omp-acp-state-"));
    tempDirs.push(ompStateDir);
    const ompCwd = await mkdtemp(join(tmpdir(), "band-omp-acp-cwd-"));
    tempDirs.push(ompCwd);
    const guardedFile = join(ompCwd, GUARDED_FILE_NAME);
    await writeFile(guardedFile, GUARDED_FILE_CONTENTS);

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
        resolvePermission: permissionObservation.resolvePermission,
      }),
      agentId: ompIdentity.id,
      apiKey: ompIdentity.apiKey,
      wsUrl,
      linkOptions: { restApi: ompRest },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await agent.start();

    await runMcpSessionScenario({
      observer,
      senderRest,
      roomId: chat.id,
      ompIdentity,
      helperIdentity,
      runId,
    });
    await runPermissionScenario({
      observer,
      senderRest,
      roomId: chat.id,
      ompIdentity,
      guardedFile,
      runId,
      observation: permissionObservation,
    });
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

main()
  .catch((error) => {
    console.error("omp-acp failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([flushOutput(process.stdout), flushOutput(process.stderr)]);
    // A SIGTERM-resistant OMP child can keep Node alive after cleanup.
    process.exit(process.exitCode ?? 0);
  });

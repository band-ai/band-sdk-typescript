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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ToolCall, ToolKind } from "@agentclientprotocol/sdk";

import {
  Agent,
  OmpACPAdapter,
  DEFAULT_OMP_ACP_COMMAND,
  type OmpACPAdapterOptions,
} from "../../src/index";
import { withTimeout } from "../../src/adapters/shared/withTimeout";
import { BandLink } from "../../src/platform/BandLink";
import type { FernRestAdapter } from "../../src/rest";
import {
  agentRest,
  cliProbeFailure,
  LiveResources,
  loadLiveEnv,
  provisionAgent,
  type ProvisionedAgent,
  runLiveScript,
  sendMentionedMessage,
  sweepOrphans,
  waitForEvent,
} from "./support/liveHarness";

const TEST_NAME = "omp-acp";
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
  const outcome = cliProbeFailure(DEFAULT_OMP_ACP_COMMAND[0]);
  if (outcome) {
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
  await sendMentionedMessage(senderRest, roomId, ompIdentity, `Reply with exactly ${firstMarker}.`);
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
    `Use the band_add_participant MCP tool to add the available agent named ${helperIdentity.name} to this room as a member. This changes the room roster and cannot be done by replying with text. After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcpMarker}, then SECOND-${runId}.`,
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
    `Delete the file named ${GUARDED_FILE_NAME} in your current working directory, then reply with exactly ${permissionMarker} once you are done attempting it.`,
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

  const env = loadLiveEnv();
  const { restUrl, wsUrl, userClient } = env;
  const runId = randomUUID().slice(0, 8);
  const permissionObservation = createPermissionObservation();
  // Declared before any setup, so a failure partway through still releases whatever already exists.
  await using resources = new LiveResources(env, TEST_NAME);

  const ompStateDir = await resources.tempDir("band-omp-acp-state-");
  const ompCwd = await resources.tempDir("band-omp-acp-cwd-");
  const guardedFile = join(ompCwd, GUARDED_FILE_NAME);
  await writeFile(guardedFile, GUARDED_FILE_CONTENTS);

  await sweepOrphans(userClient, runId);
  const ompIdentity = resources.trackAgent(await provisionAgent(userClient, runId, TEST_NAME, "omp"));
  const senderIdentity = resources.trackAgent(await provisionAgent(userClient, runId, TEST_NAME, "sender"));
  const helperIdentity = resources.trackAgent(await provisionAgent(userClient, runId, TEST_NAME, "helper"));

  const ompRest = agentRest(restUrl, ompIdentity.apiKey);
  const senderRest = agentRest(restUrl, senderIdentity.apiKey);
  const roomId = resources.trackRoom((await ompRest.createChat()).id);
  await ompRest.addChatParticipant(roomId, { participantId: senderIdentity.id, role: "member" });
  const observer = new BandLink({
    agentId: senderIdentity.id,
    apiKey: senderIdentity.apiKey,
    wsUrl,
    restApi: senderRest,
  });
  resources.trackService("observer.disconnect", () => observer.disconnect());
  await observer.connect();
  await observer.subscribeRoom(roomId);

  const agent = Agent.create({
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
  resources.trackService("agent.stop", () => stopAgentWithFallback(agent, AGENT_STOP_TIMEOUT_MS));
  await agent.start();

  await runMcpSessionScenario({
    observer,
    senderRest,
    roomId,
    ompIdentity,
    helperIdentity,
    runId,
  });
  await runPermissionScenario({
    observer,
    senderRest,
    roomId,
    ompIdentity,
    guardedFile,
    runId,
    observation: permissionObservation,
  });
}

runLiveScript(TEST_NAME, main);

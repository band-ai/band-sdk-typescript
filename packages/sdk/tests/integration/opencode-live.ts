/**
 * Real OpenCode approval smoke test: a manual-mode OpencodeAdapter relays a
 * real bash permission ask into a Band room, and a room reply approves it,
 * rejects it, or arrives after it timed out. BYOK: OpenCode reaches Anthropic
 * with our own key through a temp config file, so no OpenCode login is used.
 *
 * A missing ANTHROPIC_API_KEY is the ONLY permitted skip. Once it is set, a
 * missing `opencode` binary or any scenario failure is a hard failure.
 *
 * Run: BAND_API_KEY_USER=... ANTHROPIC_API_KEY=... npx tsx tests/integration/opencode-live.ts
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { BandClient } from "@band-ai/rest-client";

import { Agent, OpencodeAdapter } from "../../src/index";
import { OPENCODE_DECISION_MESSAGES } from "../../src/adapters/opencode/messages";
import { REPLY_WORDS, type ReplyWord } from "../../src/adapters/opencode/replies";
import { BandLink } from "../../src/platform/BandLink";
import { FernRestAdapter } from "../../src/rest";
import {
  loadLiveEnv,
  provisionAgent,
  reapProvisioned,
  sleep,
  sweepOrphans,
  waitForEvent,
  type ProvisionedAgent,
} from "./support/liveHarness";

const TEST_NAME = "opencode";
const OPENCODE_PROBE_TIMEOUT_MS = 10_000;
const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const APPROVAL_WAIT_MS = 10_000;
const EVENT_POLL_ATTEMPTS = 15;
const EVENT_POLL_INTERVAL_MS = 2_000;
const MARKER_FILE_NAME = "approval.txt";
const APPROVE_WORD: ReplyWord = "approve";
// The approval prompt offers `approve <request id>`; nothing else OpenCode posts does.
const APPROVAL_REQUEST_ID = new RegExp(`\`${APPROVE_WORD} (\\S+)\``);
// Only bash asks, so every scenario's single shell command parks on a room reply.
const OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  provider: { anthropic: { options: { apiKey: "{env:ANTHROPIC_API_KEY}" } } },
  permission: { bash: { "*": "ask" } },
};

interface Scenario {
  observer: BandLink;
  senderRest: FernRestAdapter;
  // Agents don't receive each other's events over the socket; the agent's own context has them.
  opencodeRest: FernRestAdapter;
  roomId: string;
  opencodeIdentity: ProvisionedAgent;
  markerFile: string;
}

function assertOpencodeAvailable(): void {
  const probe = spawnSync("opencode", ["--version"], { stdio: "ignore", timeout: OPENCODE_PROBE_TIMEOUT_MS });
  if (probe.error || probe.signal || probe.status !== 0) {
    const outcome = probe.error?.message
      ?? (probe.signal ? `terminated by ${probe.signal}` : `exited with status ${probe.status}`);
    throw new Error(`opencode failed: the OpenCode CLI is not installed or not on PATH, but ANTHROPIC_API_KEY is configured: ${outcome}`);
  }
}

async function sendMentionedMessage(scenario: Scenario, content: string): Promise<void> {
  const { name, id } = scenario.opencodeIdentity;
  await scenario.senderRest.createChatMessage(scenario.roomId, {
    content: `@${name} ${content}`,
    mentions: [{ id, handle: name }],
  });
}

interface RoomMessage {
  type: string;
  content: string;
}

/** Records every OpenCode message in the room until `done` holds for what was recorded. */
async function collectUntil(scenario: Scenario, transcript: RoomMessage[], done: () => boolean, what: string): Promise<void> {
  try {
    await waitForEvent(scenario.observer, (event) => {
      if (event.type === "message_created" && event.payload.sender_id === scenario.opencodeIdentity.id) {
        transcript.push({ type: event.payload.message_type, content: event.payload.content });
      }
      return done();
    }, `${what} was not observed`);
  } catch (error) {
    throw new Error(`${what} was not observed; OpenCode said: ${JSON.stringify(transcript)}`, { cause: error });
  }
}

const said = (transcript: RoomMessage[], text: string) => transcript.some((message) => message.content.includes(text));

// Every decision message names its request id; the turn's own reply is the text that doesn't.
const turnEnded = (transcript: RoomMessage[], requestId: string) =>
  transcript.some((message) => message.type === "text" && !message.content.includes(requestId));

/** Asks OpenCode for one gated shell command and returns the request id of the approval it relays. */
async function requestGatedCommand(scenario: Scenario, marker: string, transcript: RoomMessage[]): Promise<string> {
  await sendMentionedMessage(
    scenario,
    `Use your bash tool to run exactly this one command and no other tool: printf %s ${marker} > ${scenario.markerFile} — then reply with one short sentence.`,
  );
  const prompt = () => transcript.find((message) => APPROVAL_REQUEST_ID.test(message.content));
  await collectUntil(scenario, transcript, () => prompt() !== undefined, "the approval prompt");
  const requestId = prompt()!.content.match(APPROVAL_REQUEST_ID)![1]!;
  // Only what follows the prompt belongs to this decision.
  transcript.length = 0;
  return requestId;
}

/** The OpenCode agent's own events in the room containing `text`, polled until one appears. */
async function awaitOwnEvents(scenario: Scenario, text: string): Promise<string[]> {
  for (let attempt = 0; attempt < EVENT_POLL_ATTEMPTS; attempt += 1) {
    const context = await scenario.opencodeRest.getChatContext({ chatId: scenario.roomId });
    const events = context.data
      .filter((message) => message.sender_id === scenario.opencodeIdentity.id && message.message_type !== "text")
      .map((message) => message.content)
      .filter((content) => content.includes(text));
    if (events.length > 0) {
      return events;
    }
    await sleep(EVENT_POLL_INTERVAL_MS);
  }
  throw new Error(`OpenCode posted no event containing: ${text}`);
}

async function markerWritten(scenario: Scenario, marker: string): Promise<boolean> {
  const contents = await readFile(scenario.markerFile, "utf8").catch(() => "");
  return contents.includes(marker);
}

async function runReplyScenario(scenario: Scenario, word: ReplyWord, expectMarker: boolean): Promise<void> {
  const marker = `${word.toUpperCase()}-${randomUUID().slice(0, 8)}`;
  const transcript: RoomMessage[] = [];
  const requestId = await requestGatedCommand(scenario, marker, transcript);

  await sendMentionedMessage(scenario, `${word} ${requestId}`);
  const handled = OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, REPLY_WORDS[word]);
  await collectUntil(
    scenario,
    transcript,
    () => said(transcript, handled) && turnEnded(transcript, requestId),
    `the handled notice and the end of the turn after \`${word}\``,
  );

  if (await markerWritten(scenario, marker) !== expectMarker) {
    throw new Error(`after \`${word}\`, the marker was ${expectMarker ? "not written" : "written"}`);
  }
  console.log(`opencode passed: \`${word}\` resolved the approval and the command ${expectMarker ? "ran" : "did not run"}`);
}

async function runTimeoutScenario(scenario: Scenario): Promise<void> {
  const marker = `TIMEOUT-${randomUUID().slice(0, 8)}`;
  const transcript: RoomMessage[] = [];
  const requestId = await requestGatedCommand(scenario, marker, transcript);

  await collectUntil(scenario, transcript, () => turnEnded(transcript, requestId), "the end of the timed-out turn");
  const timedOutEvents = await awaitOwnEvents(scenario, OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, REPLY_WORDS.reject));

  await sendMentionedMessage(scenario, `${APPROVE_WORD} ${requestId}`);
  const noLongerPending = OPENCODE_DECISION_MESSAGES.noLongerPending("permission", requestId);
  await collectUntil(scenario, transcript, () => said(transcript, noLongerPending), "the no-longer-pending notice");

  const handledNotices = Object.values(REPLY_WORDS).map((reply) => OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, reply));
  const outcomes = [...timedOutEvents, ...transcript.map((message) => message.content).filter((content) => handledNotices.some((notice) => content.includes(notice)))];
  if (outcomes.length !== 1) {
    throw new Error(`expected exactly one outcome for ${requestId}, saw: ${JSON.stringify(outcomes)}`);
  }
  if (await markerWritten(scenario, marker)) {
    throw new Error("the timed-out command ran anyway");
  }
  console.log("opencode passed: the approval timed out once, and a late reply was told it is no longer pending");
}

function flushOutput(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("opencode skipped: ANTHROPIC_API_KEY is not configured");
    return;
  }

  assertOpencodeAvailable();

  const { restUrl, wsUrl, userApiKey, userClient } = loadLiveEnv();
  const runId = randomUUID().slice(0, 8);

  const provisioned: ProvisionedAgent[] = [];
  const roomIds: string[] = [];
  const tempDirs: string[] = [];
  let agent: Agent | null = null;
  let observer: BandLink | null = null;

  try {
    const workdir = await mkdtemp(join(tmpdir(), "band-opencode-live-"));
    tempDirs.push(workdir);
    const configDir = await mkdtemp(join(tmpdir(), "band-opencode-config-"));
    tempDirs.push(configDir);
    const configFile = join(configDir, "opencode.json");
    await writeFile(configFile, JSON.stringify(OPENCODE_CONFIG));
    // The managed server replaces OPENCODE_CONFIG_CONTENT but inherits OPENCODE_CONFIG.
    process.env.OPENCODE_CONFIG = configFile;

    await sweepOrphans(userClient, runId);
    const opencodeIdentity = await provisionAgent(userClient, runId, TEST_NAME, "opencode");
    provisioned.push(opencodeIdentity);
    const senderIdentity = await provisionAgent(userClient, runId, TEST_NAME, "sender");
    provisioned.push(senderIdentity);

    const opencodeRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: opencodeIdentity.apiKey }));
    const senderRest = new FernRestAdapter(new BandClient({ baseUrl: restUrl, apiKey: senderIdentity.apiKey }));
    const chat = await opencodeRest.createChat();
    roomIds.push(chat.id);
    await opencodeRest.addChatParticipant(chat.id, { participantId: senderIdentity.id, role: "member" });
    observer = new BandLink({ agentId: senderIdentity.id, apiKey: senderIdentity.apiKey, wsUrl, restApi: senderRest });
    await observer.connect();
    await observer.subscribeRoom(chat.id);

    agent = Agent.create({
      adapter: new OpencodeAdapter({
        config: {
          directory: workdir,
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          approvalMode: "manual",
          approvalWaitTimeoutMs: APPROVAL_WAIT_MS,
        },
      }),
      agentId: opencodeIdentity.id,
      apiKey: opencodeIdentity.apiKey,
      wsUrl,
      linkOptions: { restApi: opencodeRest },
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await agent.start();

    const scenario: Scenario = {
      observer,
      senderRest,
      opencodeRest,
      roomId: chat.id,
      opencodeIdentity,
      markerFile: join(workdir, MARKER_FILE_NAME),
    };
    await runReplyScenario(scenario, "approve", true);
    await runReplyScenario(scenario, "reject", false);
    await runTimeoutScenario(scenario);
  } finally {
    if (agent) {
      await agent.stop().catch((error: unknown) => {
        console.warn("opencode cleanup: agent.stop failed:", error);
      });
    }
    if (observer) {
      await observer.disconnect().catch((error: unknown) => {
        console.warn("opencode cleanup: observer.disconnect failed:", error);
      });
    }
    await reapProvisioned(userClient, restUrl, userApiKey, provisioned, roomIds, TEST_NAME).catch((error: unknown) => {
      console.warn("opencode cleanup: reapProvisioned failed:", error);
    });
    await Promise.all(
      tempDirs.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          console.warn(`opencode cleanup: failed to remove ${dir}:`, error);
        }),
      ),
    );
  }
}

main()
  .catch((error) => {
    console.error("opencode failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([flushOutput(process.stdout), flushOutput(process.stderr)]);
    // The managed `opencode serve` child can keep Node alive after cleanup.
    process.exit(process.exitCode ?? 0);
  });

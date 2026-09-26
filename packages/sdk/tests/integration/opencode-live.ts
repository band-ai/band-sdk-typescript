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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Agent, OpencodeAdapter } from "../../src/index";
import { OPENCODE_DECISION_MESSAGES } from "../../src/adapters/opencode/messages";
import { ASK_KIND, REPLY_WORDS, type ReplyWord } from "../../src/adapters/opencode/replies";
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
  EventRecordingRest,
  sendMentionedMessage,
  sweepOrphans,
  waitForEvent,
} from "./support/liveHarness";

const TEST_NAME = "opencode";
const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const APPROVAL_WAIT_MS = 10_000;
const APPROVAL_TIMEOUT_REPLY = REPLY_WORDS.reject;
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

interface RoomMessage {
  type: string;
  content: string;
}

/** Every message OpenCode posted in the room, in order; a mark scopes a read to what came after it. */
class Transcript {
  private readonly messages: RoomMessage[] = [];

  public record(message: RoomMessage): void {
    this.messages.push(message);
  }

  public mark(): number {
    return this.messages.length;
  }

  public since(mark: number): readonly RoomMessage[] {
    return this.messages.slice(mark);
  }
}

interface Scenario {
  observer: BandLink;
  senderRest: FernRestAdapter;
  // Agents don't receive each other's events over the socket, so the agent's own client records them.
  opencodeRest: EventRecordingRest;
  roomId: string;
  opencodeIdentity: ProvisionedAgent;
  markerFile: string;
  transcript: Transcript;
}

function assertOpencodeAvailable(): void {
  const outcome = cliProbeFailure("opencode");
  if (outcome) {
    throw new Error(`opencode failed: the OpenCode CLI is not installed or not on PATH, but ANTHROPIC_API_KEY is configured: ${outcome}`);
  }
}

async function sendToOpencode(scenario: Scenario, text: string): Promise<void> {
  await sendMentionedMessage(scenario.senderRest, scenario.roomId, scenario.opencodeIdentity, text);
}

/** Records OpenCode's messages until `done` holds for those since `mark`, and returns them. */
async function collectUntil(
  scenario: Scenario,
  mark: number,
  done: (messages: readonly RoomMessage[]) => boolean,
  what: string,
): Promise<readonly RoomMessage[]> {
  const { transcript } = scenario;
  try {
    await waitForEvent(scenario.observer, (event) => {
      if (event.type === "message_created" && event.payload.sender_id === scenario.opencodeIdentity.id) {
        transcript.record({ type: event.payload.message_type, content: event.payload.content });
      }
      return done(transcript.since(mark));
    }, `${what} was not observed`);
  } catch (error) {
    throw new Error(`${what} was not observed; OpenCode said: ${JSON.stringify(transcript.since(mark))}`, { cause: error });
  }
  return transcript.since(mark);
}

const said = (messages: readonly RoomMessage[], text: string) => messages.some((message) => message.content.includes(text));

// Every decision message names its request id; the turn's own reply is the text that doesn't.
const turnEnded = (messages: readonly RoomMessage[], requestId: string) =>
  messages.some((message) => message.type === "text" && !message.content.includes(requestId));

/**
 * Asks OpenCode for one gated shell command; returns the request id of the approval it relays, and a mark
 * after that prompt, since only what follows it belongs to this decision.
 */
async function requestGatedCommand(scenario: Scenario, marker: string): Promise<{ requestId: string; mark: number }> {
  const start = scenario.transcript.mark();
  await sendToOpencode(
    scenario,
    `Use your bash tool to run exactly this one command and no other tool: printf %s ${marker} > ${scenario.markerFile} — then reply with one short sentence.`,
  );
  const prompt = (messages: readonly RoomMessage[]) => messages.find((message) => APPROVAL_REQUEST_ID.test(message.content));
  const messages = await collectUntil(scenario, start, (seen) => prompt(seen) !== undefined, "the approval prompt");
  return { requestId: prompt(messages)!.content.match(APPROVAL_REQUEST_ID)![1]!, mark: scenario.transcript.mark() };
}

async function markerWritten(scenario: Scenario, marker: string): Promise<boolean> {
  const contents = await readFile(scenario.markerFile, "utf8").catch(() => "");
  return contents.includes(marker);
}

async function runReplyScenario(scenario: Scenario, word: ReplyWord, expectMarker: boolean): Promise<void> {
  const marker = `${word.toUpperCase()}-${randomUUID().slice(0, 8)}`;
  const { requestId, mark } = await requestGatedCommand(scenario, marker);

  await sendToOpencode(scenario, `${word} ${requestId}`);
  const handled = OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, REPLY_WORDS[word]);
  await collectUntil(
    scenario,
    mark,
    (messages) => said(messages, handled) && turnEnded(messages, requestId),
    `the handled notice and the end of the turn after \`${word}\``,
  );

  if (await markerWritten(scenario, marker) !== expectMarker) {
    throw new Error(`after \`${word}\`, the marker was ${expectMarker ? "not written" : "written"}`);
  }
  console.log(`opencode passed: \`${word}\` resolved the approval and the command ${expectMarker ? "ran" : "did not run"}`);
}

async function runTimeoutScenario(scenario: Scenario): Promise<void> {
  const marker = `TIMEOUT-${randomUUID().slice(0, 8)}`;
  const { requestId, mark } = await requestGatedCommand(scenario, marker);

  await collectUntil(scenario, mark, (messages) => turnEnded(messages, requestId), "the end of the timed-out turn");
  const timedOut = OPENCODE_DECISION_MESSAGES.approvalTimedOut(requestId, APPROVAL_TIMEOUT_REPLY);
  await scenario.opencodeRest.eventContaining(timedOut);

  await sendToOpencode(scenario, `${APPROVE_WORD} ${requestId}`);
  const noLongerPending = OPENCODE_DECISION_MESSAGES.noLongerPending(ASK_KIND.permission, requestId);
  const transcript = await collectUntil(scenario, mark, (messages) => said(messages, noLongerPending), "the no-longer-pending notice");

  const handledNotices = Object.values(REPLY_WORDS).map((reply) => OPENCODE_DECISION_MESSAGES.approvalHandled(requestId, reply));
  const timedOutEvents = scenario.opencodeRest.events.filter((content) => content.includes(timedOut));
  const outcomes = [...timedOutEvents, ...transcript.map((message) => message.content).filter((content) => handledNotices.some((notice) => content.includes(notice)))];
  if (outcomes.length !== 1) {
    throw new Error(`expected exactly one outcome for ${requestId}, saw: ${JSON.stringify(outcomes)}`);
  }
  if (await markerWritten(scenario, marker)) {
    throw new Error("the timed-out command ran anyway");
  }
  console.log("opencode passed: the approval timed out once, and a late reply was told it is no longer pending");
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("opencode skipped: ANTHROPIC_API_KEY is not configured");
    return;
  }

  assertOpencodeAvailable();

  const env = loadLiveEnv();
  const { restUrl, wsUrl, userClient } = env;
  const runId = randomUUID().slice(0, 8);
  await using resources = new LiveResources(env, TEST_NAME);

  const workdir = await resources.tempDir("band-opencode-live-");
  const configFile = join(await resources.tempDir("band-opencode-config-"), "opencode.json");
  await writeFile(configFile, JSON.stringify(OPENCODE_CONFIG));
  // The managed server replaces OPENCODE_CONFIG_CONTENT but inherits OPENCODE_CONFIG.
  process.env.OPENCODE_CONFIG = configFile;

  await sweepOrphans(userClient, runId);
  const opencodeIdentity = resources.trackAgent(await provisionAgent(userClient, runId, TEST_NAME, "opencode"));
  const senderIdentity = resources.trackAgent(await provisionAgent(userClient, runId, TEST_NAME, "sender"));

  const opencodeRest = new EventRecordingRest(restUrl, opencodeIdentity.apiKey);
  const senderRest = agentRest(restUrl, senderIdentity.apiKey);
  const roomId = resources.trackRoom((await opencodeRest.createChat()).id);
  await opencodeRest.addChatParticipant(roomId, { participantId: senderIdentity.id, role: "member" });
  const observer = new BandLink({ agentId: senderIdentity.id, apiKey: senderIdentity.apiKey, wsUrl, restApi: senderRest });
  resources.trackService("observer.disconnect", () => observer.disconnect());
  await observer.connect();
  await observer.subscribeRoom(roomId);

  const agent = Agent.create({
    adapter: new OpencodeAdapter({
      config: {
        directory: workdir,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        approvalMode: "manual",
        approvalWaitTimeoutMs: APPROVAL_WAIT_MS,
        approvalTimeoutReply: APPROVAL_TIMEOUT_REPLY,
      },
    }),
    agentId: opencodeIdentity.id,
    apiKey: opencodeIdentity.apiKey,
    wsUrl,
    linkOptions: { restApi: opencodeRest },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
  resources.trackService("agent.stop", () => agent.stop());
  await agent.start();

  const scenario: Scenario = {
    observer,
    senderRest,
    opencodeRest,
    roomId,
    opencodeIdentity,
    markerFile: join(workdir, MARKER_FILE_NAME),
    transcript: new Transcript(),
  };
  await runReplyScenario(scenario, "approve", true);
  await runReplyScenario(scenario, "reject", false);
  await runTimeoutScenario(scenario);
}

runLiveScript(TEST_NAME, main);

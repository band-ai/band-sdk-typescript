/**
 * How a session gets its Band agent, through the real server on a Band platform:
 * only with Band's channel, by the user's pick, the last pick winning on Band.
 */
import { describe, expect, it } from "vitest";

import { EXIT_OK } from "../../src/channel";
import { AGENT_SELECT_ENV, WS_URL_ENV } from "../../src/config";
import { CHANNEL_OFF_INSTRUCTIONS } from "../../src/prompt";
import { QUESTION_MESSAGE } from "../../src/question";
import { SESSION_TEXT } from "../../src/sessions";
import { CONNECT_TOOL, TOOL } from "../../src/tools";
import { AGENT_API_KEY, AGENT_HANDLE, AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer, TAKEOVER_COOLDOWN_MESSAGE } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { BandRestPeer } from "../support/bandRestPeer";
import { CLOSED, pick } from "../support/channelClient";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { AGENT_NAME, ClaudeCodeSession, linkTo, SAVED_AGENT } from "./support/claudeCode";

const USER = "user-1";
const ROOM = "room-1";
const MESSAGE = `@[[${AGENT_ID}]] hello`;
const DOCS = { agentId: "agent-docs", apiKey: "key-docs", handle: "owner/docs" };
const BAND_TOOLS = Object.values(TOOL).sort();
const CONNECTED = SESSION_TEXT.connected(`${AGENT_NAME} (@${AGENT_HANDLE})`);

/** Fresh directories with `agents` saved, as `/band:agents add` leaves them. */
function savedDirs(agents: Parameters<ClaudeCodeDirs["save"]>[0]): ClaudeCodeDirs {
  const dirs = new ClaudeCodeDirs();
  dirs.save(agents);
  return dirs;
}

/** The options the agent question offered, as the user reads them. */
function offered(question: { requestedSchema: { properties: Record<string, unknown> } }): string[] {
  return (question.requestedSchema.properties.agent as { oneOf: { title: string }[] }).oneOf.map((option) => option.title);
}

async function platformWithRoom(): Promise<BandPlatform> {
  const platform = BandPlatform.host([person(USER)]);
  await platform.room(ROOM);
  return platform;
}

describe("without Band's channel", () => {
  it("lists no tools, never connects to Band, tells Claude how to restart, and says so in its status", async () => {
    const platform = await platformWithRoom();
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT });
    // BAND_AGENT names a saved agent, and still nothing connects.
    await using session = new ClaudeCodeSession(linkTo(platform), { dirs, commandLine: "claude", agent: AGENT_NAME });
    await session.connect();

    expect(await session.toolNames()).toEqual([]);
    expect(session.instructions).toBe(CHANNEL_OFF_INSTRUCTIONS);
    expect(session.capabilities?.experimental).toBeUndefined();
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.noChannel}`);
    expect(await session.leave()).toBe(EXIT_OK);
    expect(platform.transport.joinCalls).toEqual([]);
    expect(session.questions.entries).toEqual([]);
  });
});

describe("with Band's channel", () => {
  it("asks which of two saved agents to act as, and a pick lists the eight Band tools in place of connect", async () => {
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT, docs: DOCS });
    await using session = new ClaudeCodeSession(linkTo(await platformWithRoom()), { dirs, agent: null });
    session.answer(pick(AGENT_NAME));
    await session.connect();

    const question = await session.question();
    expect(question.message).toBe(QUESTION_MESSAGE);
    expect(offered(question)).toEqual([`${AGENT_NAME} (@${AGENT_HANDLE})`, "docs (@owner/docs)"]);
    expect((await session.connected()).sort()).toEqual(BAND_TOOLS);
    expect(await session.dirs.agents("status")).toBe(`connected: ${CONNECTED}`);
  });

  it("still asks with only one agent saved", async () => {
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT });
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null });

    expect(offered(await session.question())).toEqual([`${AGENT_NAME} (@${AGENT_HANDLE})`]);
    expect(await session.toolNames()).toEqual([CONNECT_TOOL]);
  });

  it("asks nothing with no agent saved, and connect says how to add one", async () => {
    using dirs = new ClaudeCodeDirs();
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null });

    expect(await session.callTool(CONNECT_TOOL, {})).toEqual({ isError: false, text: SESSION_TEXT.noAgent });
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.noAgent}`);
    expect(session.questions.entries).toEqual([]);
  });

  it("leaves connect listed when the question is closed, and connect asks again", async () => {
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT });
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null });
    await session.question();
    // Called while the start question is open, connect waits on that same question.
    const closing = session.callTool(CONNECT_TOOL, {});
    session.answer(CLOSED);

    expect((await closing).text).toBe(SESSION_TEXT.notPicked);
    expect(await session.toolNames()).toEqual([CONNECT_TOOL]);
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.notPicked}`);

    session.answer(pick(AGENT_NAME));
    expect((await session.callTool(CONNECT_TOOL, {})).text).toBe(CONNECTED);
    expect(session.questions.entries).toHaveLength(2);
    expect((await session.connected()).sort()).toEqual(BAND_TOOLS);
  });

  it("stays off, with Band's reason, when Band rejects the picked agent's key", async () => {
    using dirs = savedDirs({ [AGENT_NAME]: { ...SAVED_AGENT, apiKey: "revoked-key" } });
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null });
    await session.question();
    const connecting = session.callTool(CONNECT_TOOL, {});
    session.answer(pick(AGENT_NAME));

    const sentence = SESSION_TEXT.connectFailed(AGENT_NAME, "Band refused it (401): Invalid API key");
    expect((await connecting).text).toBe(sentence);
    expect(await session.toolNames()).toEqual([CONNECT_TOOL]);
    expect(await session.status()).toBe(`off: ${sentence}`);
  });

  it("stays off when the client can't show the question", async () => {
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT });
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null, elicitation: false });

    expect((await session.callTool(CONNECT_TOOL, {})).text).toBe(SESSION_TEXT.noElicitation);
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.noElicitation}`);
  });

  it("offers an agent added mid-session, and connects as it", async () => {
    await using rest = await BandRestPeer.start([{ id: AGENT_ID, apiKey: AGENT_API_KEY, name: "Agent", handle: AGENT_HANDLE }]);
    using dirs = new ClaudeCodeDirs();
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { dirs, agent: null });
    expect(await session.callTool(CONNECT_TOOL, {})).toEqual({ isError: false, text: SESSION_TEXT.noAgent });

    expect(await dirs.agents("add", AGENT_ID, AGENT_API_KEY, "--ws-url", rest.wsUrl)).toContain("Say 'join Band' to connect a session as it.");
    session.answer(pick("agent"));

    expect((await session.callTool(CONNECT_TOOL, {})).text).toBe(SESSION_TEXT.connected(`agent (@${AGENT_HANDLE})`));
    expect(offered(await session.question())).toEqual([`agent (@${AGENT_HANDLE})`]);
  });
});

describe("BAND_AGENT", () => {
  it("connects as the saved agent it names without asking", async () => {
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()));

    expect((await session.toolNames()).sort()).toEqual(BAND_TOOLS);
    expect(session.questions.entries).toEqual([]);
    expect(await session.status()).toBe(`connected: ${CONNECTED}`);
  });

  it("makes connect wait on its attempt rather than start another", async () => {
    const platform = await platformWithRoom();
    const identity = platform.rest.agentMeHolds.hold(() => true);
    await using session = new ClaudeCodeSession(linkTo(platform));
    session.answer(pick(AGENT_NAME));
    await session.connect();
    await identity.sending;

    const connecting = session.callTool(CONNECT_TOOL, {});
    identity.release();

    expect(await connecting).toEqual({ isError: false, text: CONNECTED });
    expect(session.questions.entries).toEqual([]);
    expect((await session.toolNames()).sort()).toEqual(BAND_TOOLS);
  });

  it("stays off, keeping connect, when it names an agent that isn't saved", async () => {
    await using session = await ClaudeCodeSession.connect(linkTo(await platformWithRoom()), { agent: null, env: { [AGENT_SELECT_ENV]: "missing" } });

    expect(await session.toolNames()).toEqual([CONNECT_TOOL]);
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.unsavedAgent("missing")}`);
    expect(session.questions.entries).toEqual([]);
  });
});

describe("when Band ends the connection for another reason", () => {
  it("goes back to connect with Band's reason, its working indicator cleared", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    await using session = await ClaudeCodeSession.connect(() => ({ restApi: platform.rest }), { env: { [WS_URL_ENV]: peer.url } });
    await session.pushOf(waiting);
    await platform.rest.workingReports.next((report) => report.working);

    await peer.endConnections(AGENT_ID, "agent.revoked", "The agent's key was revoked");

    expect(await session.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
    expect(await session.status()).toBe(`off: ${SESSION_TEXT.ended(AGENT_NAME, "The agent's key was revoked")}`);
    expect(platform.rest.workingReports.entries.at(-1)).toEqual({ roomId: ROOM, working: false });
  });
});

describe("when another session picks the same agent", () => {
  it("connects it, sends the first back to connect with its working indicator cleared, and Band refuses the first's pick back for a while", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    using dirs = savedDirs({ [AGENT_NAME]: SAVED_AGENT });
    const machine = { dirs, env: { [WS_URL_ENV]: peer.url } };
    const link = () => ({ restApi: platform.rest });
    await using first = await ClaudeCodeSession.connect(link, { ...machine, sessionId: "session-1" });
    await first.pushOf(waiting);
    await platform.rest.workingReports.next((report) => report.working);

    await using second = new ClaudeCodeSession(link, { ...machine, sessionId: "session-2", agent: null });
    second.answer(pick(AGENT_NAME));
    await second.connect();

    expect(offered(await second.question())).toEqual([`${AGENT_NAME} (@${AGENT_HANDLE}) — in use (session in ${dirs.projectDir}); picking takes it over`]);
    expect((await second.connected()).sort()).toEqual(BAND_TOOLS);
    expect(await first.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
    const takenOver = SESSION_TEXT.takenOver(`@${AGENT_HANDLE}`);
    expect(await first.status()).toBe(`off: ${takenOver}`);
    expect(platform.rest.workingReports.entries.at(-1)).toEqual({ roomId: ROOM, working: false });

    first.answer(pick(AGENT_NAME));
    const refused = await first.callTool(CONNECT_TOOL, {});
    expect(refused.text).toBe(SESSION_TEXT.connectFailed(AGENT_NAME, TAKEOVER_COOLDOWN_MESSAGE));
    expect(await second.status()).toBe(`connected: ${CONNECTED}`);
  });
});

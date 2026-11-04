/**
 * OpenCode in a Band room, end to end: people talk in the room through the
 * real platform runtime, and the adapter's real HTTP client talks to an
 * OpenCode server on a local port. Each flow asserts what the room saw, what
 * OpenCode was sent, and how the platform settled each message.
 */
import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { HttpOpencodeClient, OpencodeAdapter, type OpencodeAdapterConfig } from "../../src/adapters/opencode";
import { CustomToolDefinitionError } from "../../src/runtime/tools/customTools";
import { OPENCODE_DECISION_MESSAGES as SAYS, formatQuestionPrompt } from "../../src/adapters/opencode/messages";
import { createDeferred } from "../../src/core/deferred";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import { DECLINED_QUESTION_ANSWER, REJECTED_PERMISSION_FEEDBACK } from "../../src/adapters/opencode/replies";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../../src/contracts/toolSchemas";
import { createBandMcpBackend } from "../../src/mcp/backends";
import type { BandMcpServer } from "../../src/mcp/server";
import { CallHolds, expectMcpServerStopped, FakeTools, makeMessage, MISSING_REPLY, type ReportedFailure } from "../testUtils";
import { AGENT_ID, BandPlatform, person, type Outcome, type RecordingRestApi } from "./support/bandPlatform";
import { FakeOpencodeServer, type OpencodeTurn } from "./support/fakeOpencodeServer";
import { activitySequence, recordRuntimeActivity } from "../support/activityReports";
import { SlowFailureRest } from "../support/slowFailureRest";
import { ACT_TOOL, CLOSING_TEXT, contractRows, NO_REPLY_ARGS, TOOL_REPLY, turnInput, type TurnScript } from "../turnOutcomeContract";

const OWNER = "owner";
const APPROVER = "approver";
const INTRUDER = "intruder";
const PEOPLE = [OWNER, APPROVER, INTRUDER].map(person);

const DEADLINE_MS = 60_000;
const TURN_TIMEOUT_MS = 120_000;
// The default cadence of the working-state heartbeat.
const WORKING_HEARTBEAT_MS = 3000;
const SHORT_DEADLINE_MS = 30_000;

// OpenCode's Band tools are room-scoped: every call names its room.
const ROOM = { room_id: "room-1" };

/** What OpenCode's model does in one turn-outcome row; its Band calls go through the adapter's real MCP backend. */
const TURN_SCRIPTS: Record<TurnScript, (turn: OpencodeTurn) => Promise<void> | void> = {
  decline: async (turn) => {
    await turn.callTool(NO_REPLY_TOOL_NAME, { ...ROOM, ...NO_REPLY_ARGS });
    turn.answer(CLOSING_TEXT);
  },
  toolReply: async (turn) => {
    await turn.callTool(SEND_MESSAGE_TOOL_NAME, { ...ROOM, content: TOOL_REPLY, mentions: ["@owner"] });
    turn.answer(CLOSING_TEXT);
  },
  act: async (turn) => {
    await turn.callTool(ACT_TOOL, { ...ROOM, name: APPROVER });
    turn.idle();
  },
  finalText: (turn) => turn.answer(CLOSING_TEXT),
  nothing: (turn) => turn.idle(),
};

const DECLINED_ANSWER = "Understood, I won't run it.";
// The answer to the follow-up `afterTurn` sends.
const DONE = "Done.";
// What a one-question ask is answered with when the room declines it.
const DECLINED = [[DECLINED_QUESTION_ANSWER]];

const approvalPrompt = (requestId: string) => SAYS.approvalRequested({ requestId, permission: "bash", patterns: ["npm test"] });

type RoomOptions = Omit<NonNullable<ConstructorParameters<typeof OpencodeAdapter>[0]>, "config"> & {
  rest?: RecordingRestApi;
  server?: FakeOpencodeServer;
};

/** An OpenCode agent on the platform, in room-1, backed by its own local OpenCode server. */
async function opencodeRoom(config: OpencodeAdapterConfig = {}, { rest, server: given, ...adapterOptions }: RoomOptions = {}) {
  const server = given ?? await FakeOpencodeServer.start();
  const adapter = new OpencodeAdapter({ config: { baseUrl: server.url, approvalMode: "manual", ...config }, ...adapterOptions });
  const joined = await BandPlatform.join(adapter, PEOPLE, { rest });
  const { platform, room } = joined;
  return {
    adapter,
    server,
    platform,
    room,
    /** OWNER asks for something; OpenCode runs `script` on the prompt. */
    async start(script: (turn: OpencodeTurn) => Promise<void> | void, content = "Please run the tests") {
      server.onPrompt(script);
      return room.say(OWNER, content);
    },
    /**
     * Asks once more and waits for the answer. The room holds the question
     * until the handed-back turn really ends, past its relay and judgement.
     */
    async afterTurn() {
      server.onPrompt((turn) => turn.answer(DONE));
      await room.outcome(await room.say(OWNER, "Anything else?"));
      expect(room.messages.at(-1)?.content).toBe(DONE);
    },
    async [Symbol.asyncDispose]() {
      await joined[Symbol.asyncDispose]();
      if (!given) {
        await server[Symbol.asyncDispose]();
      }
    },
  };
}

/** Runs one answered turn on `server` and returns the platform an agent restarting on it resumes from. */
async function seedRoom(server: FakeOpencodeServer, content?: string): Promise<RecordingRestApi> {
  await using first = await opencodeRoom({}, { server });
  await first.start((turn) => turn.answer("First answer."), content);
  await first.room.nextMessage((posted) => posted.content === "First answer.");
  return first.platform.rest;
}

/** The real Band MCP backend, kept from starting until `held` is released; `listening` resolves with where it then listens. */
function heldBackend() {
  const holds = new CallHolds<[]>();
  const held = holds.hold(() => true);
  const listening = createDeferred<string>();
  const factory: typeof createBandMcpBackend = async (options) => {
    await holds.pass();
    const backend = await createBandMcpBackend(options);
    listening.resolve((backend.server as BandMcpServer).url!);
    return backend;
  };
  return { factory, held, listening: listening.promise };
}

/** The real HTTP client; `shut` resolves once the adapter has closed it, and `closeError`, if given, then fails the close. */
class ObservedClient extends HttpOpencodeClient {
  public readonly shut = createDeferred<void>();

  public constructor(baseUrl: string, private readonly closeError?: Error) {
    super({ baseUrl });
  }

  public override async close(): Promise<void> {
    await super.close();
    this.shut.resolve();
    if (this.closeError) {
      throw this.closeError;
    }
  }
}

/** A client factory that builds `ObservedClient`s and keeps each one, in the order the adapter asked for them. */
function observedClients(closeError?: Error) {
  const clients: ObservedClient[] = [];
  const clientFactory = (config: Required<OpencodeAdapterConfig>) => {
    const client = new ObservedClient(config.baseUrl, closeError);
    clients.push(client);
    return client;
  };
  return { clients, clientFactory };
}

/** OpenCode's own assistant message for the current prompt, and a `bash` part of it in `status`. */
function nativeBash(turn: OpencodeTurn) {
  turn.emit("message.updated", { info: { id: "native-assistant", parentID: turn.prompt.messageID, role: "assistant", sessionID: turn.sessionId } });
  return (status: string) => turn.emit("message.part.updated", {
    part: { sessionID: turn.sessionId, messageID: "native-assistant", id: "native", type: "tool", tool: "bash", state: { status } },
  });
}

type ActivityReports = ReturnType<typeof recordRuntimeActivity>;

/** Waits until the provider has opened something, so the turn's watchdog is running, then runs out its clock. */
async function timeOut(reports: ActivityReports): Promise<void> {
  await reports.next((entry) => entry.activity !== undefined && entry.activity.kind !== "reasoning");
  await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
}

type OpencodeRoom = Awaited<ReturnType<typeof opencodeRoom>>;

/**
 * What the room's activity read while a turn's failure was still being posted; `fail` makes the turn
 * fail, and `meanwhile` is what the room and OpenCode do before the failure lands.
 */
async function activityWhileFailing(
  script: (turn: OpencodeTurn, reports: ActivityReports) => Promise<void> | void,
  config: OpencodeAdapterConfig,
  fail: (reports: ActivityReports) => Promise<void> = async () => {},
  meanwhile: (session: OpencodeRoom) => Promise<unknown> = async () => {},
) {
  const reports = recordRuntimeActivity();
  const rest = new SlowFailureRest(PEOPLE);
  onTestFinished(() => rest.gate.resolve());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await using session = await opencodeRoom({ turnTimeoutMs: TURN_TIMEOUT_MS, ...config }, { rest });
  await session.start((turn) => script(turn, reports));
  await fail(reports);
  await rest.failurePosting.promise;
  await meanwhile(session);
  await vi.advanceTimersByTimeAsync(WORKING_HEARTBEAT_MS);
  const activity = reports.entries.at(-1)?.activity;
  rest.gate.resolve();
  await session.room.until(() => session.room.events(FAILURE_EVENT_TYPE).length === 1);
  return activity;
}

describe("OpenCode in a Band room", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses uncorrelated shared MCP activity while preserving execution", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    const message = await session.start(async (turn) => {
      const result = await turn.callTool("band_get_participants", ROOM);
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain(OWNER);
      turn.answer("Done.");
    });
    expect(await session.room.outcome(message)).toBe("processed");
    await reports.next((entry) => !entry.working);
    expect(reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, false,
    ]);
    expect(session.room.messages.at(-1)?.content).toBe("Done.");
  });

  it("suppresses uncorrelated shared MCP activity for a custom tool too, preserving its execution", async () => {
    const reports = recordRuntimeActivity();
    const handler = vi.fn(() => ({ id: "T-1" }));
    await using session = await opencodeRoom({ enableExecutionReporting: false }, {
      customTools: [{ name: "file_ticket", schema: z.object({ title: z.string() }), handler, effect: "act" }],
    });
    const message = await session.start(async (turn) => {
      const result = await turn.callTool("file_ticket", { ...ROOM, title: "Broken build" });
      expect(result.isError).toBeUndefined();
      turn.answer("Done.");
    });
    expect(await session.room.outcome(message)).toBe("processed");
    await reports.next((entry) => !entry.working);
    expect(handler).toHaveBeenCalledWith({ title: "Broken build" });
    expect(reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, false,
    ]);
  });

  it("attributes native parts to the submitted prompt and suppresses shared MCP observations", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    let oldPrompt: unknown;
    await session.start((turn) => { oldPrompt = turn.prompt.messageID; turn.answer("First answer."); });
    await reports.next((entry) => !entry.working);
    await session.afterTurn();
    const from = reports.entries.length;
    const release = createDeferred();
    const localFinished = createDeferred();
    const message = await session.start(async (turn) => {
      expect(turn.prompt.messageID).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
      expect(turn.prompt.messageID).not.toBe(oldPrompt);
      const assistant = (id: string, parentID: unknown) => turn.emit("message.updated", { info: { id, parentID, role: "assistant", sessionID: turn.sessionId } });
      const part = (messageID: string, id: string, status: string, tool = "bash") => turn.emit("message.part.updated", {
        part: { sessionID: turn.sessionId, messageID, id, type: "tool", tool, state: { status, input: { command: "private-command-marker" } } },
      });
      assistant("old-assistant", oldPrompt);
      part("old-assistant", "unseen-old-tool", "running", "stale_tool");
      part("unmatched-assistant", "unmatched-part", "running", "unmatched_tool");
      assistant("current-assistant", turn.prompt.messageID);
      part("current-assistant", "native", "pending");
      part("current-assistant", "native", "running");
      const result = await turn.callTool("band_get_participants", ROOM);
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain(OWNER);
      localFinished.resolve();
      await release.promise;
      part("old-assistant", "unseen-old-tool", "completed", "stale_tool");
      part("current-assistant", "native", "completed");
      part("current-assistant", "native", "completed");
      turn.answer("Done.");
    });
    try {
      await reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === "bash", from);
      await localFinished.promise;
      expect(reports.entries.slice(from).map(({ activity }) => activity)).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "bash" }]);
      release.resolve();
      expect(await session.room.outcome(message)).toBe("processed");
      await reports.next((entry) => !entry.working, from);
      expect(reports.entries.slice(from).map(({ working, activity }) => working ? activity : false)).toEqual([
        { kind: "reasoning" }, { kind: "tool_call", name: "bash" }, { kind: "reasoning" }, false,
      ]);
      expect(session.room.messages.at(-1)?.content).toBe("Done.");
      expect([...session.room.events("tool_call"), ...session.room.events("tool_result")]).toEqual([]);
      expect(JSON.stringify(reports.entries)).not.toContain("private-command-marker");
    } finally { release.resolve(); }
  });

  it.each(["completed", "error"])("ends a native part that finishes as %s", async (status) => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    const message = await session.start(async (turn) => {
      const part = nativeBash(turn);
      part("running");
      await reports.next((entry) => entry.activity?.kind === "tool_call");
      part(status);
      await reports.next((entry) => entry.activity?.kind === "reasoning", 2);
      turn.answer("Done.");
    });
    expect(await session.room.outcome(message)).toBe("processed");
    await reports.next((entry) => !entry.working);
    expect(activitySequence(reports)).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "bash" }, { kind: "reasoning" }, false]);
  });

  it("ends a running native part before a turn timeout's failure is delivered", async () => {
    expect(await activityWhileFailing((turn) => { nativeBash(turn)("running"); }, { enableExecutionReporting: false }, timeOut))
      .toEqual({ kind: "reasoning" });
  });

  it("ends an open permission wait before a turn timeout's failure is delivered", async () => {
    expect(await activityWhileFailing((turn) => void turn.askPermission({ id: "per_open" }), { approvalWaitTimeoutMs: TURN_TIMEOUT_MS * 2 }, timeOut))
      .toEqual({ kind: "reasoning" });
  });

  it("keeps the wait ended when the room answers one of the failed turn's asks before its failure is delivered", async () => {
    const asks = (turn: OpencodeTurn) => { turn.askPermission({ id: "per_first" }); turn.askPermission({ id: "per_second" }); };
    expect(await activityWhileFailing(asks, { approvalWaitTimeoutMs: TURN_TIMEOUT_MS * 2 }, timeOut, ({ room }) => room.exchange(OWNER, "approve per_first")))
      .toEqual({ kind: "reasoning" });
  });

  it("keeps the wait ended when OpenCode asks again after a session error, before its failure is delivered", async () => {
    expect(await activityWhileFailing(async (turn, reports) => {
      turn.askPermission({ id: "per_first" });
      await reports.next((entry) => entry.activity?.kind === "permission");
      turn.error("boom");
    }, {}, undefined, async ({ server }) => (await server.turn()).askPermission({ id: "per_late" }))).toEqual({ kind: "reasoning" });
  });

  it.each(["always", "reject"])("stops waiting once an `%s` reply settles the session's other asks on OpenCode", async (reply) => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    const { room } = session;
    await session.start(async (turn) => {
      await Promise.all([turn.askPermission({ id: "per_first" }), turn.askPermission({ id: "per_second" })].map((ask) => ask.reply));
      nativeBash(turn)("running");
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt("per_second"));
    await room.exchange(OWNER, `${reply} per_first`);

    await reports.next((entry) => entry.activity?.kind === "tool_call");
    expect(await room.exchange(OWNER, "approve per_second")).toEqual([SAYS.noLongerPending("permission", "per_second")]);
  });

  it("stops waiting once another OpenCode client answers the room's asks", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    const { room, server } = session;
    await session.start(async (turn) => {
      await Promise.all([turn.askPermission({ id: "per_tui" }), turn.askQuestion([{ question: "Proceed?" }], "que_tui")].map((ask) => ask.reply));
      nativeBash(turn)("running");
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], "que_tui"));
    server.replyPermission("per_tui", { reply: "once" });
    server.replyQuestion("que_tui", [["yes"]]);

    await reports.next((entry) => entry.activity?.kind === "tool_call");
    expect(await room.exchange(OWNER, "approve per_tui")).toEqual([SAYS.noLongerPending("permission", "per_tui")]);
    expect(await room.exchange(OWNER, "reject que_tui")).toEqual([SAYS.noLongerPending("question", "que_tui")]);
  });

  it("ends a running native part before a reply-less turn's failure is delivered", async () => {
    expect(await activityWhileFailing(async (turn, reports) => {
      nativeBash(turn)("running");
      await reports.next((entry) => entry.activity?.kind === "tool_call");
      turn.idle();
    }, { enableExecutionReporting: false })).toEqual({ kind: "reasoning" });
  });

  it("ends a running native part before a session error's failure is delivered", async () => {
    expect(await activityWhileFailing(async (turn, reports) => {
      nativeBash(turn)("running");
      await reports.next((entry) => entry.activity?.kind === "tool_call");
      turn.error("boom");
    }, { enableExecutionReporting: false })).toEqual({ kind: "reasoning" });
  });

  it("keeps working across a detached approval and its reply I/O until the provider terminates", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ enableExecutionReporting: false });
    const { room, platform, server } = session;
    const resumed = createDeferred();
    const terminal = createDeferred();
    const reply = server.hold("POST /permission/per_:id/reply");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const message = await session.start(async (turn) => {
      await turn.askPermission({ id: "per_working" }).reply;
      resumed.resolve();
      await terminal.promise;
      turn.answer("Done.");
    });
    try {
      await room.nextMessage((posted) => posted.content === approvalPrompt("per_working"));
      await room.outcome(message);
      expect(reports.entries.at(-1)?.activity).toEqual({ kind: "permission" });
      await vi.advanceTimersByTimeAsync(6000);
      // Initial reasoning, permission change, then two refreshes.
      expect(platform.rest.workingReports.entries.map((entry) => entry.working)).toEqual([true, true, true, true]);
      const control = room.exchange(OWNER, "approve per_working");
      await reply.sending;
      await vi.advanceTimersByTimeAsync(3000);
      expect(reports.entries.at(-1)?.activity).toEqual({ kind: "permission" });
      expect(platform.rest.workingReports.entries.at(-1)?.working).toBe(true);
      reply.release();
      await resumed.promise;
      await control;
      expect(reports.entries.at(-1)?.activity).toEqual({ kind: "reasoning" });
      expect(platform.rest.workingReports.entries.every((entry) => entry.working)).toBe(true);
      terminal.resolve();
      await platform.rest.workingReports.next((entry) => !entry.working);
      expect(platform.rest.workingReports.entries.at(-1)?.working).toBe(false);
    } finally { reply.release(); terminal.resolve(); vi.useRealTimers(); }
  });

  it("streams one answer to the requester, reporting each tool once and ignoring what is not the assistant's", async () => {
    await using session = await opencodeRoom({ enableExecutionReporting: true, providerId: "anthropic", modelId: "claude-test" });
    const { room, server } = session;
    const message = await session.start((turn) => {
      turn.emit("server.heartbeat", {});
      turn.emit("message.updated", { info: { id: "msg_user", role: "user", sessionID: turn.sessionId } });
      turn.emit("message.part.updated", { part: { id: "prt_user", messageID: "msg_user", sessionID: turn.sessionId, type: "text", text: "echoed prompt" } });
      turn.emit("message.updated", { info: { id: "msg_other", role: "assistant", sessionID: "ses_elsewhere" } });
      turn.emit("message.updated", { info: { id: "msg_think", role: "assistant", sessionID: turn.sessionId } });
      turn.emit("message.part.updated", { part: { id: "prt_think", messageID: "msg_think", sessionID: turn.sessionId, type: "reasoning", text: "thinking" } });
      turn.emit("message.part.delta", { sessionID: turn.sessionId, messageID: "msg_think", partID: "prt_think", field: "text", delta: " harder" });
      const tool = (part: Record<string, unknown>) => turn.emit("message.part.updated", { part: { messageID: "msg_think", sessionID: turn.sessionId, type: "tool", ...part } });
      tool({ id: "prt_t1", tool: "bash", callID: "call_1", state: { status: "pending", input: { command: "npm test" } } });
      tool({ id: "prt_t1", tool: "bash", callID: "call_1", state: { status: "running", input: { command: "npm test" } } });
      tool({ id: "prt_t1", tool: "bash", callID: "call_1", state: { status: "completed", output: "12 passed" } });
      tool({ id: "prt_t1", tool: "bash", callID: "call_1", state: { status: "completed", output: "12 passed" } });
      tool({ id: "prt_t2", tool: "read", state: { status: "error" } });
      turn.reply("All", " 12 tests", " pass.");
      turn.idle();
    });

    expect(await room.nextMessage((posted) => posted.content === "All 12 tests pass.")).toMatchObject({ mentions: [OWNER] });
    expect(await room.outcome(message)).toBe("processed");
    expect(room.events("tool_call").map((event) => JSON.parse(event.content))).toEqual([
      { name: "bash", args: { command: "npm test" }, tool_call_id: "call_1" },
      { name: "read", args: {}, tool_call_id: "prt_t2" },
    ]);
    expect(room.events("tool_result").map((event) => JSON.parse(event.content))).toEqual([
      { output: "12 passed", tool_call_id: "call_1" },
      { output: { error: "OpenCode tool failed" }, tool_call_id: "prt_t2" },
    ]);
    const [prompt] = server.requestsTo("POST", /\/prompt_async$/);
    expect(prompt!.body).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-test" }, parts: [{ type: "text", text: expect.stringContaining("[owner]: Please run the tests") }] });
    expect(server.requestsTo("POST", /^\/session$/)[0]!.body).toEqual({ title: "Band: Agent / room-1" });
    const [registration] = server.mcpRegistrations();
    expect(registration!.body).toMatchObject({ name: "band", config: { type: "remote", headers: { Authorization: expect.stringMatching(/^Bearer /) } } });
  });

  it("tells OpenCode which room and requester each turn is for, so its Band tools are callable", async () => {
    await using session = await opencodeRoom();
    await session.start((turn) => turn.answer("Done."));
    await session.room.nextMessage((posted) => posted.content === "Done.");

    const [prompt] = session.server.requestsTo("POST", /\/prompt_async$/);
    expect(prompt!.body.system).toEqual(expect.stringContaining("Current room_id: room-1"));
    expect(prompt!.body.system).toEqual(expect.stringContaining(`Current requester id: ${OWNER}`));
  });

  it("ignores what a finished turn's session sends once the turn is over", async () => {
    await using session = await opencodeRoom({ enableExecutionReporting: true });
    const { room, server } = session;
    const first = await session.start((turn) => turn.answer("First answer."));
    expect(await room.outcome(first)).toBe("processed");

    const finished = await server.turn();
    finished.emit("message.part.updated", { part: { id: "prt_late", messageID: "msg_late", sessionID: finished.sessionId, type: "tool", tool: "bash", callID: "call_late", state: { status: "running" } } });
    finished.idle();
    const second = await session.start((turn) => turn.answer("Second answer."), "And again");

    expect(await room.outcome(second)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["First answer.", "Second answer."]);
    expect(room.events("tool_call")).toEqual([]);
  });

  it("routes a busy room's replies to the asks still awaiting one, and only from allowed senders", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({}, { decisionAuthorizedSenders: [OWNER, APPROVER] });
    const { room, server } = session;
    const [first, second, question] = ["per_first", "per_second", "que_branch"];
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: first }), turn.askPermission({ id: second }), turn.askQuestion([{ question: "Which branch?" }], question)];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.answer("Done.");
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Which branch?" }], question));

    expect(await room.exchange(OWNER, "approve")).toEqual([SAYS.whichPermissionHint([first, second])]);
    expect(await room.exchange(OWNER, "reject")).toEqual([SAYS.dualRejectHint([first, second], [question])]);
    expect(await room.exchange(INTRUDER, `approve ${second}`)).toEqual([SAYS.notAuthorized()]);
    expect(await room.exchange(APPROVER, `@[[agent-1]] approve ${second}`)).toEqual([SAYS.approvalHandled(second, "once")]);
    expect(reports.entries.at(-1)?.activity).toEqual({ kind: "permission" });
    // With `second` answered, a bare command means the one ask of its kind still open.
    expect(await room.exchange(OWNER, "always")).toEqual([SAYS.approvalHandled(first, "always")]);
    expect(reports.entries.at(-1)?.activity).toEqual({ kind: "permission" });
    expect(await room.exchange(OWNER, "reject")).toContain(SAYS.questionRejected(question));

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([[second, "once"], [first, "always"]]);
    expect(server.questionReplies()).toEqual([[question, DECLINED]]);
    expect(await room.exchange(OWNER, `approve ${first}`)).toEqual([SAYS.noLongerPending("permission", first)]);
  });

  it("answers questions line by line, oldest first, and hints when an answer is short or aimed wrong", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const [pair, single] = ["que_pair", "que_single"];
    await session.start(async (turn) => {
      const asks = [turn.askQuestion([{ question: "Name?" }, { question: "Role?" }], pair), turn.askQuestion([{ question: "Colour?" }], single)];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.answer("Thanks.");
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Colour?" }], single));

    expect(await room.exchange(OWNER, "Alice")).toEqual([SAYS.waitingForAnswers()]);
    expect(await room.exchange(OWNER, `approve ${pair}`)).toEqual([SAYS.questionHint([pair, single])]);
    expect(await room.exchange(OWNER, "reject que_wrong")).toEqual([SAYS.noLongerPending("question", "que_wrong")]);
    expect(await room.exchange(OWNER, "Alice\nEngineer")).toEqual([SAYS.questionAnswered(pair)]);
    expect(await room.exchange(OWNER, "approve the blue one")).toContain(SAYS.questionAnswered(single));

    await room.nextMessage((posted) => posted.content === "Thanks.");
    expect(server.questionReplies()).toEqual([[pair, [["Alice"], ["Engineer"]]], [single, [["approve the blue one"]]]]);
  });

  it("confirms an answer to the person who gave it even when OpenCode finishes before the reply returns", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    await session.start((turn) => void turn.askQuestion([{ question: "Proceed?" }], "que_last"));
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], "que_last"));
    const slowReply = server.hold("POST /question/que_:id/reply");

    const confirmation = room.exchange(OWNER, "yes");
    await slowReply.sending;
    (await server.turn()).answer("Done.");
    await room.nextMessage((posted) => posted.content === "Done.");
    slowReply.release();

    expect(await confirmation).toContain(SAYS.questionAnswered("que_last"));
  });

  it.each([
    { timeoutReply: "reject", expected: "reject" },
    { timeoutReply: "once", expected: "once" },
    { timeoutReply: "always", expected: "always" },
  ] as const)("applies `$timeoutReply` to an approval nobody answers, and restarts the clock on redelivery", async ({ timeoutReply, expected }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalWaitTimeoutMs: DEADLINE_MS, approvalTimeoutReply: timeoutReply, questionWaitTimeoutMs: SHORT_DEADLINE_MS });
    const { room, server } = session;
    const [permission, question] = ["per_unanswered", "que_unanswered"];
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: permission }), turn.askQuestion([{ question: "Proceed?" }], question)];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.idle();
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));

    await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
    await server.until(() => server.questionReplies().length === 1);
    (await server.turn()).askPermission({ id: permission });
    await room.until(() => room.messages.filter((posted) => posted.content === approvalPrompt(permission)).length === 2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(server.permissionReplies()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await server.until(() => server.permissionReplies().length === 1);

    expect(server.permissionReplies()).toEqual([[permission, expected]]);
    expect(server.questionReplies()).toEqual([[question, DECLINED]]);
    await room.until(() => room.events("error").length === 2);
    expect(room.events("error").map((event) => event.content)).toEqual([
      SAYS.questionTimedOut(question),
      SAYS.approvalTimedOut(permission, expected),
    ]);
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.noLongerPending("permission", permission)]);
  });

  // A question with nothing to answer is rejected under every policy, rather than left blocking OpenCode.
  it("approves automatically under auto_accept, and still asks the room its questions", async () => {
    await using session = await opencodeRoom({ approvalMode: "auto_accept", questionMode: "manual" });
    const { room, server } = session;
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: "per_auto" }), turn.askQuestion([], "que_empty"), turn.askQuestion([{ question: "Proceed?" }], "que_ask")];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.answer("Done.");
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], "que_ask"));
    // OpenCode resumes on its reply event, so the answer can land before the room's acknowledgement.
    expect(await room.exchange(OWNER, "yes")).toContain(SAYS.questionAnswered("que_ask"));

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([["per_auto", "once"]]);
    expect(new Map(server.questionReplies())).toEqual(new Map<string, unknown>([["que_empty", []], ["que_ask", [["yes"]]]]));
    expect(room.messages).not.toContainEqual(expect.objectContaining({ content: approvalPrompt("per_auto") }));
  });

  it("declines approvals and rejects questions without asking the room under auto_decline and auto_reject", async () => {
    const reports = recordRuntimeActivity();
    await using session = await opencodeRoom({ approvalMode: "auto_decline", questionMode: "auto_reject" });
    const { room, server } = session;
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: "per_auto" }), turn.askQuestion([], "que_empty"), turn.askQuestion([{ question: "Proceed?" }], "que_ask")];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.answer("Done.");
    });

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([["per_auto", "reject"]]);
    expect(new Map(server.questionReplies())).toEqual(new Map<string, unknown>([["que_empty", []], ["que_ask", DECLINED]]));
    expect(room.messages.map((posted) => posted.content)).toEqual(["Done."]);
    expect(reports.entries.some(({ activity }) => activity?.kind === "permission")).toBe(false);
  });

  it("fails the turn when OpenCode refuses a room's reply, drops the sibling asks, and serves the next request on the same session", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const [refused, sibling] = ["per_refused", "per_sibling"];
    const first = await session.start((turn) => {
      turn.askPermission({ id: refused });
      turn.askPermission({ id: sibling });
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(sibling));
    server.failNext("POST /permission/per_:id/reply", { status: 503, body: { name: "UnavailableError", data: { message: "busy" } } });

    const reply = await room.say(OWNER, `approve ${refused}`);
    expect(await room.outcome(reply)).toBe("failed");
    expect(await room.outcome(first)).toBe("processed");
    const [failure] = room.events(FAILURE_EVENT_TYPE);
    expect(failure?.metadata?.failure).toMatchObject({ code: "503" });
    expect(await room.exchange(OWNER, `approve ${sibling}`)).toEqual([SAYS.noLongerPending("permission", sibling)]);
    await server.until(() => server.requestsTo("POST", /\/abort$/).length === 1);

    const next = await session.start((turn) => turn.answer("Second answer."), "Try again");
    await room.nextMessage((posted) => posted.content === "Second answer.");
    expect(await room.outcome(next)).toBe("processed");
    // The failed turn's session was aborted, so the retry opens a fresh one with the room's history replayed.
    const prompts = server.requestsTo("POST", /\/prompt_async$/);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.path).not.toBe(prompts[0]!.path);
    expect(prompts[1]!.body.parts).toEqual([{ type: "text", text: expect.stringContaining("Recovered room history") }]);
  });

  it("lets a reply that claimed an ask while its prompt was failing answer it, and rejects an unclaimed one on OpenCode", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const landed = "per_landed";
    await session.start(async (turn) => {
      await turn.askPermission({ id: landed }).reply;
      turn.answer("Done.");
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(landed));
    const failedPrompt = room.holdMessage((content) => content === approvalPrompt("per_claimed"), { error: new Error("platform timed out") });
    const claimed = (await server.turn()).askPermission({ id: "per_claimed" });
    await failedPrompt.sending;

    expect(await room.exchange(OWNER, "approve per_claimed")).toEqual([SAYS.approvalHandled("per_claimed", "once")]);
    failedPrompt.release();
    expect(await room.exchange(OWNER, `approve ${landed}`)).toContain(SAYS.approvalHandled(landed, "once"));

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(await claimed.reply).toEqual({ reply: "once" });
    expect(server.permissionReplies()).toEqual([["per_claimed", "once"], [landed, "once"]]);
    expect(room.events(FAILURE_EVENT_TYPE)).toEqual([]);
  });

  it("resumes the room's OpenCode session after the agent restarts, and starts over when OpenCode lost it", async () => {
    await using server = await FakeOpencodeServer.start();
    const rest = await seedRoom(server, "Remember the number 7");
    {
      await using restarted = await opencodeRoom({}, { server, rest });
      await restarted.start((turn) => turn.answer("Second answer."), "What was the number?");
      await restarted.room.nextMessage((posted) => posted.content === "Second answer.");
      expect(restarted.room.events("task").at(-1)?.content).toMatch(/resumed/i);
    }
    server.forgetSessions();
    {
      await using restarted = await opencodeRoom({}, { server, rest });
      await restarted.start((turn) => turn.answer("Third answer."), "And now?");
      await restarted.room.nextMessage((posted) => posted.content === "Third answer.");
    }

    const prompts = server.requestsTo("POST", /\/prompt_async$/);
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
    expect(prompts[1]!.path).toBe(prompts[0]!.path);
    expect(prompts[2]!.path).not.toBe(prompts[0]!.path);
    expect(prompts[2]!.body.parts).toEqual([{ type: "text", text: expect.stringMatching(/Recovered room history[\s\S]*Remember the number 7[\s\S]*\[owner\]: And now\?/) }]);
  });

  it.each([
    { failure: "a plain-text 500", response: { status: 500, body: "database locked" }, detail: "database locked" },
    { failure: "a structured 500", response: { status: 500, body: { name: "StorageError", data: { message: "disk full" } } }, detail: "disk full" },
  ])("fails the turn when restoring the session hits $failure", async ({ response, detail }) => {
    await using server = await FakeOpencodeServer.start();
    await using restarted = await opencodeRoom({}, { server, rest: await seedRoom(server) });
    server.failNext("GET /session/ses_:id", response);

    const message = await restarted.room.say(OWNER, "Continue");
    expect(await restarted.room.outcome(message)).toBe("failed");
    expect(JSON.stringify(restarted.room.events(FAILURE_EVENT_TYPE)[0]?.metadata)).toContain(detail);
  });

  it.each([
    { payload: "a nested message", error: { name: "ProviderAuthError", data: { message: "invalid key" } }, shows: "invalid key" },
    { payload: "only a name", error: { name: "UnknownError" }, shows: "UnknownError" },
    { payload: "a bare string", error: "boom", shows: "OpenCode" },
    { payload: "a message but no name", error: { data: { message: "quota exceeded" } }, shows: "OpenCodeError: quota exceeded" },
  ])("fails the turn on a session error carrying $payload, after delivering the text streamed so far", async ({ error, shows }) => {
    await using session = await opencodeRoom();
    const { room } = session;
    const message = await session.start((turn) => {
      turn.reply("Partial work.");
      turn.error(error);
    });

    expect(await room.outcome(message)).toBe("failed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["Partial work."]);
    expect(room.events(FAILURE_EVENT_TYPE)[0]?.content).toContain(shows);
  });

  it("times out a turn stuck on an unanswered ask, aborts it even if the abort never answers, and opens a fresh session next time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ turnTimeoutMs: TURN_TIMEOUT_MS, approvalWaitTimeoutMs: TURN_TIMEOUT_MS * 2 });
    const { room, server } = session;
    const hungAbort = server.hold("POST /session/ses_:id/abort");
    const stuck = await session.start((turn) => void turn.askPermission({ id: "per_stuck" }));
    // The room gets its queue back once OpenCode asks, and by then the turn's watchdog is running.
    expect(await room.outcome(stuck)).toBe("processed");

    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    await hungAbort.sending;
    await room.until(() => room.events(FAILURE_EVENT_TYPE).length === 1);
    hungAbort.release();
    expect(await room.exchange(OWNER, "approve per_stuck")).toEqual([SAYS.noLongerPending("permission", "per_stuck")]);

    vi.useRealTimers();
    const next = await session.start((turn) => {
      // A late event from the abandoned session must not leak into this turn.
      server.broadcast({ type: "permission.asked", properties: { id: "per_stale", sessionID: "ses_0001", permission: "bash", patterns: [] } });
      turn.answer("Fresh answer.");
    }, "Try again");
    await room.nextMessage((posted) => posted.content === "Fresh answer.");
    expect(await room.outcome(next)).toBe("processed");
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
    expect(room.messages.some((posted) => posted.content.includes("per_stale"))).toBe(false);
  });

  it("keeps serving a turn when OpenCode's event stream drops and reconnects", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_reconnect";
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      turn.answer("Survived the reconnect.");
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));

    server.dropEventStreams();
    await server.until(() => server.eventStreamCount === 2);
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);

    await room.nextMessage((posted) => posted.content === "Survived the reconnect.");
  });

  it("serves two rooms from one OpenCode server, deregisters its tools only when the last room goes, and registers them again for the next", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const other = await platform.room("room-2");
    const later = await platform.room("room-4");
    const answer = (text: string) => (turn: OpencodeTurn) => turn.answer(text);
    await session.start(answer("Room one."));
    await room.nextMessage((posted) => posted.content === "Room one.");
    server.onPrompt(answer("Room two."));
    await other.say(OWNER, "Hello from room two");
    await other.nextMessage((posted) => posted.content === "Room two.");

    const neverUsed = await platform.room("room-3");
    await neverUsed.remove();
    await room.remove();
    await other.say(OWNER, "Still there?");
    server.onPrompt(answer("Still here."));
    await other.nextMessage((posted) => posted.content === "Still here.");
    expect(server.mcpDeregistrations()).toEqual([]);

    await other.remove();
    await server.until(() => server.mcpDeregistrations().length === 1);
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);

    server.onPrompt(answer("Room four."));
    await later.say(OWNER, "Hello after everyone left");
    await later.nextMessage((posted) => posted.content === "Room four.");
    expect(server.mcpRegistrations()).toHaveLength(2);
  });

  it("stops an MCP backend that finishes starting after the adapter stopped", async () => {
    const backend = heldBackend();
    const { clients, clientFactory } = observedClients();
    await using session = await opencodeRoom({}, { mcpBackendFactory: backend.factory, clientFactory });
    const message = await session.room.say(OWNER, "Please run the tests");
    await backend.held.sending;

    const stopped = session.adapter.onRuntimeStop();
    // Shutdown closes the client without waiting for the backend's start.
    await clients[0]!.shut.promise;
    backend.held.release();
    const url = await backend.listening;
    await stopped;

    expect(await session.room.outcome(message)).toBe("failed");
    await expectMcpServerStopped(url);
    expect(session.server.mcpRegistrations(), "OpenCode is not left pointing at the stopped backend").toEqual([]);
  });

  it("stops the MCP backend even when the OpenCode client fails to close", async () => {
    const backend = heldBackend();
    const { clientFactory } = observedClients(new Error("close failed"));
    await using session = await opencodeRoom({}, { mcpBackendFactory: backend.factory, clientFactory });
    await session.start((turn) => turn.answer("Answered."));
    await backend.held.sending;
    backend.held.release();
    const url = await backend.listening;
    await session.room.nextMessage((posted) => posted.content === "Answered.");

    await expect(session.adapter.onRuntimeStop()).rejects.toThrow("close failed");
    await expectMcpServerStopped(url);
  });

  it("starts a second room's first turn only once OpenCode has Band's tools", async () => {
    const backend = heldBackend();
    await using session = await opencodeRoom({}, { mcpBackendFactory: backend.factory });
    const { room, server, platform } = session;
    const other = await platform.room("room-2");
    const answer = "Answered.";
    const answered = (posted: { content: string }) => posted.content === answer;
    // One prompt per room.
    const reply = (turn: OpencodeTurn) => turn.answer(answer);
    server.onPrompt(reply);
    server.onPrompt(reply);

    await room.say(OWNER, "Hello from room one");
    await backend.held.sending;
    await other.processing(await other.say(OWNER, "Hello from room two"));
    backend.held.release();
    await room.nextMessage(answered);
    await other.nextMessage(answered);

    const setup = server.requestsTo("POST", /^\/(mcp|session)$/);
    expect(setup.map((request) => request.path)).toEqual(["/mcp", "/session", "/session"]);
  });

  it("keeps answering when the OpenCode client or Band's tools fail to start", async () => {
    let clientFails = true;
    const clientFactory = (config: Required<OpencodeAdapterConfig>) => {
      if (clientFails) {
        clientFails = false;
        throw new Error("OpenCode is unavailable");
      }
      return new HttpOpencodeClient({ baseUrl: config.baseUrl });
    };
    const mcpBackendFactory = async () => {
      throw new Error("No port to listen on");
    };
    await using session = await opencodeRoom({}, { clientFactory, mcpBackendFactory });
    const { room, server } = session;

    expect(await room.outcome(await room.say(OWNER, "First try"))).toBe("failed");
    await session.start((turn) => turn.answer("Answered without Band's tools."));
    await room.nextMessage((posted) => posted.content === "Answered without Band's tools.");
    expect(server.mcpRegistrations()).toEqual([]);
    await session.adapter.onRuntimeStop();
  });

  it("keeps a shut-down client's event loop off the client started while it shuts down", async () => {
    const { clients, clientFactory } = observedClients();
    await using session = await opencodeRoom({}, { clientFactory });
    const { room, server } = session;
    await session.start((turn) => turn.answer("First answer."));
    await room.nextMessage((posted) => posted.content === "First answer.");

    // Shutdown deregisters the tools before it closes the client, so holding that keeps the old stream open.
    const deregister = server.holdMcpDeregistration();
    const stopped = session.adapter.onRuntimeStop();
    await deregister.sending;
    await session.start((turn) => turn.answer("Second answer."));
    await room.nextMessage((posted) => posted.content === "Second answer.");
    deregister.release();
    await clients[0]!.shut.promise;
    await stopped;

    const permission = "per_once";
    await session.start((turn) => {
      turn.askPermission({ id: permission });
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    expect(room.messages.filter((posted) => posted.content === approvalPrompt(permission)), "the ask was prompted once").toHaveLength(1);
    expect(clients).toHaveLength(2);
  });

  it("mentions the requester on an ask raised after the turn's answer went out", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const message = await session.start((turn) => turn.answer("Done."));
    await room.nextMessage((posted) => posted.content === "Done.");
    expect(await room.outcome(message)).toBe("processed");

    const { reply } = (await server.turn()).askPermission({ id: "per_late" });
    expect(await room.nextMessage((posted) => posted.content === approvalPrompt("per_late"))).toMatchObject({ mentions: [OWNER] });
    expect(await room.exchange(OWNER, "approve per_late")).toEqual([SAYS.approvalHandled("per_late", "once")]);
    expect(await reply).toEqual({ reply: "once" });
    expect(server.requestsTo("POST", /\/abort$/)).toEqual([]);
  });

  it("lets OpenCode talk through Band's tools and the app's own, scoped to its directory and workspace", async () => {
    await using session = await opencodeRoom({ directory: "/work/repo", workspace: "ws-1", fallbackSendAgentText: false }, {
      customTools: [
        { name: "lookup_ticket", description: "Find a ticket", schema: z.object({ id: z.string() }), handler: ({ id }) => ({ title: `Ticket ${String(id)}` }) },
        { name: "flaky_tool", schema: z.object({}), handler: () => { throw new Error("upstream down"); } },
      ],
    });
    const { room, server } = session;
    const calls = createDeferred<Array<{ isError?: boolean; text: string }>>();
    const message = await session.start(async (turn) => {
      calls.resolve([
        await turn.callTool("band_send_message", { room_id: "room-1", content: "Looking into it", mentions: ["@owner"] }),
        await turn.callTool("band_send_message", { room_id: "room-9", content: "Wrong room", mentions: ["@owner"] }),
        await turn.callTool("lookup_ticket", { room_id: "room-1", id: "T-7" }),
        await turn.callTool("flaky_tool", { room_id: "room-1" }),
      ]);
      // With fallback off, only what OpenCode sends through Band's tools reaches the room.
      turn.answer("Plain text nobody sees.");
    });

    const [sent, wrongRoom, lookup, flaky] = await calls.promise;
    expect(sent?.isError).toBeUndefined();
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages).toEqual([expect.objectContaining({ content: "Looking into it", mentions: [OWNER] })]);
    expect(wrongRoom).toMatchObject({ isError: true, text: expect.stringContaining("room-9") });
    expect(JSON.parse(lookup!.text)).toEqual({ title: "Ticket T-7" });
    expect(flaky).toMatchObject({ isError: true, text: expect.stringContaining("upstream down") });
    // Every OpenCode call is scoped to the configured project.
    expect(server.requests.entries.filter((request) => request.path !== "/mcp/band" || request.method !== "DELETE").every((request) => request.query.directory === "/work/repo" && request.query.workspace === "ws-1")).toBe(true);
  });

  it("ignores malformed and foreign events, and still answers", async () => {
    await using session = await opencodeRoom({ enableExecutionReporting: true });
    const { room } = session;
    const message = await session.start((turn) => {
      const garbage: Array<[string, Record<string, unknown>]> = [
        ["", {}],
        ["message.updated", {}],
        ["message.updated", { info: { role: "assistant", sessionID: turn.sessionId } }],
        ["message.part.updated", { sessionID: turn.sessionId }],
        ["message.part.updated", { part: { sessionID: turn.sessionId, type: "text", text: "no id" } }],
        ["message.part.delta", { sessionID: turn.sessionId, messageID: "msg_unknown", partID: "prt_x", field: "text", delta: "stray" }],
        ["message.part.delta", { sessionID: turn.sessionId, field: "text", delta: "no ids" }],
        ["permission.asked", { sessionID: turn.sessionId, permission: "bash" }],
        ["question.asked", { sessionID: turn.sessionId, questions: [{ question: "no id" }] }],
        ["session.status", { sessionID: turn.sessionId, status: "busy" }],
        ["permission.asked", { sessionID: "ses_foreign", id: "per_foreign" }],
      ];
      garbage.forEach(([type, properties]) => turn.emit(type, properties));
      const messageId = turn.reply("Answer");
      turn.emit("message.part.delta", { sessionID: turn.sessionId, messageID: messageId, partID: "prt_1", field: "reasoning", delta: " ignored" });
      turn.emit("message.part.delta", { sessionID: turn.sessionId, messageID: messageId, partID: "prt_1", field: "text" });
      turn.emit("message.part.updated", { part: { id: "prt_tool", messageID: messageId, sessionID: turn.sessionId, type: "tool" } });
      turn.idle();
    });

    expect(await room.outcome(message)).toBe("processed");
    await room.nextMessage((posted) => posted.content === "Answer");
    expect(room.messages.map((posted) => posted.content)).toEqual(["Answer"]);
    // A tool part with no state yet has nothing to report.
    expect(room.events("tool_call")).toEqual([]);
  });

  it.each([
    { outcome: "recovers", recovery: "Recovered after a retry.", settles: "processed" },
    { outcome: "never recovers", recovery: null, settles: "failed" },
  ] as const)("settles a turn whose message error $outcome", async ({ recovery, settles }) => {
    await using session = await opencodeRoom();
    const { room } = session;
    const message = await session.start((turn) => {
      turn.emit("message.updated", { info: { id: "msg_failed", role: "assistant", sessionID: turn.sessionId, error: { name: "APIError", data: { message: "rate limited" } } } });
      if (recovery) {
        turn.reply(recovery);
      }
      turn.idle();
    });

    expect(await room.outcome(message)).toBe(settles);
    expect(room.messages.map((posted) => posted.content)).toEqual(recovery ? [recovery] : []);
    expect(room.events(FAILURE_EVENT_TYPE).map((event) => event.content)).toEqual(recovery ? [] : [expect.stringContaining("rate limited")]);
  });

  it("holds a requester's message while OpenCode waits on an approval, and runs it as the next turn", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_busy";
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      turn.answer("Done.");
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    server.onPrompt((turn) => turn.answer("It is done."));

    const hurry = await room.say(OWNER, "Is it done yet?");
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    expect(await room.outcome(hurry)).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual([
      approvalPrompt(permission),
      SAYS.approvalHandled(permission, "once"),
      "Done.",
      "It is done.",
    ]);
    const prompts = server.requestsTo("POST", /\/prompt_async$/);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1]?.body)).toContain("Is it done yet?");
    expect(room.events("error")).toEqual([]);
  });

  it("lets expiries that are already replying own their asks against late room replies and a redelivery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalWaitTimeoutMs: DEADLINE_MS, questionWaitTimeoutMs: DEADLINE_MS });
    const { room, server } = session;
    const [permission, question] = ["per_expiring", "que_expiring"];
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: permission }), turn.askQuestion([{ question: "Proceed?" }], question)];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.idle();
    });
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));
    const expiryReplies = [server.hold("POST /permission/per_:id/reply"), server.hold("POST /question/que_:id/reply")];

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await Promise.all(expiryReplies.map((reply) => reply.sending));
    // The expiries own both asks now: the room's replies neither answer them nor say they did.
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([]);
    expect(await room.exchange(OWNER, `reject ${question}`)).toEqual([]);
    // With no live ask to answer, this is an ordinary message: held until the turn ends.
    const later = await room.say(OWNER, "yes please");
    // OpenCode redelivers the ask being expired; the marker behind it shows it was handled, and not prompted again.
    const turn = await server.turn();
    turn.askPermission({ id: permission });
    turn.askPermission({ id: "per_marker" });
    await room.nextMessage((posted) => posted.content === approvalPrompt("per_marker"));
    server.onPrompt((next) => next.answer(DONE));
    expiryReplies.forEach((reply) => reply.release());
    expect(await room.outcome(later)).toBe("processed");
    expect(room.messages.at(-1)?.content).toBe(DONE);
    expect(room.events("error").map((event) => event.content).sort()).toEqual([
      MISSING_REPLY.content,
      SAYS.approvalTimedOut(permission, "reject"),
      SAYS.questionTimedOut(question),
    ].sort());

    expect(server.permissionReplies()).toEqual([[permission, "reject"]]);
    expect(server.questionReplies()).toEqual([[question, DECLINED]]);
    expect(room.messages.filter((posted) => posted.content === approvalPrompt(permission))).toHaveLength(1);
  });

  it("rejects an approval on OpenCode when the room never got its prompt, fails the turn, and starts fresh next time", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const refused = room.holdMessage((content) => content === approvalPrompt("per_unseen"), { error: new Error("platform unavailable") });
    const message = await session.start((turn) => void turn.askPermission({ id: "per_unseen" }));
    await refused.sending;
    refused.release();

    expect(await room.outcome(message)).toBe("failed");
    await server.until(() => server.permissionReplies().length === 1);
    expect(server.permissionReplies()).toEqual([["per_unseen", "reject"]]);
    expect(server.permissionFeedback(), "a reject that only unblocks OpenCode ends its loop").toEqual([["per_unseen", undefined]]);
    expect(room.events(FAILURE_EVENT_TYPE)).toEqual([]);

    const next = await session.start((turn) => turn.answer("Fresh start."), "Try again");
    await room.nextMessage((posted) => posted.content === "Fresh start.");
    expect(await room.outcome(next)).toBe("processed");
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
  });

  it.each([
    { reply: "an automatic approval", config: { approvalMode: "auto_accept" }, waitMs: 0 },
    { reply: "an expired approval's reply", config: { approvalWaitTimeoutMs: DEADLINE_MS }, waitMs: DEADLINE_MS },
  ] as const)("reports $reply OpenCode refuses once, with no timeout notice", async ({ config, waitMs }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ turnTimeoutMs: DEADLINE_MS * 2, ...config });
    const { room, server } = session;
    server.failNext("POST /permission/per_:id/reply", { status: 503, body: { name: "UnavailableError", data: { message: "busy" } } });
    const reply = server.awaitRequest("POST", "/permission/per_asked/reply");
    await session.start((turn) => void turn.askPermission({ id: "per_asked" }));
    if (waitMs > 0) {
      await room.nextMessage((posted) => posted.content === approvalPrompt("per_asked"));
      await vi.advanceTimersByTimeAsync(waitMs);
    }
    await reply;
    await room.until(() => room.events(FAILURE_EVENT_TYPE).length === 1);
    expect(room.events(FAILURE_EVENT_TYPE)[0]?.metadata?.failure).toMatchObject({ code: "503" });
    expect(room.events("error").map((event) => event.content)).toEqual([room.events(FAILURE_EVENT_TYPE)[0]?.content]);
    expect(server.eventStreamCount).toBe(1);
  });

  it("blames only the timeout when a reply still in flight is refused after its turn gave up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalMode: "auto_accept", turnTimeoutMs: DEADLINE_MS });
    const { room, server } = session;
    const inFlight = server.hold("POST /permission/per_:id/reply");
    server.failNext("POST /permission/per_:id/reply", { status: 503, body: "busy" });
    const message = await session.start((turn) => void turn.askPermission());
    await inFlight.sending;

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await room.outcome(message)).toBe("failed");
    inFlight.release();
    await server.until(() => server.requestsTo("POST", /\/abort$/).length === 1);

    expect(room.events(FAILURE_EVENT_TYPE).map((event) => event.metadata?.failure)).toEqual([expect.objectContaining({ code: "timeout" })]);
  });

  it("lets an approval expire while its prompt is still being posted, and finishes the turn on that reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalWaitTimeoutMs: SHORT_DEADLINE_MS, turnTimeoutMs: DEADLINE_MS });
    const { room, server } = session;
    const slowPrompt = room.holdMessage((content) => content === approvalPrompt("per_slow"));
    const message = await session.start(async (turn) => {
      await turn.askPermission({ id: "per_slow" }).reply;
      turn.answer("Went ahead without it.");
    });
    await slowPrompt.sending;

    await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
    await room.until(() => room.events("error").length === 1);
    slowPrompt.release();

    await room.nextMessage((posted) => posted.content === "Went ahead without it.");
    expect(await room.outcome(message)).toBe("processed");
    expect(server.permissionReplies()).toEqual([["per_slow", "reject"]]);
    expect(server.permissionFeedback()).toEqual([["per_slow", REJECTED_PERMISSION_FEEDBACK]]);
    expect(room.events("error").map((event) => event.content)).toEqual([SAYS.approvalTimedOut("per_slow", "reject")]);
  });

  it.each([
    { cause: "the server is gone", setup: async (server: FakeOpencodeServer) => server[Symbol.asyncDispose](), shows: "OpenCode failed while processing the message" },
    { cause: "a session comes back without an id", setup: (server: FakeOpencodeServer) => server.failNext("POST /session", { status: 200, body: {} }), shows: "session without an id" },
  ])("fails the turn when $cause", async ({ setup, shows }) => {
    await using server = await FakeOpencodeServer.start();
    await using session = await opencodeRoom({}, { server });
    const { room } = session;
    await setup(server);

    const message = await room.say(OWNER, "Please run the tests");
    expect(await room.outcome(message)).toBe("failed");
    expect(room.events(FAILURE_EVENT_TYPE)[0]?.content).toContain(shows);
  });

  it("fails a turn whose answer the platform refuses, so it is retried, without blaming OpenCode", async () => {
    await using session = await opencodeRoom();
    const { room } = session;
    const refused = room.holdMessage((content) => content === "The answer.", { error: new Error("platform unavailable") });
    const message = await session.start((turn) => turn.answer("The answer."));
    await refused.sending;
    refused.release();

    expect(await room.outcome(message)).toBe("failed");
    expect(room.events(FAILURE_EVENT_TYPE)).toEqual([]);
  });

  it.each([
    { failure: "a structured error", response: { status: 500, body: { name: "ProviderError", data: { message: "model overloaded" } } }, shows: "model overloaded" },
    { failure: "a plain-text error", response: { status: 502, body: "bad gateway" }, shows: "bad gateway" },
  ])("fails the turn with OpenCode's status when submitting the prompt returns $failure", async ({ response, shows }) => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    server.failNext("POST /session/ses_:id/prompt_async", response);

    const message = await room.say(OWNER, "Please run the tests");
    expect(await room.outcome(message)).toBe("failed");
    const [failure] = room.events(FAILURE_EVENT_TYPE);
    expect(failure?.metadata?.failure).toMatchObject({ code: String(response.status) });
    expect(JSON.stringify(failure?.metadata)).toContain(shows);
  });

  it("keeps starting fresh, with the room's history, until a replacement session actually takes a prompt", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const refused = room.holdMessage((content) => content === approvalPrompt("per_unseen"), { error: new Error("platform unavailable") });
    const first = await session.start((turn) => void turn.askPermission({ id: "per_unseen" }));
    await refused.sending;
    refused.release();
    expect(await room.outcome(first)).toBe("failed");

    server.failNext("POST /session", { status: 500, body: "cannot create" });
    expect(await room.outcome(await room.say(OWNER, "Retry once"))).toBe("failed");
    server.failNext("POST /session/ses_:id/prompt_async", { status: 500, body: "cannot prompt" });
    expect(await room.outcome(await room.say(OWNER, "Retry twice"))).toBe("failed");
    const recovered = await session.start((turn) => turn.answer("Back on track."), "Retry again");

    await room.nextMessage((posted) => posted.content === "Back on track.");
    expect(await room.outcome(recovered)).toBe("processed");
    const prompts = server.requestsTo("POST", /\/prompt_async$/);
    expect(new Set(prompts.map((prompt) => prompt.path)).size).toBe(3);
    expect(prompts.at(-1)!.body.parts).toEqual([{ type: "text", text: expect.stringMatching(/Recovered room history[\s\S]*\[owner\]: Retry again/) }]);
  });

  it("drops a room's open asks when the agent leaves it mid-turn", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_dropped";
    const message = await session.start((turn) => void turn.askPermission({ id: permission }));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    expect(await room.outcome(message)).toBe("processed");

    await room.remove();
    await server.until(() => server.mcpDeregistrations().length === 1);

    expect(server.permissionReplies()).toEqual([]);
    expect(room.failures, "a cancelled turn is not a missing reply").toEqual([]);
    expect(room.messages.filter((posted) => posted.content === approvalPrompt(permission))).toHaveLength(1);
  });

  describe("turn outcome", () => {
    // OpenCode's loop on a reject: a bare reject ends it, one with feedback hands the decision back to the model.
    const answersOnFeedback = (permission: string) => async (turn: OpencodeTurn) => {
      const reply = await turn.askPermission({ id: permission }).reply;
      if (typeof reply.message === "string") {
        turn.answer(DECLINED_ANSWER);
      } else {
        turn.idle();
      }
    };

    it.each([
      { decision: "the room's reject", approvalMode: "manual" },
      { decision: "auto_decline", approvalMode: "auto_decline" },
    ] as const)("hands $decision back to the model, whose answer completes the turn", async ({ approvalMode }) => {
      await using session = await opencodeRoom({ approvalMode });
      const { room, server } = session;
      const permission = "per_declined";
      const message = await session.start(answersOnFeedback(permission));
      if (approvalMode === "manual") {
        await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
        await room.exchange(OWNER, `reject ${permission}`);
      }

      await room.until(() => room.messages.some((posted) => posted.content === DECLINED_ANSWER));

      expect(await room.outcome(message)).toBe("processed");
      expect(server.permissionFeedback()).toEqual([[permission, REJECTED_PERMISSION_FEEDBACK]]);
      expect(room.failures).toEqual([]);
    });

    // OpenCode ends the turn on a question reject, which carries no feedback; a decline is an answer instead.
    const answersWhenHandedBack = (question: string) => async (turn: OpencodeTurn) => {
      const reply = await turn.askQuestion([{ question: "Proceed?" }], question).reply;
      if (reply === "rejected") {
        turn.idle();
      } else {
        turn.answer(DECLINED_ANSWER);
      }
    };

    it.each([
      { decision: "the room's reject", questionMode: "manual" },
      { decision: "auto_reject", questionMode: "auto_reject" },
    ] as const)("hands a question $decision declines back to the model, whose answer completes the turn", async ({ questionMode }) => {
      await using session = await opencodeRoom({ questionMode });
      const { room, server } = session;
      const question = "que_declined";
      const message = await session.start(answersWhenHandedBack(question));
      if (questionMode === "manual") {
        await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));
        await room.exchange(OWNER, `reject ${question}`);
      }

      await room.until(() => room.messages.some((posted) => posted.content === DECLINED_ANSWER));

      expect(await room.outcome(message)).toBe("processed");
      expect(server.questionReplies()).toEqual([[question, DECLINED]]);
      expect(room.failures).toEqual([]);
    });

    it.each(contractRows<{ posted: string[]; failures: ReportedFailure[]; outcome: Outcome }>({
      decline: { posted: [], failures: [], outcome: "processed" },
      toolReply: { posted: [TOOL_REPLY], failures: [], outcome: "processed" },
      act: { posted: [], failures: [], outcome: "processed" },
      finalText: { posted: [CLOSING_TEXT], failures: [], outcome: "processed" },
      // No filler stands in for the missing answer.
      nothing: { posted: [], failures: [MISSING_REPLY], outcome: "failed" },
    }))("settles a `$script` turn as $outcome, relaying OpenCode's text only when no Band tool answered", async ({ script, posted, failures, outcome }) => {
      await using session = await opencodeRoom();
      const { room } = session;
      const message = await session.start(TURN_SCRIPTS[script]);

      expect(await room.outcome(message)).toBe(outcome);
      expect(room.messages.map((entry) => entry.content)).toEqual(posted);
      expect(room.failures).toEqual(failures);
    });

    it.each([
      { effect: "act" as const, outcome: "processed", failures: [] },
      { effect: undefined, outcome: "failed", failures: [MISSING_REPLY] },
    ])("settles a turn whose only call is a custom tool declaring $effect as $outcome", async ({ effect, outcome, failures }) => {
      const fileTicket = { name: "file_ticket", schema: z.object({ title: z.string() }), handler: () => ({ id: "T-1" }), effect };
      await using session = await opencodeRoom({}, { customTools: [fileTicket] });
      const { room } = session;
      const message = await session.start(async (turn) => {
        await turn.callTool("file_ticket", { ...ROOM, title: "Broken build" });
        turn.idle();
      });

      expect(await room.outcome(message)).toBe(outcome);
      expect(room.failures).toEqual(failures);
    });

    it("refuses a custom tool call naming no known room, without running it", async () => {
      const handler = vi.fn(() => ({ id: "T-1" }));
      await using session = await opencodeRoom({}, { customTools: [{ name: "file_ticket", schema: z.object({}), handler, effect: "act" }] });
      const results = createDeferred<Array<{ isError?: boolean; text: string }>>();
      await session.start(async (turn) => {
        results.resolve([await turn.callTool("file_ticket", {}), await turn.callTool("file_ticket", { room_id: "room-9" })]);
        turn.answer(CLOSING_TEXT);
      });

      expect(await results.promise).toMatchObject([
        { isError: true, text: expect.stringContaining("room_id") },
        { isError: true, text: expect.stringContaining("room-9") },
      ]);
      expect(handler).not.toHaveBeenCalled();
    });

    // A bootstrap message runs beside the room's sync loop, so two first messages can overlap.
    it("holds the room through a turn's setup, so an overlapping first message waits as busy", async () => {
      await using session = await opencodeRoom();
      const { adapter, server } = session;
      const [first, second] = [new FakeTools(), new FakeTools()];
      const sessionCreated = server.hold("POST /session");
      server.onPrompt((turn) => turn.answer(CLOSING_TEXT));

      const firstTurn = adapter.onEvent(turnInput(first, makeMessage("First", "room-race")));
      await sessionCreated.sending;
      await adapter.onEvent(turnInput(second, makeMessage("Second", "room-race")));
      sessionCreated.release();
      await firstTurn;

      expect(second.events.map((event) => event.content)).toEqual([SAYS.turnInProgress()]);
      expect(first.messages).toEqual([CLOSING_TEXT]);
    });

    it("rejects a custom tool that declares room_id, which OpenCode passes the room through", () => {
      const takesRoom = { name: "move_to_room", schema: z.object({ room_id: z.string() }), handler: () => "moved" };

      expect(() => new OpencodeAdapter({ customTools: [takesRoom] })).toThrow(CustomToolDefinitionError);
    });

    it("reports a silent turn when its text is not relayed", async () => {
      await using session = await opencodeRoom({ fallbackSendAgentText: false });
      const { room } = session;
      const message = await session.start((turn) => turn.answer("Plain text nobody sees."));

      expect(await room.outcome(message)).toBe("failed");
      expect(room.messages).toEqual([]);
      expect(room.failures).toEqual([MISSING_REPLY]);
    });

    it.each([
      { decision: "the room's reject", expires: false },
      { decision: "expiry", expires: true },
    ])("reports a turn whose model goes silent after $decision declines its question, once", async ({ expires }) => {
      if (expires) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      await using session = await opencodeRoom({ questionWaitTimeoutMs: SHORT_DEADLINE_MS });
      const { room, server } = session;
      const question = "que_silent";
      const ended = createDeferred<void>();
      const message = await session.start(async (turn) => {
        await turn.askQuestion([{ question: "Proceed?" }], question).reply;
        turn.idle();
        ended.resolve();
      });
      await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));
      if (expires) {
        await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
      } else {
        await room.exchange(OWNER, `reject ${question}`);
      }
      await ended.promise;
      await room.until(() => room.failures.length > 0);

      expect(server.questionReplies()).toEqual([[question, DECLINED]]);
      expect(room.failures).toEqual([MISSING_REPLY]);
      expect(room.outcomes(message), "the request was already handed back").toEqual(["processed"]);
    });

    it.each([
      { ending: "answers after the decision", finish: TURN_SCRIPTS.finalText, posted: [CLOSING_TEXT], failures: [] },
      { ending: "ends with nothing", finish: TURN_SCRIPTS.nothing, posted: [], failures: [MISSING_REPLY] },
    ])("judges a turn handed back to the room for an approval when it really ends: one that $ending", async ({ finish, posted, failures }) => {
      await using session = await opencodeRoom();
      const { room } = session;
      const permission = "per_detached";
      const ended = createDeferred<void>();
      const message = await session.start(async (turn) => {
        await turn.askPermission({ id: permission }).reply;
        await finish(turn);
        ended.resolve();
      });
      expect(await room.outcome(message)).toBe("processed");

      expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
      await ended.promise;
      await session.afterTurn();

      // The approval prompt was only a notice, so the answer after it is still relayed.
      expect(room.messages.map((entry) => entry.content)).toEqual([approvalPrompt(permission), SAYS.approvalHandled(permission, "once"), ...posted, DONE]);
      expect(room.failures).toEqual(failures);
      expect(room.outcomes(message), "the request was already handed back").toEqual(["processed"]);
    });

    it("passes a control past a held message during a handed-back turn, and keeps that turn's own reply on it", async () => {
      await using session = await opencodeRoom();
      const { room, server } = session;
      const permission = "per_busy_reply";
      const ended = createDeferred<void>();
      const message = await session.start(async (turn) => {
        await turn.askPermission({ id: permission }).reply;
        await TURN_SCRIPTS.toolReply(turn);
        ended.resolve();
      });
      await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
      server.onPrompt((turn) => turn.answer(DONE));

      const hurry = await room.say(OWNER, "Is it done yet?");
      expect(await room.outcome(await room.say(OWNER, `approve ${permission}`))).toBe("processed");
      await ended.promise;
      expect(await room.outcome(hurry)).toBe("processed");
      expect(room.messages.at(-1)?.content).toBe(DONE);

      // OpenCode's tool reply counted on its own turn: the closing text is not relayed, and nothing is reported.
      expect(room.messages.map((entry) => entry.content)).not.toContain(CLOSING_TEXT);
      expect(room.failures).toEqual([]);
      expect(room.outcomes(message)).toEqual(["processed"]);
    });
  });
});

/** Waits on OWNER's approval of `permission`, then answers "Done.". */
const approvedThenDone = (permission: string) => async (turn: OpencodeTurn) => {
  await turn.askPermission({ id: permission }).reply;
  turn.answer(DONE);
};

describe("OpenCode holds the room's other work until a handed-back turn ends", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a follow-up sent after the closing reply but before OpenCode goes idle, as its own turn", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_closing";
    const idle = createDeferred();
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      await turn.callTool(SEND_MESSAGE_TOOL_NAME, { ...ROOM, content: TOOL_REPLY, mentions: ["@owner"] });
      await idle.promise;
      turn.idle();
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    await room.nextMessage((posted) => posted.content === TOOL_REPLY);
    server.onPrompt((turn) => turn.answer("Marker 42."));

    const followUp = await room.say(OWNER, "Which marker?");
    idle.resolve();

    expect(await room.outcome(followUp)).toBe("processed");
    expect(room.messages.at(-1)?.content).toBe("Marker 42.");
    expect(JSON.stringify(server.requestsTo("POST", /\/prompt_async$/)[1]?.body)).toContain("Which marker?");
    expect(room.events("error")).toEqual([]);
  });

  it("runs the messages that waited, in arrival order and each as its own turn, after the decision it waited on", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const permission = "per_order";
    const asked = await session.start(approvedThenDone(permission));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    server.onPrompt((turn) => turn.answer("First answer."));
    server.onPrompt((turn) => turn.answer("Second answer."));

    const first = await room.say(OWNER, "First question");
    const second = await room.say(OWNER, "Second question");
    const approval = await room.say(OWNER, `approve ${permission}`);
    expect(await room.outcome(second)).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual([
      approvalPrompt(permission), SAYS.approvalHandled(permission, "once"), DONE, "First answer.", "Second answer.",
    ]);
    const processed = platform.rest.settled.entries.filter((entry) => entry.outcome === "processed").map((entry) => entry.messageId);
    expect(processed).toEqual([asked, approval, first, second]);
    const prompts = server.requestsTo("POST", /\/prompt_async$/).map((request) => JSON.stringify(request.body));
    expect(prompts[1]).toContain("First question");
    expect(prompts[2]).toContain("Second question");
  });

  it("lets a waiting message run once the handed-back turn times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ turnTimeoutMs: TURN_TIMEOUT_MS, approvalWaitTimeoutMs: TURN_TIMEOUT_MS * 2 });
    const { room, server } = session;
    const stuck = await session.start((turn) => void turn.askPermission({ id: "per_stuck" }));
    expect(await room.outcome(stuck)).toBe("processed");
    server.onPrompt((turn) => turn.answer("Back to work."));

    const waiting = await room.say(OWNER, "Still there?");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);

    expect(await room.outcome(waiting)).toBe("processed");
    expect(room.messages.at(-1)?.content).toBe("Back to work.");
  });

  it("stops during a handed-back turn without marking the message that waited, so Band serves it again", async () => {
    await using session = await opencodeRoom();
    const { room, platform } = session;
    const [first, second] = ["per_stop_1", "per_stop_2"];
    await session.start(async (turn) => {
      await turn.askPermission({ id: first }).reply;
      await turn.askPermission({ id: second }).reply;
      turn.answer(DONE);
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(first));

    const waiting = await room.say(OWNER, "Is it done yet?");
    // A control queued behind the waiting message: once it settles, the room has seen both.
    expect(await room.exchange(OWNER, `approve ${first}`)).toEqual([SAYS.approvalHandled(first, "once")]);
    await room.nextMessage((posted) => posted.content === approvalPrompt(second));
    await platform[Symbol.asyncDispose]();

    expect(room.outcomes(waiting)).toEqual([]);
    expect((await platform.rest.getNextMessage({ chatId: room.id }))?.id).toBe(waiting);
  });

  it("applies an approval sent while the socket was down as soon as it reconnects, and still holds the waiting message", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const permission = "per_offline";
    await session.start(approvedThenDone(permission));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    server.onPrompt((turn) => turn.answer("It is done."));

    const waiting = await room.say(OWNER, "Is it done yet?");
    const approval = room.postBeforeConnect(OWNER, `approve ${permission}`);
    platform.transport.triggerRejoin(chatRoomTopic(room.id));

    expect(await room.outcome(approval)).toBe("processed");
    expect(await room.outcome(waiting)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual([
      approvalPrompt(permission), SAYS.approvalHandled(permission, "once"), DONE, "It is done.",
    ]);
    expect(server.permissionReplies()).toEqual([[permission, "once"]]);
    expect(server.requestsTo("POST", /\/prompt_async$/)).toHaveLength(2);
  });

  it("runs a bootstrap message aimed at a held room as the next turn, not beside the one handed back", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_bootstrap";
    await session.start(approvedThenDone(permission));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    server.onPrompt((turn) => turn.answer("Bootstrapped answer."));

    const bootstrapped = room.bootstrap(OWNER, "Picked up from Linear");
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    await bootstrapped.ran;

    expect(await room.outcome(bootstrapped.id)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual([
      approvalPrompt(permission), SAYS.approvalHandled(permission, "once"), DONE, "Bootstrapped answer.",
    ]);
    expect(room.events("error")).toEqual([]);
  });

  it("does not take free text sent before a question was asked as its answer", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const [permission, question] = ["per_before", "que_late"];
    const proceed = createDeferred();
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      await proceed.promise;
      await turn.askQuestion([{ question: "Which file?" }], question).reply;
      turn.answer(DONE);
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    server.onPrompt((turn) => turn.answer("Noted."));

    const early = await room.say(OWNER, "src/a.ts");
    // A control behind the free text: once it settles, the room has classified both.
    await room.outcome(await room.say(OWNER, `approve ${permission}`));
    proceed.resolve();
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Which file?" }], question));
    await room.outcome(await room.say(OWNER, "src/b.ts"));

    expect(await room.outcome(early)).toBe("processed");
    expect(server.questionReplies()).toEqual([[question, [["src/b.ts"]]]]);
    expect(room.messages.at(-1)?.content).toBe("Noted.");
    expect(JSON.stringify(server.requestsTo("POST", /\/prompt_async$/)[1]?.body)).toContain("src/a.ts");
  });

  it("holds the room for a turn that asks before OpenCode has accepted its prompt", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_early";
    const accepted = server.holdPromptAcceptance();
    await session.start(approvedThenDone(permission));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    server.onPrompt((turn) => turn.answer("It is done."));

    const waiting = await room.say(OWNER, "Is it done yet?");
    accepted.release();
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);

    expect(await room.outcome(waiting)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual([
      approvalPrompt(permission), SAYS.approvalHandled(permission, "once"), DONE, "It is done.",
    ]);
  });

  it("never treats the agent's own ask prompt, served again after a reconnect, as a decision", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const permission = "per_echo";
    await session.start(approvedThenDone(permission));
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));

    room.postBeforeConnect(AGENT_ID, `approve ${permission}`, { senderType: "Agent" });
    platform.transport.triggerRejoin(chatRoomTopic(room.id));
    expect(await room.exchange(OWNER, `reject ${permission}`)).toEqual([SAYS.approvalHandled(permission, "reject")]);
    await room.nextMessage((posted) => posted.content === DONE);

    expect(server.permissionReplies()).toEqual([[permission, "reject"]]);
  });

  it("keeps the room held when a waiting message's own turn is handed back, during the catch-up after a hold", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    await session.start(approvedThenDone("per_a"));
    await room.nextMessage((posted) => posted.content === approvalPrompt("per_a"));
    server.onPrompt(approvedThenDone("per_b1"));
    server.onPrompt((turn) => turn.answer("B2 answer."));

    const b1 = await room.say(OWNER, "B1 question");
    const b2 = await room.say(OWNER, "B2 question");
    const approval = room.postBeforeConnect(OWNER, "approve per_a");
    platform.transport.triggerRejoin(chatRoomTopic(room.id));
    expect(await room.outcome(approval)).toBe("processed");
    await room.nextMessage((posted) => posted.content === approvalPrompt("per_b1"));
    expect(await room.exchange(OWNER, "approve per_b1")).toEqual([SAYS.approvalHandled("per_b1", "once")]);

    expect(await room.outcome(b2)).toBe("processed");
    expect(room.outcomes(b1)).toEqual(["processed"]);
    expect(room.messages.at(-1)?.content).toBe("B2 answer.");
    expect(room.events("error")).toEqual([]);
    expect(server.requestsTo("POST", /\/prompt_async$/)).toHaveLength(3);
  });

  it("holds the rest of a startup backlog behind a backlog turn that is handed back", async () => {
    await using server = await FakeOpencodeServer.start();
    const adapter = new OpencodeAdapter({ config: { baseUrl: server.url, approvalMode: "manual" } });
    server.onPrompt(approvedThenDone("per_x"));
    server.onPrompt((turn) => turn.answer("Y answer."));
    await using platform = await BandPlatform.start(adapter, PEOPLE);
    platform.rest.addRoom("room-1");
    platform.postBeforeConnect("room-1", OWNER, "X question");
    const y = platform.postBeforeConnect("room-1", OWNER, "Y question");
    const room = await platform.room("room-1");

    await room.nextMessage((posted) => posted.content === approvalPrompt("per_x"));
    expect(await room.exchange(OWNER, "approve per_x")).toEqual([SAYS.approvalHandled("per_x", "once")]);

    expect(await room.outcome(y)).toBe("processed");
    expect(room.messages.at(-1)?.content).toBe("Y answer.");
    expect(room.events("error")).toEqual([]);
  });

  it("does not let a reconnect's scan take free text that waited from before a question as its answer", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const [permission, question] = ["per_before", "que_late"];
    const proceed = createDeferred();
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      await proceed.promise;
      await turn.askQuestion([{ question: "Which file?" }], question).reply;
      turn.answer(DONE);
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    server.onPrompt((turn) => turn.answer("Noted."));
    const early = await room.say(OWNER, "src/a.ts");
    proceed.resolve();
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Which file?" }], question));

    platform.transport.triggerRejoin(chatRoomTopic(room.id));
    // Queued behind the reconnect, so the scan has finished once this is answered.
    expect(await room.outcome(await room.say(OWNER, "src/b.ts"))).toBe("processed");

    expect(server.questionReplies()).toEqual([[question, [["src/b.ts"]]]]);
    expect(await room.outcome(early)).toBe("processed");
    expect(room.messages.at(-1)?.content).toBe("Noted.");
  });
});

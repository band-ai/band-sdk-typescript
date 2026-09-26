/**
 * OpenCode in a Band room, end to end: people talk in the room through the
 * real platform runtime, and the adapter's real HTTP client talks to an
 * OpenCode server on a local port. Each flow asserts what the room saw, what
 * OpenCode was sent, and how the platform settled each message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpencodeAdapter, type OpencodeAdapterConfig } from "../../src/adapters/opencode";
import { OPENCODE_DECISION_MESSAGES as SAYS, formatQuestionPrompt } from "../../src/adapters/opencode/messages";
import { createDeferred } from "../../src/core/deferred";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import type { CustomToolDef } from "../../src/runtime/tools/customTools";
import { BandPlatform, person, type RecordingRestApi } from "./support/bandPlatform";
import { FakeOpencodeServer, type OpencodeTurn } from "./support/fakeOpencodeServer";

const OWNER = "owner";
const APPROVER = "approver";
const INTRUDER = "intruder";
const PEOPLE = [OWNER, APPROVER, INTRUDER].map(person);

const DEADLINE_MS = 60_000;
const SHORT_DEADLINE_MS = 30_000;

const approvalPrompt = (requestId: string) => SAYS.approvalRequested({ requestId, permission: "bash", patterns: ["npm test"] });

interface RoomOptions {
  decisionAuthorizedSenders?: readonly string[];
  customTools?: CustomToolDef[];
  rest?: RecordingRestApi;
  server?: FakeOpencodeServer;
}

/** An OpenCode agent on the platform, in room-1, backed by its own local OpenCode server. */
async function opencodeRoom(config: OpencodeAdapterConfig = {}, options: RoomOptions = {}) {
  const server = options.server ?? await FakeOpencodeServer.start();
  const adapter = new OpencodeAdapter({
    config: { baseUrl: server.url, approvalMode: "manual", ...config },
    decisionAuthorizedSenders: options.decisionAuthorizedSenders,
    customTools: options.customTools,
  });
  const joined = await BandPlatform.join(adapter, PEOPLE, { rest: options.rest });
  const { platform, room } = joined;
  return {
    server,
    platform,
    room,
    /** OWNER asks for something; OpenCode runs `script` on the prompt. */
    async start(script: (turn: OpencodeTurn) => Promise<void> | void, content = "Please run the tests") {
      server.onPrompt(script);
      return room.say(OWNER, content);
    },
    async [Symbol.asyncDispose]() {
      await joined[Symbol.asyncDispose]();
      if (!options.server) {
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

describe("OpenCode in a Band room", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    const [registration] = server.requestsTo("POST", /^\/mcp$/);
    expect(registration!.body).toMatchObject({ name: "band", config: { type: "remote", headers: { Authorization: expect.stringMatching(/^Bearer /) } } });
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
    // With `second` answered, a bare command means the one ask of its kind still open.
    expect(await room.exchange(OWNER, "always")).toEqual([SAYS.approvalHandled(first, "always")]);
    expect(await room.exchange(OWNER, "reject")).toEqual([SAYS.questionRejected(question)]);

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([[second, "once"], [first, "always"]]);
    expect(server.questionReplies()).toEqual([[question, "rejected"]]);
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
    expect(await room.exchange(OWNER, "approve the blue one")).toEqual([SAYS.questionAnswered(single)]);

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
    expect(server.questionReplies()).toEqual([[question, "rejected"]]);
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
    expect(await room.exchange(OWNER, "yes")).toEqual([SAYS.questionAnswered("que_ask")]);

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([["per_auto", "once"]]);
    expect(new Map(server.questionReplies())).toEqual(new Map<string, unknown>([["que_empty", "rejected"], ["que_ask", [["yes"]]]]));
    expect(room.messages).not.toContainEqual(expect.objectContaining({ content: approvalPrompt("per_auto") }));
  });

  it("declines approvals and rejects questions without asking the room under auto_decline and auto_reject", async () => {
    await using session = await opencodeRoom({ approvalMode: "auto_decline", questionMode: "auto_reject" });
    const { room, server } = session;
    await session.start(async (turn) => {
      const asks = [turn.askPermission({ id: "per_auto" }), turn.askQuestion([], "que_empty"), turn.askQuestion([{ question: "Proceed?" }], "que_ask")];
      await Promise.all(asks.map((ask) => ask.reply));
      turn.answer("Done.");
    });

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.permissionReplies()).toEqual([["per_auto", "reject"]]);
    expect(new Map(server.questionReplies())).toEqual(new Map<string, unknown>([["que_empty", "rejected"], ["que_ask", "rejected"]]));
    expect(room.messages.map((posted) => posted.content)).toEqual(["Done."]);
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
    expect(await room.exchange(OWNER, `approve ${landed}`)).toEqual([SAYS.approvalHandled(landed, "once")]);

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
    const TURN_TIMEOUT_MS = 120_000;
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

  it("serves two rooms from one OpenCode server, and deregisters its tools only when the last room goes", async () => {
    await using session = await opencodeRoom();
    const { room, server, platform } = session;
    const other = await platform.room("room-2");
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
    expect(server.requestsTo("POST", /\/mcp\/band\/disconnect$/)).toEqual([]);

    await other.remove();
    await server.until(() => server.requestsTo("POST", /\/mcp\/band\/disconnect$/).length === 1);
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
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

  it("tells a requester OpenCode is still busy while it waits on an approval", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const permission = "per_busy";
    await session.start(async (turn) => {
      await turn.askPermission({ id: permission }).reply;
      turn.answer("Done.");
    });
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));

    const hurry = await room.say(OWNER, "Is it done yet?");
    expect(await room.outcome(hurry)).toBe("processed");
    expect(room.events("error").map((event) => event.content)).toEqual([SAYS.turnInProgress()]);
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.requestsTo("POST", /\/prompt_async$/)).toHaveLength(1);
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
    const expiryReplies = [server.hold("POST /permission/per_:id/reply"), server.hold("POST /question/que_:id/reject")];

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await Promise.all(expiryReplies.map((reply) => reply.sending));
    // The expiries own both asks now: the room's replies neither answer them nor say they did.
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([]);
    expect(await room.exchange(OWNER, `reject ${question}`)).toEqual([]);
    expect(await room.exchange(OWNER, "yes please")).toEqual([]);
    // OpenCode redelivers the ask being expired; the marker behind it shows it was handled, and not prompted again.
    const turn = await server.turn();
    turn.askPermission({ id: permission });
    turn.askPermission({ id: "per_marker" });
    await room.nextMessage((posted) => posted.content === approvalPrompt("per_marker"));
    expiryReplies.forEach((reply) => reply.release());
    await room.until(() => room.events("error").length === 2);

    expect(server.permissionReplies()).toEqual([[permission, "reject"]]);
    expect(server.questionReplies()).toEqual([[question, "rejected"]]);
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
    await server.until(() => server.requestsTo("POST", /\/mcp\/band\/disconnect$/).length === 1);

    expect(server.permissionReplies()).toEqual([]);
    expect(room.messages.filter((posted) => posted.content === approvalPrompt(permission))).toHaveLength(1);
  });
});

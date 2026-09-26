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
import { BandPlatform, person, type RecordingRestApi } from "./support/bandPlatform";
import { FakeOpencodeServer, type OpencodeTurn } from "./support/fakeOpencodeServer";

const OWNER = "owner";
const APPROVER = "approver";
const INTRUDER = "intruder";
const PEOPLE = [OWNER, APPROVER, INTRUDER].map(person);

const DEADLINE_MS = 60_000;
const SHORT_DEADLINE_MS = 30_000;

const approvalPrompt = (requestId: string) => SAYS.approvalRequested({ requestId, permission: "bash", patterns: ["npm test"] });
const permissionReplies = (server: FakeOpencodeServer) =>
  server.requestsTo("POST", /^\/permission\//).map((request) => [request.path.split("/")[2], request.body.reply]);
const questionReplies = (server: FakeOpencodeServer) =>
  server.requestsTo("POST", /^\/question\/.*\/(reply|reject)$/).map((request) => [request.path.split("/")[2], request.body.answers ?? "rejected"]);

interface RoomOptions {
  decisionAuthorizedSenders?: readonly string[];
  customTools?: ConstructorParameters<typeof OpencodeAdapter>[0] extends infer O ? O extends { customTools?: infer C } ? C : never : never;
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
  const platform = await BandPlatform.start(adapter, PEOPLE, options.rest);
  const room = await platform.room("room-1");
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
      await platform[Symbol.asyncDispose]();
      if (!options.server) {
        await server[Symbol.asyncDispose]();
      }
    },
  };
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
    const [registration] = server.requestsTo("POST", /^\/mcp$/);
    expect(registration!.body).toMatchObject({ name: "band", config: { type: "remote", headers: { Authorization: expect.stringMatching(/^Bearer /) } } });
  });

  it("routes a busy room's replies to the asks still awaiting one, and only from allowed senders", async () => {
    await using session = await opencodeRoom({}, { decisionAuthorizedSenders: [OWNER, APPROVER] });
    const { room, server } = session;
    const asked = createDeferred<{ first: string; second: string; question: string }>();
    await session.start(async (turn) => {
      const first = turn.askPermission();
      const second = turn.askPermission();
      const question = turn.askQuestion([{ question: "Which branch?" }]);
      asked.resolve({ first: first.id, second: second.id, question: question.id });
      await Promise.all([first.reply, second.reply, question.reply]);
      turn.reply("Done.");
      turn.idle();
    });
    const { first, second, question } = await asked.promise;
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Which branch?" }], question));

    expect(await room.exchange(OWNER, "approve")).toEqual([SAYS.whichPermissionHint([first, second])]);
    expect(await room.exchange(OWNER, "reject")).toEqual([SAYS.dualRejectHint([first, second], [question])]);
    expect(await room.exchange(INTRUDER, `approve ${second}`)).toEqual([SAYS.notAuthorized()]);
    expect(await room.exchange(APPROVER, `@[[agent-1]] approve ${second}`)).toEqual([SAYS.approvalHandled(second, "once")]);
    // With `second` answered, a bare command means the one ask of its kind still open.
    expect(await room.exchange(OWNER, "always")).toEqual([SAYS.approvalHandled(first, "always")]);
    expect(await room.exchange(OWNER, "reject")).toEqual([SAYS.questionRejected(question)]);

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(permissionReplies(server)).toEqual([[second, "once"], [first, "always"]]);
    expect(questionReplies(server)).toEqual([[question, "rejected"]]);
    expect(await room.exchange(OWNER, `approve ${first}`)).toEqual([SAYS.noLongerPending("permission", first)]);
  });

  it("answers questions line by line, oldest first, and hints when an answer is short or aimed wrong", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const asked = createDeferred<string[]>();
    const twoPart = [{ question: "Name?" }, { question: "Role?" }];
    await session.start(async (turn) => {
      const pair = turn.askQuestion(twoPart);
      const single = turn.askQuestion([{ question: "Colour?" }]);
      asked.resolve([pair.id, single.id]);
      await Promise.all([pair.reply, single.reply]);
      turn.reply("Thanks.");
      turn.idle();
    });
    const [pair, single] = await asked.promise;
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Colour?" }], single!));

    expect(await room.exchange(OWNER, "Alice")).toEqual([SAYS.waitingForAnswers()]);
    expect(await room.exchange(OWNER, `approve ${pair}`)).toEqual([SAYS.questionHint([pair!, single!])]);
    expect(await room.exchange(OWNER, "reject que_wrong")).toEqual([SAYS.noLongerPending("question", "que_wrong")]);
    expect(await room.exchange(OWNER, "Alice\nEngineer")).toEqual([SAYS.questionAnswered(pair!)]);
    expect(await room.exchange(OWNER, "approve the blue one")).toEqual([SAYS.questionAnswered(single!)]);

    await room.nextMessage((posted) => posted.content === "Thanks.");
    expect(questionReplies(server)).toEqual([[pair, [["Alice"], ["Engineer"]]], [single, [["approve the blue one"]]]]);
  });

  it.each([
    { timeoutReply: "reject", expected: "reject" },
    { timeoutReply: "once", expected: "once" },
    { timeoutReply: "always", expected: "always" },
  ] as const)("applies `$timeoutReply` to an approval nobody answers, and restarts the clock on redelivery", async ({ timeoutReply, expected }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalWaitTimeoutMs: DEADLINE_MS, approvalTimeoutReply: timeoutReply, questionWaitTimeoutMs: SHORT_DEADLINE_MS });
    const { room, server } = session;
    const asked = createDeferred<{ permission: string; question: string; redeliver: () => void }>();
    await session.start(async (turn) => {
      const permission = turn.askPermission();
      const question = turn.askQuestion([{ question: "Proceed?" }]);
      asked.resolve({ permission: permission.id, question: question.id, redeliver: () => void turn.askPermission({ id: permission.id }) });
      await Promise.all([permission.reply, question.reply]);
      turn.idle();
    });
    const { permission, question, redeliver } = await asked.promise;
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));

    await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
    await server.until(() => questionReplies(server).length === 1);
    redeliver();
    await room.until(() => room.messages.filter((posted) => posted.content === approvalPrompt(permission)).length === 2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(permissionReplies(server)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await server.until(() => permissionReplies(server).length === 1);

    expect(permissionReplies(server)).toEqual([[permission, expected]]);
    expect(questionReplies(server)).toEqual([[question, "rejected"]]);
    await room.until(() => room.events("error").length === 2);
    expect(room.events("error").map((event) => event.content)).toEqual([
      SAYS.questionTimedOut(question),
      SAYS.approvalTimedOut(permission, expected),
    ]);
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.noLongerPending("permission", permission)]);
  });

  it.each([
    { approvalMode: "auto_accept", questionMode: "manual", permission: "once", question: "prompted" },
    { approvalMode: "auto_decline", questionMode: "auto_reject", permission: "reject", question: "rejected" },
  ] as const)("handles asks by policy: approvals $approvalMode, questions $questionMode", async ({ approvalMode, questionMode, permission, question }) => {
    await using session = await opencodeRoom({ approvalMode, questionMode });
    const { room, server } = session;
    const asked = createDeferred<string>();
    await session.start(async (turn) => {
      const approval = turn.askPermission();
      const empty = turn.askQuestion([]);
      const ask = turn.askQuestion([{ question: "Proceed?" }]);
      asked.resolve(ask.id);
      await Promise.all([approval.reply, empty.reply]);
      if (question === "prompted") {
        await ask.reply;
      }
      turn.reply("Done.");
      turn.idle();
    });
    const askId = await asked.promise;
    if (question === "prompted") {
      await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], askId));
      expect(await room.exchange(OWNER, "yes")).toEqual([SAYS.questionAnswered(askId)]);
    }

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(permissionReplies(server).map(([, reply]) => reply)).toEqual([permission]);
    // A question with nothing to answer is rejected rather than left blocking OpenCode.
    expect(questionReplies(server)).toContainEqual([expect.any(String), "rejected"]);
    expect(room.messages.filter((posted) => posted.content.startsWith("OpenCode approval requested"))).toEqual([]);
  });

  it("fails the turn when OpenCode refuses a room's reply, drops the sibling asks, and serves the next request on the same session", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const asked = createDeferred<string[]>();
    const first = await session.start(async (turn) => {
      const refused = turn.askPermission();
      const sibling = turn.askPermission();
      asked.resolve([refused.id, sibling.id]);
    });
    const [refused, sibling] = await asked.promise;
    await room.nextMessage((posted) => posted.content === approvalPrompt(sibling!));
    server.failNext("POST /permission/per_:id/reply", { status: 503, body: { name: "UnavailableError", data: { message: "busy" } } });

    const reply = await room.say(OWNER, `approve ${refused}`);
    expect(await room.outcome(reply)).toBe("failed");
    expect(await room.outcome(first)).toBe("processed");
    const [failure] = room.events(FAILURE_EVENT_TYPE);
    expect(failure?.metadata?.failure).toMatchObject({ code: "503" });
    expect(await room.exchange(OWNER, `approve ${sibling}`)).toEqual([SAYS.noLongerPending("permission", sibling!)]);
    await server.until(() => server.requestsTo("POST", /\/abort$/).length === 1);

    const next = await session.start((turn) => {
      turn.reply("Second answer.");
      turn.idle();
    }, "Try again");
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
    const asked = createDeferred<string>();
    const lands = createDeferred();
    await session.start(async (turn) => {
      const landed = turn.askPermission();
      asked.resolve(landed.id);
      await lands.promise;
      const claimed = turn.askPermission({ id: "per_claimed" });
      await Promise.all([landed.reply, claimed.reply]);
      turn.reply("Done.");
      turn.idle();
    });
    const landed = await asked.promise;
    await room.nextMessage((posted) => posted.content === approvalPrompt(landed));
    const failedPrompt = room.holdMessage((content) => content === approvalPrompt("per_claimed"), { error: new Error("platform timed out") });
    lands.resolve();
    await failedPrompt.sending;

    expect(await room.exchange(OWNER, "approve per_claimed")).toEqual([SAYS.approvalHandled("per_claimed", "once")]);
    failedPrompt.release();
    expect(await room.exchange(OWNER, `approve ${landed}`)).toEqual([SAYS.approvalHandled(landed, "once")]);

    await room.nextMessage((posted) => posted.content === "Done.");
    expect(permissionReplies(server)).toEqual([["per_claimed", "once"], [landed, "once"]]);
    expect(room.events(FAILURE_EVENT_TYPE)).toEqual([]);
  });

  it("resumes the room's OpenCode session after the agent restarts, and starts over when OpenCode lost it", async () => {
    await using server = await FakeOpencodeServer.start();
    const answer = (text: string) => (turn: OpencodeTurn) => {
      turn.reply(text);
      turn.idle();
    };
    let rest: RecordingRestApi;
    {
      await using first = await opencodeRoom({}, { server });
      rest = first.platform.rest;
      await first.start(answer("First answer."), "Remember the number 7");
      await first.room.nextMessage((posted) => posted.content === "First answer.");
    }
    const [created] = server.requestsTo("POST", /^\/session$/);

    {
      await using restarted = await opencodeRoom({}, { server, rest });
      await restarted.start(answer("Second answer."), "What was the number?");
      await restarted.room.nextMessage((posted) => posted.content === "Second answer.");
      expect(restarted.room.events("task").at(-1)?.content).toMatch(/resumed/i);
    }
    server.forgetSessions();
    {
      await using restarted = await opencodeRoom({}, { server, rest });
      await restarted.start(answer("Third answer."), "And now?");
      await restarted.room.nextMessage((posted) => posted.content === "Third answer.");
    }

    const prompts = server.requestsTo("POST", /\/prompt_async$/);
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
    expect(prompts[1]!.path).toBe(prompts[0]!.path);
    expect(prompts[2]!.path).not.toBe(prompts[0]!.path);
    expect(prompts[2]!.body.parts).toEqual([{ type: "text", text: expect.stringMatching(/Recovered room history[\s\S]*Remember the number 7[\s\S]*\[owner\]: And now\?/) }]);
    expect(created).toBeDefined();
  });

  it.each([
    { failure: "a plain-text 500", response: { status: 500, body: "database locked" }, detail: "database locked" },
    { failure: "a structured 500", response: { status: 500, body: { name: "StorageError", data: { message: "disk full" } } }, detail: "disk full" },
  ])("fails the turn when restoring the session hits $failure", async ({ response, detail }) => {
    await using server = await FakeOpencodeServer.start();
    let rest: RecordingRestApi;
    {
      await using first = await opencodeRoom({}, { server });
      rest = first.platform.rest;
      await first.start((turn) => {
        turn.reply("First answer.");
        turn.idle();
      });
      await first.room.nextMessage((posted) => posted.content === "First answer.");
    }
    await using restarted = await opencodeRoom({}, { server, rest });
    server.failNext("GET /session/ses_:id", response);

    const message = await restarted.room.say(OWNER, "Continue");
    expect(await restarted.room.outcome(message)).toBe("failed");
    expect(JSON.stringify(restarted.room.events(FAILURE_EVENT_TYPE)[0]?.metadata)).toContain(detail);
  });

  it.each([
    { payload: "a nested message", error: { name: "ProviderAuthError", data: { message: "invalid key" } }, shows: "invalid key" },
    { payload: "only a name", error: { name: "UnknownError" }, shows: "UnknownError" },
    { payload: "a bare string", error: "boom", shows: "OpenCode" },
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
      turn.reply("Fresh answer.");
      turn.idle();
    }, "Try again");
    await room.nextMessage((posted) => posted.content === "Fresh answer.");
    expect(await room.outcome(next)).toBe("processed");
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
    expect(room.messages.some((posted) => posted.content.includes("per_stale"))).toBe(false);
  });

  it("keeps serving a turn when OpenCode's event stream drops and reconnects", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const asked = createDeferred<string>();
    await session.start(async (turn) => {
      const permission = turn.askPermission();
      asked.resolve(permission.id);
      await permission.reply;
      turn.reply("Survived the reconnect.");
      turn.idle();
    });
    const permission = await asked.promise;
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
    const answer = (text: string) => (turn: OpencodeTurn) => {
      turn.reply(text);
      turn.idle();
    };
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
    const late = createDeferred<OpencodeTurn>();
    const message = await session.start((turn) => {
      turn.reply("Done.");
      turn.idle();
      late.resolve(turn);
    });
    await room.nextMessage((posted) => posted.content === "Done.");
    expect(await room.outcome(message)).toBe("processed");

    const { id, reply } = (await late.promise).askPermission();
    expect(await room.nextMessage((posted) => posted.content === approvalPrompt(id))).toMatchObject({ mentions: [OWNER] });
    expect(await room.exchange(OWNER, `approve ${id}`)).toEqual([SAYS.approvalHandled(id, "once")]);
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
      turn.reply("Plain text nobody sees.");
      turn.idle();
    });

    const [sent, wrongRoom, lookup, flaky] = await calls.promise;
    expect(sent?.isError).toBeUndefined();
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages).toEqual([expect.objectContaining({ content: "Looking into it", mentions: [OWNER] })]);
    expect(wrongRoom).toMatchObject({ isError: true, text: expect.stringContaining("room-9") });
    expect(JSON.parse(lookup!.text)).toEqual({ title: "Ticket T-7" });
    expect(flaky).toMatchObject({ isError: true, text: expect.stringContaining("upstream down") });
    // Every OpenCode call is scoped to the configured project.
    expect(server.requests.filter((request) => request.path !== "/mcp/band" || request.method !== "DELETE").every((request) => request.query.directory === "/work/repo" && request.query.workspace === "ws-1")).toBe(true);
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
    const asked = createDeferred<string>();
    await session.start(async (turn) => {
      const permission = turn.askPermission();
      asked.resolve(permission.id);
      await permission.reply;
      turn.reply("Done.");
      turn.idle();
    });
    const permission = await asked.promise;
    await room.nextMessage((posted) => posted.content === approvalPrompt(permission));

    const hurry = await room.say(OWNER, "Is it done yet?");
    expect(await room.outcome(hurry)).toBe("processed");
    expect(room.events("error").map((event) => event.content)).toEqual(["OpenCode is still processing the previous request in this room."]);
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([SAYS.approvalHandled(permission, "once")]);
    await room.nextMessage((posted) => posted.content === "Done.");
    expect(server.requestsTo("POST", /\/prompt_async$/)).toHaveLength(1);
  });

  it("lets expiries that are already replying own their asks against late room replies and a redelivery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using session = await opencodeRoom({ approvalWaitTimeoutMs: DEADLINE_MS, questionWaitTimeoutMs: DEADLINE_MS });
    const { room, server } = session;
    const asked = createDeferred<{ permission: string; question: string; redeliver: () => void; marker: () => string }>();
    await session.start(async (turn) => {
      const permission = turn.askPermission();
      const question = turn.askQuestion([{ question: "Proceed?" }]);
      asked.resolve({
        permission: permission.id,
        question: question.id,
        redeliver: () => void turn.askPermission({ id: permission.id }),
        marker: () => turn.askPermission().id,
      });
      await Promise.all([permission.reply, question.reply]);
      turn.idle();
    });
    const { permission, question, redeliver, marker } = await asked.promise;
    await room.nextMessage((posted) => posted.content === formatQuestionPrompt([{ question: "Proceed?" }], question));
    const expiryReplies = [server.hold("POST /permission/per_:id/reply"), server.hold("POST /question/que_:id/reject")];

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await Promise.all(expiryReplies.map((reply) => reply.sending));
    // The expiries own both asks now: the room's replies neither answer them nor say they did.
    expect(await room.exchange(OWNER, `approve ${permission}`)).toEqual([]);
    expect(await room.exchange(OWNER, `reject ${question}`)).toEqual([]);
    expect(await room.exchange(OWNER, "yes please")).toEqual([]);
    // OpenCode redelivers the ask being expired; the marker behind it shows it was handled, and not prompted again.
    redeliver();
    const markerId = marker();
    await room.nextMessage((posted) => posted.content === approvalPrompt(markerId));
    expiryReplies.forEach((reply) => reply.release());
    await room.until(() => room.events("error").length === 2);

    expect(permissionReplies(server)).toEqual([[permission, "reject"]]);
    expect(questionReplies(server)).toEqual([[question, "rejected"]]);
    expect(room.messages.filter((posted) => posted.content === approvalPrompt(permission))).toHaveLength(1);
  });

  it("rejects an approval on OpenCode when the room never got its prompt, fails the turn, and starts fresh next time", async () => {
    await using session = await opencodeRoom();
    const { room, server } = session;
    const refused = room.holdMessage((content) => content.startsWith("OpenCode approval requested"), { error: new Error("platform unavailable") });
    const message = await session.start((turn) => void turn.askPermission({ id: "per_unseen" }));
    await refused.sending;
    refused.release();

    expect(await room.outcome(message)).toBe("failed");
    await server.until(() => permissionReplies(server).length === 1);
    expect(permissionReplies(server)).toEqual([["per_unseen", "reject"]]);

    const next = await session.start((turn) => {
      turn.reply("Fresh start.");
      turn.idle();
    }, "Try again");
    await room.nextMessage((posted) => posted.content === "Fresh start.");
    expect(await room.outcome(next)).toBe("processed");
    expect(server.requestsTo("POST", /^\/session$/)).toHaveLength(2);
  });

  it("reports an automatic approval OpenCode refuses once, with no timeout notice", async () => {
    await using session = await opencodeRoom({ approvalMode: "auto_accept" });
    const { room, server } = session;
    server.failNext("POST /permission/per_:id/reply", { status: 503, body: { name: "UnavailableError", data: { message: "busy" } } });
    await session.start((turn) => void turn.askPermission());

    await room.until(() => room.events(FAILURE_EVENT_TYPE).length === 1);
    expect(room.events(FAILURE_EVENT_TYPE)[0]?.metadata?.failure).toMatchObject({ code: "503" });
    expect(room.events("error").map((event) => event.content)).toEqual([room.events(FAILURE_EVENT_TYPE)[0]?.content]);
    expect(server.eventStreamCount).toBe(1);
  });
});

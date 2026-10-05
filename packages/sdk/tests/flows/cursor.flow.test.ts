/**
 * Cursor in a Band room, end to end: people talk in the room through the real
 * platform runtime, and a Cursor agent peer talks back over a real ACP
 * connection. Each flow asserts what the room saw, what Cursor was told, and
 * how the platform settled each message.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorACPAdapter, type CursorACPAdapterOptions } from "../../src/adapters/cursor-acp";
import { createDeferred } from "../../src/core/deferred";
import { DEFAULT_CURSOR_DECISION_TIMEOUT_MS } from "../../src/adapters/cursor-acp/CursorRoomAgent";
import { CURSOR_COMMAND, CURSOR_DECISION_MESSAGES as SAYS } from "../../src/adapters/cursor-acp/messages";
import { allowBandMcpTools, BAND_MCP_PERMISSION, CURSOR_PROJECT_CONFIG } from "../../src/adapters/cursor-acp/permissions";
import { DEFAULT_WORKSPACE_DIRECTORY } from "../../src/adapters/shared/roomWorkspace";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../../src/contracts/toolSchemas";
import { ACP_SESSION_EVENT } from "../../src/converters/acp-client";
import { BandPlatform, person, type BandRoom, type Outcome, type Posted } from "./support/bandPlatform";
import { DEFAULT_CURSOR_ROOM, FakeCursorAgent, type CursorTurn } from "./support/fakeCursorAgent";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import { makeLoggerSpy, MISSING_REPLY, tmpRoot, type ReportedFailure } from "../testUtils";
import { ACT_TOOL, CLOSING_TEXT, contractRows, NO_REPLY_ARGS, TOOL_REPLY, type TurnScript } from "../turnOutcomeContract";

const OWNER = "owner";
const TEAMMATE = "teammate";
const INTRUDER = "intruder";

// Every decision prompt offers `/cursor <verb> <token> ...`; nothing else Cursor posts does.
const DECISION_TOKEN = new RegExp(`\\${CURSOR_COMMAND} \\w+ ([^\\s\`]+)`);
const tokenIn = (content: string) => content.match(DECISION_TOKEN)?.[1];
const tokenOf = (posted: Posted) => tokenIn(posted.content);
const isPrompt = (posted: Posted) => tokenOf(posted) !== undefined;
const isQuestionPrompt = (content: string) => content === SAYS.questionPrompt(tokenIn(content) ?? "");

const CANCELLED = { outcome: { outcome: "cancelled" } };
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });
const answered = (answers: Record<string, string[]>) => ({
  outcome: { outcome: "answered", answers: Object.entries(answers).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })) },
});

const WRITE_FILE = {
  toolCall: { toolCallId: "write-1", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const },
  ],
};

const FILES_AND_MODE = {
  questions: [
    { id: "files", prompt: "Which files?", allowMultiple: true, options: [{ id: "readme", label: "README" }, { id: "config", label: "Config" }] },
    { id: "mode", prompt: "Which mode?", options: [{ id: "plan", label: "Plan" }, { id: "edit", label: "Edit" }] },
  ],
};

// What a scripted turn says once its work is done: a turn that ends silent is reported, and these flows are about the work.
const DONE = "Done.";
function answering<R>(script: (turn: CursorTurn) => Promise<R>): (turn: CursorTurn) => Promise<R> {
  return async (turn) => {
    const result = await script(turn);
    await turn.say(DONE);
    return result;
  };
}

const MODE = { questions: [{ id: "mode", options: [{ id: "plan" }] }] };

// Each turn-outcome script as Cursor runs it. Its Band tools run on an MCP
// server of its own, so a tool reply posts nothing in the room through Band.
const TURN_SCRIPTS: Record<TurnScript, (turn: CursorTurn) => Promise<void>> = {
  decline: async (turn) => {
    await turn.callTool(NO_REPLY_TOOL_NAME, NO_REPLY_ARGS);
    await turn.say(CLOSING_TEXT);
  },
  toolReply: async (turn) => {
    await turn.callTool(SEND_MESSAGE_TOOL_NAME, { content: TOOL_REPLY, mentions: [OWNER] });
    await turn.say(CLOSING_TEXT);
  },
  act: (turn) => turn.callTool(ACT_TOOL, { name: TEAMMATE }),
  finalText: (turn) => turn.say(CLOSING_TEXT),
  nothing: async () => undefined,
};

/** One Cursor agent on the platform, in room-1, which OWNER, TEAMMATE and INTRUDER share. */
async function cursorRoom(options: Partial<CursorACPAdapterOptions> = {}) {
  const agent = new FakeCursorAgent();
  const adapter = new CursorACPAdapter({
    cwd: tmpRoot(),
    enableMcpTools: false,
    decisionAuthorizedSenders: [OWNER, TEAMMATE],
    connectionFactory: agent.connectionFactory,
    ...options,
  });
  const joined = await BandPlatform.join(adapter, [OWNER, TEAMMATE, INTRUDER].map(person));
  const { room } = joined;
  return {
    ...joined,
    agent,
    /** OWNER asks Cursor for something; Cursor runs `script`. Resolves once the room is asked `prompts` decisions. */
    async start<R>(script: (turn: CursorTurn) => Promise<R>, prompts = 0) {
      const result = agent.nextTurn(script);
      const message = await room.say(OWNER, "Please update the notes");
      return { result, message, tokens: await promptTokens(room, prompts) };
    },
    /**
     * Waits for the room's `turns`th turn to end, then runs an answered one.
     * A room's turns run one at a time, so everything the earlier turn posted
     * at its very end is in by the time this returns.
     */
    async afterTurn(turns = 1) {
      await room.until(() => room.events("task").filter((event) => event.content === ACP_SESSION_EVENT.content).length >= turns);
      const next = agent.nextTurn(answering(async () => undefined));
      expect(await room.outcome(await room.say(OWNER, "Anything else?"))).toBe("processed");
      await next;
    },
  };
}

/** Every decision token posted in `room`, once there are at least `count`. */
async function promptTokens(room: BandRoom, count: number): Promise<string[]> {
  await room.until(() => room.messages.filter(isPrompt).length >= count);
  return room.messages.filter(isPrompt).map((posted) => tokenOf(posted)!);
}

describe("Cursor in a Band room", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the room approve and deny tool permissions while the turn waits, however the owner phrases it", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    const { result, message, tokens: [write] } = await session.start(async (turn) => {
      const first = await turn.requestPermission(WRITE_FILE);
      const second = await turn.requestPermission({ ...WRITE_FILE, toolCall: { toolCallId: "rm-1", title: "Delete draft.md" } });
      await turn.say("Updated the notes.");
      return [first, second];
    }, 1);

    // The turn is waiting on the room, yet the room keeps serving: every reply is answered right away.
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${write} bogus`)).toEqual([SAYS.invalidCommand("permission", write!)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} approve ${write}`)).toEqual([SAYS.invalidCommand("permission", write!)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${write} allow reject`)).toEqual([SAYS.invalidCommand("permission", write!)]);
    expect(await room.exchange(INTRUDER, `${CURSOR_COMMAND} select ${write} allow`)).toEqual([SAYS.notAuthorized()]);
    expect(await room.exchange(OWNER, "Actually, also fix the typo")).toEqual([SAYS.turnInProgress()]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${write} allow`)).toContain(SAYS.resolved("permission", write!));

    const [, remove] = await promptTokens(room, 2);
    expect(await room.exchange(TEAMMATE, `${CURSOR_COMMAND} deny ${remove}`)).toContain(SAYS.resolved("permission", remove!));
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${remove} allow`)).toEqual([SAYS.notPending(remove!)]);

    expect(await result).toEqual([selected("allow"), CANCELLED]);
    // The room was handed back when the first decision opened; the reply still reaches the requester.
    expect(await room.outcome(message)).toBe("processed");
    expect(await room.nextMessage((posted) => posted.content === "Updated the notes.")).toMatchObject({ mentions: [OWNER] });
  });

  it("walks a question through every malformed answer before taking the valid one", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    // Cursor may leave the session out; the adapter routes it to the turn in flight.
    const { result, tokens: [token] } = await session.start((turn) => turn.ask({ sessionId: undefined, ...FILES_AND_MODE }), 1);
    const invalid = SAYS.invalidCommand("question", token!);

    for (const attempt of [
      "files",
      "=readme",
      "colour=red mode=plan",
      "files=readme files=config mode=plan",
      "files=readme mode=plan,edit",
      "files=readme mode=draft",
      "files=readme",
    ]) {
      expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} ${attempt}`), attempt).toEqual([invalid]);
    }
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${token} readme`)).toEqual([invalid]);
    expect(await room.exchange(OWNER, `@[[agent-1]] ${CURSOR_COMMAND} answer ${token} files=readme,config mode=edit`)).toEqual([SAYS.resolved("question", token!)]);

    expect(await result).toEqual(answered({ files: ["readme", "config"], mode: ["edit"] }));
  });

  it("asks the room to approve plans, and stops Cursor with a plan still open when the agent leaves the room", async () => {
    await using session = await cursorRoom({ planMode: "manual" });
    const { room, agent } = session;
    const openPlan = { title: "Refactor plan", overview: "Split the module" };
    const outcomes: unknown[] = [];
    const { tokens: [untitled] } = await session.start(async (turn) => {
      outcomes.push(await turn.plan({ overview: "No title" }));
      outcomes.push(await turn.plan(openPlan));
      outcomes.push(await turn.plan(openPlan));
    }, 1);

    expect(room.messages.find(isPrompt)?.content).toBe(SAYS.planPrompt("Cursor plan", untitled!));
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${untitled} x=y`)).toEqual([SAYS.invalidCommand("plan", untitled!)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} reject ${untitled}`)).toContain(SAYS.resolved("plan", untitled!));
    const [, titled] = await promptTokens(room, 2);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} accept ${titled}`)).toContain(SAYS.resolved("plan", titled!));
    await promptTokens(room, 3);

    await room.remove();

    // Leaving stops the room's Cursor process, open plan and all.
    await vi.waitFor(() => expect(agent.room("room-1").stopped).toBe(true));
    expect(outcomes).toEqual([{ outcome: { outcome: "rejected" } }, { outcome: { outcome: "accepted" } }]);
    expect(agent.receivedOf("session/prompt")).toHaveLength(1);
  });

  it("shares a busy room: lists mixed pending asks, evicts the oldest, and keeps each room's asks to itself", async () => {
    await using session = await cursorRoom({ maxPendingDecisions: 2, planMode: "manual" });
    const { room, platform, agent } = session;
    const otherRoom = await platform.room("room-2");
    await session.start(async (turn) => Promise.all([
      turn.requestPermission(WRITE_FILE),
      turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }),
      turn.plan({ title: "Plan" }),
    ]), 3);
    const [evicted, ...pending] = room.messages.filter(isPrompt);
    const kindOf = (posted: Posted) => {
      const token = tokenOf(posted)!;
      return posted.content === SAYS.permissionPrompt(token) ? "permission" : posted.content === SAYS.questionPrompt(token) ? "question" : "plan";
    };
    const listed = pending.map((posted) => `\`${tokenOf(posted)}\` (${kindOf(posted)})`);

    expect(await room.exchange(OWNER, CURSOR_COMMAND)).toEqual([SAYS.pendingList(listed)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} decisions`)).toEqual([SAYS.pendingList(listed)]);
    expect(await otherRoom.exchange(OWNER, CURSOR_COMMAND)).toEqual([SAYS.pendingList([])]);
    for (const posted of pending) {
      expect(await otherRoom.exchange(OWNER, `${CURSOR_COMMAND} deny ${tokenOf(posted)}`)).toEqual([SAYS.notPending(tokenOf(posted)!)]);
    }
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${tokenOf(evicted!)} allow`)).toEqual([SAYS.notPending(tokenOf(evicted!)!)]);

    await room.remove();
    await vi.waitFor(() => expect(agent.room("room-1").stopped).toBe(true));
  });

  it("times each ask out at its own deadline, tells the requester once, and survives a notice the platform refuses", async () => {
    vi.useFakeTimers();
    const PERMISSION_TIMEOUT_MS = 60_000;
    await using session = await cursorRoom({ permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    const { room } = session;
    const { result, tokens } = await session.start(async (turn) => Promise.all([
      turn.requestPermission(WRITE_FILE),
      turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }),
    ]), 2);
    const [permission, question] = tokens;
    const refusedNotice = room.holdMessage((content) => content === SAYS.timedOut("question", question!), { error: new Error("platform unavailable") });

    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    await room.until(() => room.messages.some((posted) => posted.content === SAYS.timedOut("permission", permission!)));
    await vi.advanceTimersByTimeAsync(DEFAULT_CURSOR_DECISION_TIMEOUT_MS - PERMISSION_TIMEOUT_MS);
    await refusedNotice.sending;
    refusedNotice.release();

    expect(await result).toEqual([CANCELLED, CANCELLED]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${question} mode=plan`)).toEqual([SAYS.notPending(question!)]);
    const timeoutNotices = [SAYS.timedOut("permission", permission!), SAYS.timedOut("question", question!)];
    expect(room.messages.filter((posted) => timeoutNotices.includes(posted.content))).toEqual([
      expect.objectContaining({ content: SAYS.timedOut("permission", permission!), mentions: [OWNER] }),
    ]);
  });

  it("lets a reply that claimed an ask outlive its failed prompt, and ends an unclaimed one at once", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    const ask = (id: string) => ({ questions: [{ id, options: [{ id: "yes" }] }] });
    const moreAsks = createDeferred();
    // The first prompt lands and hands the room back; the next two reach the room but the platform then reports them failed.
    const { result, tokens: [first] } = await session.start(async (turn) => {
      const answeredFirst = turn.ask(ask("first"));
      await moreAsks.promise;
      return Promise.all([answeredFirst, turn.ask(ask("claimed")), turn.ask(ask("unclaimed"))]);
    }, 1);
    const failedPrompts = [0, 1].map(() => room.holdMessage(isQuestionPrompt, { error: new Error("platform timed out") }));
    moreAsks.resolve();
    const [[, claimedPrompt]] = await Promise.all(failedPrompts.map((prompt) => prompt.sending));

    const claimed = claimedPrompt.match(DECISION_TOKEN)![1]!;
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${claimed} claimed=yes`)).toEqual([SAYS.resolved("question", claimed)]);
    failedPrompts.forEach((prompt) => prompt.release());
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${first} first=yes`)).toEqual([SAYS.resolved("question", first!)]);

    expect(await result).toEqual([answered({ first: ["yes"] }), answered({ claimed: ["yes"] }), CANCELLED]);
    expect(room.messages.filter(isPrompt)).toHaveLength(1);
  });

  it("keeps serving the room after the platform refuses a control reply, and answers the retried command as no longer pending", async () => {
    await using session = await cursorRoom();
    const { room, agent } = session;
    const { result, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);
    const command = `${CURSOR_COMMAND} answer ${token} mode=plan`;
    const refused = room.holdMessage((content) => content === SAYS.resolved("question", token!), { error: new Error("platform unavailable") });
    const reply = await room.say(OWNER, command);
    await refused.sending;
    refused.release();

    expect(await room.outcome(reply)).toBe("failed");
    expect(await result).toEqual(answered({ mode: ["plan"] }));
    // The platform retries a failed message; the decision it resolved stays resolved once.
    expect(await room.exchange(OWNER, command)).toEqual([SAYS.notPending(token!)]);
    const next = agent.nextTurn(async (turn) => turn.say("Changelog tidied."));
    const message = await room.say(OWNER, "Now tidy the changelog");
    await next;
    expect(await room.outcome(message)).toBe("processed");
  });

  it.each([
    {
      policy: "accepts and answers automatically",
      options: { approvalMode: "autoAccept", questionMode: "autoFirst", planMode: "autoAccept" },
      expected: [selected("allow-always"), answered({ mode: ["plan"] }), { outcome: { outcome: "accepted" } }],
    },
    {
      policy: "declines and cancels automatically",
      options: { approvalMode: "autoDecline", questionMode: "autoCancel", planMode: "autoDecline" },
      expected: [CANCELLED, CANCELLED, { outcome: { outcome: "rejected" } }],
    },
  ] as const)("$policy without asking the room", async ({ options, expected }) => {
    await using session = await cursorRoom(options);
    const { result, message } = await session.start(answering(async (turn) => [
      await turn.requestPermission({ ...WRITE_FILE, options: [{ optionId: "allow-always", name: "Always", kind: "allow_always" }] }),
      await turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }, { id: "edit" }] }] }),
      await turn.plan({ title: "Plan" }),
    ]));

    expect(await result).toEqual(expected);
    expect(await session.room.outcome(message)).toBe("processed");
    expect(session.room.messages.filter(isPrompt)).toEqual([]);
  });

  it("lets anyone in the room resolve decisions when the allowlist is unset", async () => {
    await using session = await cursorRoom({ decisionAuthorizedSenders: undefined });
    const { result, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);

    expect(await session.room.exchange(INTRUDER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toContain(SAYS.resolved("question", token!));
    expect(await result).toEqual(answered({ mode: ["plan"] }));
  });

  it("lets nobody resolve decisions when the allowlist is empty", async () => {
    await using session = await cursorRoom({ decisionAuthorizedSenders: [] });
    const { room, agent } = session;
    const { tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);

    expect(await room.exchange(INTRUDER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toContain(SAYS.notAuthorized());
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toContain(SAYS.notAuthorized());
    await room.remove();
    await vi.waitFor(() => expect(agent.room("room-1").stopped).toBe(true));
  });

  it("cancels asks that arrive for a turn that is no longer there, and ignores a malformed one", async () => {
    await using session = await cursorRoom();
    const { room, agent } = session;
    let lateTurn: CursorTurn | undefined;
    const { result, message } = await session.start(answering(async (turn) => {
      lateTurn = turn;
      return [
        await turn.ask({ questions: [{ id: "broken" }, { id: "empty", options: [] }, { options: [{ id: "x" }] }, "not a question"] }),
        await turn.ask({ questions: "not a list" }),
      ];
    }));
    expect(await result).toEqual([CANCELLED, CANCELLED]);
    expect(await room.outcome(message)).toBe("processed");

    // The turn is over; Cursor asks again on its old session, and with no session at all.
    expect(await lateTurn!.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] })).toEqual(CANCELLED);
    expect(await lateTurn!.plan({ sessionId: undefined, title: "Plan" })).toEqual(CANCELLED);
    expect(await lateTurn!.requestPermission(WRITE_FILE)).toEqual(CANCELLED);
    await lateTurn!.notify("cursor/update_todos", { sessionId: undefined, todos: [{ id: "late", content: "Late", status: "pending" }] });
    expect(room.events("task").map((event) => event.content)).not.toContain("- [ ] Late");
    expect(room.messages.filter(isPrompt)).toEqual([]);
    expect(agent.receivedOf("session/new")).toHaveLength(1);
  });

  it("cancels an ask from a finished prompt while the room's next turn is still being established", async () => {
    await using session = await cursorRoom();
    const { room, agent } = session;
    const mode = { questions: [{ id: "mode", options: [{ id: "plan" }] }] };
    let finished: CursorTurn | undefined;
    void agent.nextTurn(async (turn) => {
      finished = turn;
      throw new Error("model crashed");
    });
    expect(await room.outcome(await room.say(OWNER, "Please update the notes"))).toBe("failed");

    // The crash dropped that session, so the next turn waits on a new one.
    const held = agent.room(DEFAULT_CURSOR_ROOM).holdSession();
    const next = agent.nextTurn(answering(async (turn) => turn.sessionId));
    const message = await room.say(OWNER, "Try again");
    await held.sending;

    expect(await finished!.ask({ sessionId: undefined, ...mode })).toEqual(CANCELLED);
    expect(await finished!.ask(mode)).toEqual(CANCELLED);
    held.release();
    expect(await next).toBe("cursor-session-2");
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.filter(isPrompt)).toEqual([]);
  });

  it("drops an ask from a retired Cursor process, even one naming the room's current session", async () => {
    await using session = await cursorRoom({ turnTimeoutMs: 200 });
    const { room, agent } = session;
    const cursor = agent.room(DEFAULT_CURSOR_ROOM);
    cursor.lingersOnStop = true;
    let retired: CursorTurn | undefined;
    void agent.nextTurn(async (turn) => {
      retired = turn;
      await new Promise(() => undefined);
    });
    expect(await room.outcome(await room.say(OWNER, "Please update the notes"))).toBe("failed");

    const lateAsk = createDeferred<Record<string, unknown>>();
    const { result, message } = await session.start(answering(async (turn) => {
      lateAsk.resolve(await retired!.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }));
      return turn.sessionId;
    }));

    // The new process numbers its sessions from 1 again, so the stale ask names the live session.
    expect(await result).toBe(retired!.sessionId);
    expect(cursor.launches).toBe(2);
    expect(await lateAsk.promise).toEqual({});
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.filter(isPrompt)).toEqual([]);
  });

  it("keeps sessionless asks and to-dos in their own room when two rooms' processes use the same session id", async () => {
    await using session = await cursorRoom();
    const { room, platform, agent } = session;
    const otherRoom = await platform.room("room-2");
    const ask = { sessionId: undefined, questions: [{ id: "mode", options: [{ id: "plan" }, { id: "edit" }] }] };
    const todo = (content: string) => ({ sessionId: undefined, todos: [{ id: "todo", content, status: "pending" }] });
    const run = (content: string) => async (turn: CursorTurn) => {
      await turn.notify("cursor/update_todos", todo(content));
      return [turn.sessionId, await turn.ask(ask)];
    };

    const { result: first, message, tokens: [firstToken] } = await session.start(run("room-1 notes"), 1);
    const second = agent.room("room-2").nextTurn(run("room-2 summary"));
    const otherMessage = await otherRoom.say(OWNER, "And summarise room-2");
    const [secondToken] = await promptTokens(otherRoom, 1);

    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${secondToken} mode=edit`)).toEqual([SAYS.notPending(secondToken!)]);
    expect(await otherRoom.exchange(OWNER, `${CURSOR_COMMAND} answer ${secondToken} mode=edit`)).toEqual([SAYS.resolved("question", secondToken!)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${firstToken} mode=plan`)).toEqual([SAYS.resolved("question", firstToken!)]);
    expect(await first).toEqual(["cursor-session-1", answered({ mode: ["plan"] })]);
    expect(await second).toEqual(["cursor-session-1", answered({ mode: ["edit"] })]);

    expect(await room.outcome(message)).toBe("processed");
    expect(await otherRoom.outcome(otherMessage)).toBe("processed");
    // Each turn posts its to-dos once Cursor finishes it.
    const todos = (target: BandRoom) => target.events("task").map((event) => event.content);
    await room.until(() => todos(room).includes("- [ ] room-1 notes") && todos(otherRoom).includes("- [ ] room-2 summary"));
    expect(todos(room)).not.toContain("- [ ] room-2 summary");
    expect(todos(otherRoom)).not.toContain("- [ ] room-1 notes");
  });

  it("runs a second room's request while the first room's decision is pending, and keeps each room's decisions to itself", async () => {
    await using session = await cursorRoom();
    const { room, platform, agent } = session;
    const otherRoom = await platform.room("room-2");
    const { result: first, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);
    const second = agent.room("room-2").nextTurn(answering(async (turn) => turn.sessionId));

    // Room-2 has its own Cursor process, so its request runs now, not after room-1's turn.
    const queued = await otherRoom.say(OWNER, "And summarise room-2");
    expect(await second).toBe("cursor-session-1");
    expect(await otherRoom.outcome(queued)).toBe("processed");
    expect(await otherRoom.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.notPending(token!)]);

    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.resolved("question", token!)]);
    expect(await first).toEqual(answered({ mode: ["plan"] }));
  });

  it("lets a room waiting on its own decision be removed without stalling the other room, and rejoin on a fresh process", async () => {
    await using session = await cursorRoom();
    const { room, platform, agent } = session;
    const otherRoom = await platform.room("room-2");
    const ask = { questions: [{ id: "mode", options: [{ id: "plan" }] }] };
    const { result, tokens: [token] } = await session.start((turn) => turn.ask(ask), 1);
    void agent.room("room-2").nextTurn((turn) => turn.ask(ask));
    const queued = await otherRoom.say(OWNER, "And summarise room-2");
    await promptTokens(otherRoom, 1);
    expect(await otherRoom.outcome(queued)).toBe("processed");
    expect(await otherRoom.exchange(OWNER, "Anything yet?")).toEqual([SAYS.turnInProgress()]);

    await otherRoom.remove();
    await vi.waitFor(() => expect(agent.room("room-2").stopped).toBe(true));
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.resolved("question", token!)]);
    expect(await result).toEqual(answered({ mode: ["plan"] }));

    const rejoined = await platform.room("room-2");
    const next = agent.room("room-2").nextTurn(answering(async (turn) => turn.sessionId));
    const message = await rejoined.say(OWNER, "Summarise room-2 again");
    expect(await next).toBe("cursor-session-1");
    expect(agent.room("room-2").launches).toBe(2);
    expect(await rejoined.outcome(message)).toBe("processed");
  });

  it("settles a request whose Cursor turn crashes, and serves the room's next one", async () => {
    await using session = await cursorRoom();
    const { room, agent } = session;
    void agent.nextTurn(async () => {
      throw new Error("model crashed");
    });
    const crashed = await room.say(OWNER, "Please update the notes");
    expect(await room.outcome(crashed)).toBe("failed");
    expect(room.events("error").map((event) => event.metadata?.failure)).toEqual([expect.objectContaining({ detail: { details: "model crashed" } })]);

    // The crash came back as Cursor's own error response, so its process is
    // kept; the session that never answered is replaced.
    const { result, message } = await session.start(answering(async (turn) => turn.sessionId));
    expect(await result).toBe("cursor-session-2");
    expect(agent.room(DEFAULT_CURSOR_ROOM).launches).toBe(1);
    expect(await room.outcome(message)).toBe("processed");
  });

  it("renders Cursor's todo, task and image updates as room events, tolerating partial payloads", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    const { result, message } = await session.start(answering(async (turn) => {
      await turn.notify("cursor/update_todos", { merge: true, todos: [{ id: "review", content: "Review the change", status: "in_progress" }] });
      await turn.notify("cursor/update_todos", {
        merge: true,
        todos: [{ id: "review", content: "Review the change", status: "completed" }, { id: "tests", content: "Run tests", status: "cancelled" }, { id: "broken" }, "junk"],
      });
      await turn.notify("cursor/update_todos", { sessionId: undefined, todos: [] });
      await turn.notify("cursor/update_todos", { todos: "not a list" });
      await turn.notify("cursor/update_todos", { todos: [{ id: "blocked", content: "Wait for review", status: "blocked" }] });
      await turn.notify("cursor/task", { description: "Review implementation", subagentType: "explorer", model: "composer" });
      await turn.notify("cursor/task", { description: "Scan the repo" });
      await turn.notify("cursor/task", {});
      await turn.notify("cursor/generate_image", { description: "Architecture diagram", filePath: "diagram.png" });
      await turn.notify("cursor/generate_image", { description: "Logo" });
      await turn.notify("cursor/generate_image", {});
      await turn.notify("cursor/unknown", { anything: true });
      return [await turn.extMethod("cursor/unknown", {}), await turn.ask({ ...FILES_AND_MODE, questions: [] })];
    }));

    expect(await result).toEqual([{}, CANCELLED]);
    expect(await room.outcome(message)).toBe("processed");
    // Updates with nothing to show (an empty todo list, a task or image without a description) post nothing.
    expect(room.events("task").map((event) => event.content)).toEqual([
      "- [~] Review the change",
      "- [x] Review the change\n- [-] Run tests",
      // Without `merge`, the list is replaced; a status Cursor may add later renders as open.
      "- [ ] Wait for review",
      "[Cursor explorer task] Review implementation (composer)",
      "[Cursor unspecified task] Scan the repo",
      "[Cursor generated image] Architecture diagram → diagram.png",
      "[Cursor generated image] Logo",
      "ACP client session",
    ]);
  });

  it.each(contractRows<{ relayed: string[]; failures: ReportedFailure[]; outcome: Outcome }>({
    decline: { relayed: [], failures: [], outcome: "processed" },
    toolReply: { relayed: [], failures: [], outcome: "processed" },
    act: { relayed: [], failures: [], outcome: "processed" },
    finalText: { relayed: [CLOSING_TEXT], failures: [], outcome: "processed" },
    nothing: { relayed: [], failures: [MISSING_REPLY], outcome: "failed" },
  }))("settles a `$script` turn as $outcome, relaying Cursor's text only when no Band tool answered", async ({ script, relayed, failures, outcome }) => {
    await using session = await cursorRoom();
    const { room } = session;
    const { message } = await session.start(TURN_SCRIPTS[script]);

    expect(await room.outcome(message)).toBe(outcome);
    expect(room.messages.map((posted) => posted.content)).toEqual(relayed);
    expect(room.failures).toEqual(failures);
  });

  it.each([
    { ending: "answers after the decision", script: TURN_SCRIPTS.finalText, relayed: [CLOSING_TEXT], failures: [] },
    { ending: "ends with nothing", script: TURN_SCRIPTS.nothing, relayed: [], failures: [MISSING_REPLY] },
  ])("judges a turn handed back to the room for a decision when it really ends: one that $ending", async ({ script, relayed, failures }) => {
    await using session = await cursorRoom();
    const { room } = session;
    const { message, tokens: [token] } = await session.start(async (turn) => {
      await turn.ask(MODE);
      await script(turn);
    }, 1);
    expect(await room.outcome(message)).toBe("processed");
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.resolved("question", token!)]);
    await session.afterTurn();

    // The decision prompt was only a notice, so the answer after it is still relayed.
    expect(room.messages.map((posted) => posted.content)).toEqual([SAYS.questionPrompt(token!), SAYS.resolved("question", token!), ...relayed, DONE]);
    expect(room.failures).toEqual(failures);
    expect(room.outcomes(message), "the request was already handed back").toEqual(["processed"]);
  });

  it("settles busy and control messages during a handed-back turn, and keeps that turn's own reply on it", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    const { message, tokens: [token] } = await session.start(async (turn) => {
      await turn.ask(MODE);
      await TURN_SCRIPTS.toolReply(turn);
    }, 1);

    for (const content of ["Is it done yet?", CURSOR_COMMAND, `${CURSOR_COMMAND} answer ${token} mode=plan`]) {
      expect(await room.outcome(await room.say(OWNER, content)), content).toBe("processed");
    }
    await session.afterTurn();

    // Cursor's tool reply counted on its own turn: the closing text is not relayed, and nothing is reported.
    expect(room.messages.map((posted) => posted.content)).not.toContain(CLOSING_TEXT);
    expect(room.failures).toEqual([]);
    expect(room.outcomes(message)).toEqual(["processed"]);
  });

  // The cancel closes the ACP connection under the turn, whose own failure report completes it first; Band refuses
  // that report, since the agent has left the room.
  it("ends a handed-back turn cancelled by the agent leaving the room once, by its own failure, not a missing reply", async () => {
    const logger = makeLoggerSpy();
    await using session = await cursorRoom({ logger });
    const { room, platform } = session;
    const { message } = await session.start((turn) => turn.ask(MODE), 1);
    expect(await room.outcome(message)).toBe("processed");

    await room.remove();
    // Logged once the cancelled turn has fully unwound, past the point it would report.
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith("cursor_acp.released_turn_failed", expect.anything()));
    expect(logger.warn.mock.calls.filter(([event]) => event === "cursor_acp.released_turn_failed")).toHaveLength(1);
    expect(platform.rest.refused.entries).toEqual([{ roomId: room.id, call: "createChatEvent" }]);

    // The runtime keeps serving the agent's other rooms.
    const otherRoom = await platform.room("room-2");
    expect(await otherRoom.exchange(OWNER, CURSOR_COMMAND)).toEqual([SAYS.pendingList([])]);
  });

  // `reportTurnFailure` swallows a refused report, so the turn's verdict still reads missing_reply.
  it("never reports a missing reply for a handed-back turn that failed, even when the platform refused its failure report", async () => {
    const logger = makeLoggerSpy();
    await using session = await cursorRoom({ logger });
    const { room, platform } = session;
    const createChatEvent = platform.rest.createChatEvent.bind(platform.rest);
    let refused = false;
    vi.spyOn(platform.rest, "createChatEvent").mockImplementation(async (roomId, event) => {
      if (event.messageType === FAILURE_EVENT_TYPE && !refused) {
        refused = true;
        throw new Error("platform unavailable");
      }
      return createChatEvent(roomId, event);
    });
    const { tokens: [token] } = await session.start(async (turn) => {
      await turn.ask(MODE);
      throw new Error("model crashed");
    }, 1);

    await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith("cursor_acp.released_turn_failed", expect.anything()));

    expect(room.failures).toEqual([]);
  });

  it.each([
    { invalid: "both credentials", options: { apiKey: "key", authToken: "token" }, error: "set either apiKey or authToken, not both" },
    { invalid: "an empty command", options: { command: [] }, error: "Cursor ACP command must not be empty" },
    { invalid: "a zero decision timeout", options: { decisionTimeoutMs: 0 }, error: "decisionTimeoutMs must be a positive finite number" },
    { invalid: "an unbounded decision timeout", options: { decisionTimeoutMs: Infinity }, error: "decisionTimeoutMs must be a positive finite number" },
    { invalid: "a fractional pending limit", options: { maxPendingDecisions: 1.5 }, error: "maxPendingDecisions must be a positive integer" },
    { invalid: "a zero permission timeout", options: { permissionTimeoutMs: 0 }, error: "permissionTimeoutMs must be a positive finite number" },
  ])("refuses to start with $invalid", ({ options, error }) => {
    expect(() => new CursorACPAdapter({ cwd: tmpRoot(), enableMcpTools: false, ...options })).toThrow(error);
  });

  it.each([
    { workspace: "a fresh workspace", existing: undefined, expected: { permissions: { allow: [BAND_MCP_PERMISSION], deny: [] } } },
    {
      workspace: "a workspace with its own Cursor rules",
      existing: { model: "auto", permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] } },
      expected: { model: "auto", permissions: { allow: ["Shell(ls)", BAND_MCP_PERMISSION], deny: ["Shell(rm)"] } },
    },
    {
      workspace: "a workspace whose config lacks the deny list Cursor requires",
      existing: { permissions: { allow: [BAND_MCP_PERMISSION] } },
      expected: { permissions: { allow: [BAND_MCP_PERMISSION], deny: [] } },
    },
  ])("lets Cursor call Band's own tools without asking the room, in $workspace", async ({ existing, expected }) => {
    const root = tmpRoot();
    const config = join(root, DEFAULT_WORKSPACE_DIRECTORY, DEFAULT_CURSOR_ROOM, CURSOR_PROJECT_CONFIG);
    if (existing) {
      await mkdir(dirname(config), { recursive: true });
      await writeFile(config, JSON.stringify(existing));
    }
    await using session = await cursorRoom({ cwd: root });
    const { result } = await session.start(async (turn) => turn.sessionId);
    await result;

    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(expected);
  });

  it.each([
    { invalid: "is not JSON", text: "{ allow: ", error: /is not valid JSON/ },
    { invalid: "has a non-list allow", text: JSON.stringify({ permissions: { allow: "Shell(ls)" } }), error: /permissions\.allow must be a list of strings/ },
  ])("leaves a Cursor config that $invalid untouched, naming the problem", async ({ text, error }) => {
    const workspace = tmpRoot();
    const config = join(workspace, CURSOR_PROJECT_CONFIG);
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, text);

    await expect(allowBandMcpTools(workspace)).rejects.toThrow(error);
    expect(await readFile(config, "utf8")).toBe(text);
  });

  // A credential authenticates the CLI itself; ACP `cursor_login` is the interactive login and hangs headless.
  it.each([
    { credential: "an API key", options: { apiKey: "key-1" }, inherited: {}, env: { CURSOR_API_KEY: "key-1" }, logins: [] },
    { credential: "an auth token", options: { authToken: "token-1" }, inherited: {}, env: { CURSOR_AUTH_TOKEN: "token-1" }, logins: [] },
    { credential: "an inherited API key", options: {}, inherited: { CURSOR_API_KEY: "key-2" }, env: undefined, logins: [] },
    { credential: "nothing", options: {}, inherited: {}, env: undefined, logins: [{ methodId: "cursor_login" }] },
  ])("launches Cursor with $credential, logging in through ACP only without one", async ({ options, inherited, env, logins }) => {
    vi.stubEnv("CURSOR_API_KEY", "");
    vi.stubEnv("CURSOR_AUTH_TOKEN", "");
    for (const [name, value] of Object.entries(inherited)) vi.stubEnv(name, value);
    try {
      await using session = await cursorRoom(options);
      const { result } = await session.start(async (turn) => turn.sessionId);

      expect(await result).toBe("cursor-session-1");
      expect(session.agent.launchEnvs).toEqual([env]);
      expect(session.agent.receivedOf("authenticate")).toEqual(logins);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

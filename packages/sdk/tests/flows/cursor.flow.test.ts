/**
 * Cursor in a Band room, end to end: people talk in the room through the real
 * platform runtime, and a Cursor agent peer talks back over a real ACP
 * connection. Each flow asserts what the room saw, what Cursor was told, and
 * how the platform settled each message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorACPAdapter, type CursorACPAdapterOptions } from "../../src/adapters/cursor-acp";
import { createDeferred } from "../../src/core/deferred";
import { DEFAULT_CURSOR_DECISION_TIMEOUT_MS } from "../../src/adapters/cursor-acp/CursorACPAdapter";
import { CURSOR_COMMAND, CURSOR_DECISION_MESSAGES as SAYS } from "../../src/adapters/cursor-acp/messages";
import { BandPlatform, person, type BandRoom, type Posted } from "./support/bandPlatform";
import { FakeCursorAgent, type CursorTurn } from "./support/fakeCursorAgent";

const OWNER = "owner";
const TEAMMATE = "teammate";
const INTRUDER = "intruder";

// Every decision prompt offers `/cursor <verb> <token> ...`; nothing else Cursor posts does.
const DECISION_TOKEN = new RegExp(`\\${CURSOR_COMMAND} \\w+ ([^\\s\`]+)`);
const tokenOf = (posted: Posted) => posted.content.match(DECISION_TOKEN)?.[1];
const isPrompt = (posted: Posted) => tokenOf(posted) !== undefined;

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

/** One Cursor agent on the platform, in room-1, which OWNER, TEAMMATE and INTRUDER share. */
async function cursorRoom(options: Partial<CursorACPAdapterOptions> = {}) {
  const agent = new FakeCursorAgent();
  const adapter = new CursorACPAdapter({
    enableMcpTools: false,
    decisionAuthorizedSenders: [OWNER, TEAMMATE],
    connectionFactory: agent.connectionFactory,
    ...options,
  });
  const platform = await BandPlatform.start(adapter, [OWNER, TEAMMATE, INTRUDER].map(person));
  const room = await platform.room("room-1");
  return {
    agent,
    room,
    platform,
    /** OWNER asks Cursor for something; Cursor runs `script`. Resolves once the room is asked `prompts` decisions. */
    async start<R>(script: (turn: CursorTurn) => Promise<R>, prompts = 0) {
      const result = agent.nextTurn(script);
      const message = await room.say(OWNER, "Please update the notes");
      await room.until(() => room.messages.filter(isPrompt).length >= prompts);
      return { result, message, tokens: room.messages.filter(isPrompt).map((posted) => tokenOf(posted)!) };
    },
    [Symbol.asyncDispose]: () => platform[Symbol.asyncDispose](),
  };
}

/** The latest prompt's token once `count` prompts have been posted. */
async function promptedToken(room: BandRoom, count: number): Promise<string> {
  await room.until(() => room.messages.filter(isPrompt).length >= count);
  return tokenOf(room.messages.filter(isPrompt)[count - 1]!)!;
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

    const remove = await promptedToken(room, 2);
    expect(await room.exchange(TEAMMATE, `${CURSOR_COMMAND} deny ${remove}`)).toContain(SAYS.resolved("permission", remove));
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${remove} allow`)).toEqual([SAYS.notPending(remove)]);

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

  it("asks the room to approve plans, including one left open when the agent leaves the room", async () => {
    await using session = await cursorRoom({ planMode: "manual" });
    const { room, agent } = session;
    const openPlan = { title: "Refactor plan", overview: "Split the module" };
    const { result, tokens: [untitled] } = await session.start(async (turn) => [
      await turn.plan({ overview: "No title" }),
      await turn.plan(openPlan),
      await turn.plan(openPlan),
    ], 1);

    expect(room.messages.find(isPrompt)?.content).toBe(SAYS.planPrompt("Cursor plan", untitled!));
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${untitled} x=y`)).toEqual([SAYS.invalidCommand("plan", untitled!)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} reject ${untitled}`)).toContain(SAYS.resolved("plan", untitled!));
    const titled = await promptedToken(room, 2);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} accept ${titled}`)).toContain(SAYS.resolved("plan", titled));
    await promptedToken(room, 3);

    await room.remove();

    expect(await result).toEqual([{ outcome: { outcome: "rejected" } }, { outcome: { outcome: "accepted" } }, CANCELLED]);
    expect(agent.receivedOf("session/prompt")).toHaveLength(1);
  });

  it("shares a busy room: lists mixed pending asks, evicts the oldest, and keeps each room's asks to itself", async () => {
    await using session = await cursorRoom({ maxPendingDecisions: 2, planMode: "manual" });
    const { room, platform } = session;
    const otherRoom = await platform.room("room-2");
    const { result } = await session.start(async (turn) => Promise.all([
      turn.requestPermission(WRITE_FILE),
      turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }),
      turn.plan({ title: "Plan" }),
    ]), 3);
    const [evicted, ...pending] = room.messages.filter(isPrompt);
    const kindOf = (posted: Posted) => posted.content.startsWith("Cursor needs permission") ? "permission" : posted.content.startsWith("Cursor needs input") ? "question" : "plan";
    const listed = pending.map((posted) => `\`${tokenOf(posted)}\` (${kindOf(posted)})`);

    expect(await room.exchange(OWNER, CURSOR_COMMAND)).toEqual([SAYS.pendingList(listed)]);
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} decisions`)).toEqual([SAYS.pendingList(listed)]);
    expect(await otherRoom.exchange(OWNER, CURSOR_COMMAND)).toEqual([SAYS.pendingList([])]);
    for (const posted of pending) {
      expect(await otherRoom.exchange(OWNER, `${CURSOR_COMMAND} deny ${tokenOf(posted)}`)).toEqual([SAYS.notPending(tokenOf(posted)!)]);
    }
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} select ${tokenOf(evicted!)} allow`)).toEqual([SAYS.notPending(tokenOf(evicted!)!)]);

    await room.remove();
    expect((await result).map((outcome) => JSON.stringify(outcome))).toEqual([CANCELLED, CANCELLED, CANCELLED].map((outcome) => JSON.stringify(outcome)));
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
    expect(room.messages.filter((posted) => posted.content.includes("timed out"))).toEqual([
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
    const failedPrompts = [0, 1].map(() => room.holdMessage((content) => content.startsWith("Cursor needs input"), { error: new Error("platform timed out") }));
    moreAsks.resolve();
    const [[, claimedPrompt]] = await Promise.all(failedPrompts.map((prompt) => prompt.sending));

    const claimed = claimedPrompt.match(DECISION_TOKEN)![1]!;
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${claimed} claimed=yes`)).toEqual([SAYS.resolved("question", claimed)]);
    failedPrompts.forEach((prompt) => prompt.release());
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${first} first=yes`)).toEqual([SAYS.resolved("question", first!)]);

    expect(await result).toEqual([answered({ first: ["yes"] }), answered({ claimed: ["yes"] }), CANCELLED]);
    expect(room.messages.filter(isPrompt)).toHaveLength(1);
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
    const { result, message } = await session.start(async (turn) => [
      await turn.requestPermission({ ...WRITE_FILE, options: [{ optionId: "allow-always", name: "Always", kind: "allow_always" }] }),
      await turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }, { id: "edit" }] }] }),
      await turn.plan({ title: "Plan" }),
    ]);

    expect(await result).toEqual(expected);
    expect(await session.room.outcome(message)).toBe("processed");
    expect(session.room.messages.filter(isPrompt)).toEqual([]);
  });

  it.each([
    { allowlist: "unset, so anyone in the room", decisionAuthorizedSenders: undefined, intruder: SAYS.resolved("question", "{token}") },
    { allowlist: "empty, so nobody", decisionAuthorizedSenders: [], intruder: SAYS.notAuthorized() },
  ])("lets the room resolve decisions when the allowlist is $allowlist", async ({ decisionAuthorizedSenders, intruder }) => {
    await using session = await cursorRoom({ decisionAuthorizedSenders });
    const { room } = session;
    const { result, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);

    expect(await room.exchange(INTRUDER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toContain(intruder.replace("{token}", token!));
    if (decisionAuthorizedSenders) {
      await room.remove();
    }
    expect(await result).toEqual(decisionAuthorizedSenders ? CANCELLED : answered({ mode: ["plan"] }));
  });

  it("cancels asks that arrive for a turn that is no longer there, and ignores a malformed one", async () => {
    await using session = await cursorRoom();
    const { room, agent } = session;
    let lateTurn: CursorTurn | undefined;
    const { result, message } = await session.start(async (turn) => {
      lateTurn = turn;
      return [
        await turn.ask({ questions: [{ id: "broken" }, { id: "empty", options: [] }, { options: [{ id: "x" }] }, "not a question"] }),
        await turn.ask({ questions: "not a list" }),
      ];
    });
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

  it("keeps a second room waiting for Cursor from answering the first room's decision", async () => {
    await using session = await cursorRoom();
    const { room, platform } = session;
    const otherRoom = await platform.room("room-2");
    const { result: first, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);
    const second = session.agent.nextTurn(async (turn) => turn.sessionId);
    // Room-2's request waits for Cursor, so room-2's attempt at room-1's token is only read once room-1's turn is over.
    const queued = await otherRoom.say(OWNER, "And summarise room-2");
    const crossRoomAnswer = otherRoom.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`);

    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.resolved("question", token!)]);

    expect(await first).toEqual(answered({ mode: ["plan"] }));
    expect(await second).toBe("cursor-session-2");
    expect(await otherRoom.outcome(queued)).toBe("processed");
    expect(await crossRoomAnswer).toEqual([SAYS.notPending(token!)]);
  });

  it("lets a room waiting for Cursor be removed without stalling the room Cursor is asking", async () => {
    await using session = await cursorRoom();
    const { room, platform, agent } = session;
    const otherRoom = await platform.room("room-2");
    const { result, tokens: [token] } = await session.start((turn) => turn.ask({ questions: [{ id: "mode", options: [{ id: "plan" }] }] }), 1);
    const queued = await otherRoom.say(OWNER, "And summarise room-2");
    expect(await otherRoom.outcome(queued)).toBe("processed");
    expect(await otherRoom.exchange(OWNER, "Anything yet?")).toEqual([SAYS.turnInProgress()]);

    await otherRoom.remove();
    expect(await room.exchange(OWNER, `${CURSOR_COMMAND} answer ${token} mode=plan`)).toEqual([SAYS.resolved("question", token!)]);

    expect(await result).toEqual(answered({ mode: ["plan"] }));
    const rejoined = await platform.room("room-2");
    const next = agent.nextTurn(async (turn) => turn.sessionId);
    const message = await rejoined.say(OWNER, "Summarise room-2 again");
    expect(await next).toBe("cursor-session-2");
    expect(await rejoined.outcome(message)).toBe("processed");
    expect(agent.receivedOf("session/prompt")).toHaveLength(2);
  });

  it("renders Cursor's todo, task and image updates as room events, tolerating partial payloads", async () => {
    await using session = await cursorRoom();
    const { room } = session;
    const { result, message } = await session.start(async (turn) => {
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
    });

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

  it.each([
    { invalid: "both credentials", options: { apiKey: "key", authToken: "token" }, error: "set either apiKey or authToken, not both" },
    { invalid: "an empty command", options: { command: [] }, error: "Cursor ACP command must not be empty" },
    { invalid: "a zero decision timeout", options: { decisionTimeoutMs: 0 }, error: "decisionTimeoutMs must be a positive finite number" },
    { invalid: "an unbounded decision timeout", options: { decisionTimeoutMs: Infinity }, error: "decisionTimeoutMs must be a positive finite number" },
    { invalid: "a fractional pending limit", options: { maxPendingDecisions: 1.5 }, error: "maxPendingDecisions must be a positive integer" },
  ])("refuses to start with $invalid", ({ options, error }) => {
    expect(() => new CursorACPAdapter({ enableMcpTools: false, ...options })).toThrow(error);
  });

  it.each([
    { credential: "an API key", options: { apiKey: "key-1" }, env: { CURSOR_API_KEY: "key-1" } },
    { credential: "an auth token", options: { authToken: "token-1" }, env: { CURSOR_AUTH_TOKEN: "token-1" } },
    { credential: "nothing", options: {}, env: undefined },
  ])("launches Cursor with $credential in its environment", async ({ options, env }) => {
    await using session = await cursorRoom(options);
    const { result } = await session.start(async (turn) => turn.sessionId);

    expect(await result).toBe("cursor-session-1");
    expect(session.agent.launchEnvs).toEqual([env]);
  });
});

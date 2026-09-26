import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorACPAdapter } from "../src/adapters/cursor-acp";
import { DEFAULT_CURSOR_DECISION_TIMEOUT_MS } from "../src/adapters/cursor-acp/CursorACPAdapter";
import { CURSOR_COMMAND, CURSOR_DECISION_MESSAGES } from "../src/adapters/cursor-acp/messages";
import { createDeferred } from "../src/core/deferred";
import { FakeTools, makeMessage } from "./testUtils";

// Every decision prompt offers `/cursor <verb> <token> ...`; nothing else Cursor posts does.
const DECISION_TOKEN = new RegExp(`\\${CURSOR_COMMAND} \\w+ (\\S+)`);
const decisionToken = (prompt: string) => prompt.match(DECISION_TOKEN)?.[1];
const isDecisionPrompt = (content: string) => decisionToken(content) !== undefined;

interface CursorClient {
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
  requestPermission(params: unknown): Promise<unknown>;
}

function mockConnection(prompt: () => Promise<{ stopReason: string }>, sessionIds = ["cursor-session"]) {
  const controller = new AbortController();
  let sessionIndex = 0;
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: sessionIds[sessionIndex++] ?? sessionIds.at(-1)! })),
      prompt,
    } as never,
    stop: async () => controller.abort(),
  };
}

describe("CursorACPAdapter", () => {
  it("routes an authorized multi-question answer through the live ACP extension request", async () => {
    let client: CursorClient | undefined;
    let request: Promise<Record<string, unknown>> | undefined;
    const adapter = new CursorACPAdapter({
      enableMcpTools: false,
      decisionAuthorizedSenders: ["owner"],
      connectionFactory: async (captured) => {
        client = captured as CursorClient;
        return mockConnection(async () => {
          request = client!.extMethod("cursor/ask_question", {
            questions: [
              {
                id: "files",
                prompt: "Choose files",
                allowMultiple: true,
                options: [{ id: "readme", label: "README" }, { id: "config", label: "Config" }],
              },
              {
                id: "mode",
                prompt: "Choose mode",
                options: [{ id: "plan", label: "Plan" }],
              },
            ],
          });
          await request;
          return { stopReason: "end_turn" };
        });
      },
    });
    const tools = new FakeTools();

    await adapter.onStarted("Cursor", "desc");
    const turn = adapter.onMessage(
      cursorMessage("start", "requester"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    await vi.waitFor(() => expect(tools.messages[0]).toContain("/cursor answer"));
    const token = decisionToken(tools.messages[0]!);
    expect(token).toBeDefined();

    await adapter.onMessage(
      cursorMessage(`/cursor answer ${token} files=readme,config mode=plan`, "intruder"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );
    expect(tools.messages.at(-1)).toBe("You are not authorized to resolve Cursor decisions.");

    await adapter.onMessage(
      cursorMessage(`/cursor answer ${token} files=readme,config mode=plan`, "owner"),
      tools,
      { roomToSession: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    await expect(request).resolves.toEqual({
      outcome: {
        outcome: "answered",
        answers: [
          { questionId: "files", selectedOptionIds: ["readme", "config"] },
          { questionId: "mode", selectedOptionIds: ["plan"] },
        ],
      },
    });
    await turn;
    await adapter.stop();
  });

  it("applies automatic question, plan, and permission policies through ACP", async () => {
    let client: CursorClient | undefined;
    let results: unknown[] = [];
    const adapter = new CursorACPAdapter({
      enableMcpTools: false,
      questionMode: "autoFirst",
      planMode: "autoAccept",
      approvalMode: "autoAccept",
      connectionFactory: async (captured) => {
        client = captured as CursorClient;
        return mockConnection(async () => {
          results = await Promise.all([
            client!.extMethod("cursor/ask_question", {
              questions: [{ id: "question", options: [{ id: "first" }, { id: "second" }] }],
            }),
            client!.extMethod("cursor/create_plan", {}),
            client!.requestPermission({
              sessionId: "cursor-session",
              toolCall: { toolCallId: "tool-call", title: "Write file" },
              options: [{ optionId: "deny", kind: "reject_once" }, { optionId: "allow", kind: "allow_once" }],
            }),
          ]);
          return { stopReason: "end_turn" };
        });
      },
    });

    await adapter.onStarted("Cursor", "desc");
    await adapter.onMessage(cursorMessage("start", "requester"), new FakeTools(), { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(results).toEqual([
      { outcome: { outcome: "answered", answers: [{ questionId: "question", selectedOptionIds: ["first"] }] } },
      { outcome: { outcome: "accepted" } },
      { outcome: { outcome: "selected", optionId: "allow" } },
    ]);
    await adapter.stop();
  });

  it("routes documented no-session Cursor extension payloads and preserves merged todos", async () => {
    let client: CursorClient | undefined;
    const adapter = new CursorACPAdapter({
      enableMcpTools: false,
      connectionFactory: async (captured) => {
        client = captured as CursorClient;
        return mockConnection(async () => {
          await client!.extNotification("cursor/update_todos", {
            todos: [{ id: "review", content: "Review the change", status: "in_progress" }],
          });
          await client!.extNotification("cursor/update_todos", {
            merge: true,
            todos: [{ id: "review", content: "Review the change", status: "completed" }, { id: "tests", content: "Run tests", status: "pending" }],
          });
          await client!.extNotification("cursor/task", { description: "Review implementation", subagentType: "explorer", model: "composer" });
          await client!.extNotification("cursor/generate_image", { description: "Architecture diagram", filePath: "diagram.png" });
          return { stopReason: "end_turn" };
        });
      },
    });
    const tools = new FakeTools();

    await adapter.onStarted("Cursor", "desc");
    await adapter.onMessage(cursorMessage("start", "requester"), tools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(tools.events.map(({ content, messageType }) => ({ content, messageType }))).toEqual([
      { content: "- [~] Review the change", messageType: "task" },
      { content: "- [x] Review the change\n- [ ] Run tests", messageType: "task" },
      { content: "[Cursor explorer task] Review implementation (composer)", messageType: "task" },
      { content: "[Cursor generated image] Architecture diagram → diagram.png", messageType: "task" },
      { content: "ACP client session", messageType: "task" },
    ]);
    expect(tools.messages).toEqual([]);
    await adapter.stop();
  });

  it("keeps a concurrent room from taking over an active no-session decision", async () => {
    let client: CursorClient | undefined;
    let releaseFirstPrompt: (() => void) | undefined;
    const firstPromptMayAsk = new Promise<void>((resolve) => { releaseFirstPrompt = resolve; });
    let firstPromptStarted: (() => void) | undefined;
    const firstPromptIsRunning = new Promise<void>((resolve) => { firstPromptStarted = resolve; });
    let promptCount = 0;
    const adapter = new CursorACPAdapter({
      enableMcpTools: false,
      connectionFactory: async (captured) => {
        client = captured as CursorClient;
        return mockConnection(async () => {
          promptCount += 1;
          if (promptCount === 1) {
            firstPromptStarted!();
            await firstPromptMayAsk;
            await client!.extMethod("cursor/ask_question", {
              questions: [{ id: "question", options: [{ id: "answer" }] }],
            });
          }
          return { stopReason: "end_turn" };
        }, ["cursor-first", "cursor-queued"]);
      },
    });
    const firstTools = new FakeTools();
    const queuedTools = new FakeTools();

    await adapter.onStarted("Cursor", "desc");
    const firstTurn = adapter.onMessage(cursorMessage("first", "first-requester", "first-message"), firstTools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });
    await firstPromptIsRunning;
    const queuedTurn = adapter.onMessage(cursorMessage("queued", "queued-requester", "queued-message"), queuedTools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-2" });

    releaseFirstPrompt!();
    await vi.waitFor(() => expect(firstTools.messages[0]).toContain("/cursor answer"));
    expect(queuedTools.messages).toEqual([]);
    const token = decisionToken(firstTools.messages[0]!);
    await adapter.onMessage(cursorMessage(`/cursor answer ${token} question=answer`, "first-requester", "decision-message"), firstTools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });

    await Promise.all([firstTurn, queuedTurn]);
    expect(promptCount).toBe(2);
    await adapter.stop();
  });
});

describe("CursorACPAdapter decisions in a room", () => {
  const CANCELLED = { outcome: { outcome: "cancelled" } };
  const OWNER = "owner";

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A single-choice Cursor question with random ids, and the room reply and ACP result that answer it. */
  function aQuestion() {
    const questionId = `question-${randomUUID().slice(0, 8)}`;
    const optionId = `option-${randomUUID().slice(0, 8)}`;
    return {
      params: { questions: [{ id: questionId, options: [{ id: optionId }] }] },
      reply: (token: string) => `${CURSOR_COMMAND} answer ${token} ${questionId}=${optionId}`,
      answered: { outcome: { outcome: "answered", answers: [{ questionId, selectedOptionIds: [optionId] }] } },
    };
  }

  /** A Cursor agent peer that runs `script` against the live ACP client for one turn in room-1, opened by OWNER. */
  async function cursorRoom(
    options: Omit<ConstructorParameters<typeof CursorACPAdapter>[0], "connectionFactory">,
    script: (peer: CursorClient, tools: FakeTools) => Promise<unknown[]>,
    tools = new FakeTools(),
  ) {
    const results = createDeferred<unknown[]>();
    const adapter = new CursorACPAdapter({
      enableMcpTools: false,
      decisionAuthorizedSenders: [OWNER],
      ...options,
      connectionFactory: async (captured) => mockConnection(async () => {
        results.resolve(await script(captured as CursorClient, tools));
        return { stopReason: "end_turn" };
      }),
    });
    await adapter.onStarted("Cursor", "desc");
    const turn = adapter.onMessage(cursorMessage("start", OWNER), tools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });
    const say = async (content: string, { sender = OWNER, roomId = "room-1", roomTools = tools } = {}) => {
      await adapter.onMessage(cursorMessage(content, sender, `reply-${randomUUID()}`), roomTools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId });
      return roomTools.messages.at(-1);
    };
    const prompted = async (count: number) => {
      await tools.until(() => tools.messages.filter(isDecisionPrompt).length >= count);
      return tools.messages.filter(isDecisionPrompt).map((prompt) => decisionToken(prompt)!);
    };
    const finished = async () => {
      await turn;
      await adapter.stop();
      return results.promise;
    };
    return { tools, say, prompted, finished, adapter };
  }

  const pendingList = (...tokens: string[]) => CURSOR_DECISION_MESSAGES.pendingList(tokens.map((token) => `\`${token}\` (question)`));

  it("shares a busy room: evicts the oldest ask, scopes it to its room, and admits only allowed senders", async () => {
    const [oldest, middle, newest] = [aQuestion(), aQuestion(), aQuestion()];
    const room = await cursorRoom({ maxPendingDecisions: 2 }, async (peer, tools) => {
      const asked = [oldest, middle].map((question) => peer.extMethod("cursor/ask_question", question.params));
      await tools.until(() => tools.messages.length === 2);
      asked.push(peer.extMethod("cursor/ask_question", newest.params));
      return Promise.all(asked);
    });
    const [evicted, first, second] = await room.prompted(3);

    expect(await room.say(`${CURSOR_COMMAND} decisions`)).toBe(pendingList(first!, second!));
    expect(await room.say(oldest.reply(evicted!))).toBe(CURSOR_DECISION_MESSAGES.notPending(evicted!));
    expect(await room.say(middle.reply(first!), { sender: "intruder" })).toBe(CURSOR_DECISION_MESSAGES.notAuthorized());
    expect(room.tools.mentions.at(-1)).toEqual([{ id: "intruder" }]);

    const otherRoom = { roomId: "room-2", roomTools: new FakeTools() };
    await room.adapter.onCleanup("room-2");
    expect(await room.say(CURSOR_COMMAND, otherRoom)).toBe(CURSOR_DECISION_MESSAGES.pendingList([]));
    expect(await room.say(middle.reply(first!), otherRoom)).toBe(CURSOR_DECISION_MESSAGES.notPending(first!));

    expect(await room.say(`@[[agent-uuid]] ${middle.reply(first!)}`)).toBe(CURSOR_DECISION_MESSAGES.resolved("question", first!));
    expect(await room.say(middle.reply(first!))).toBe(CURSOR_DECISION_MESSAGES.notPending(first!));
    await room.say(newest.reply(second!));

    expect(await room.finished()).toEqual([CANCELLED, middle.answered, newest.answered]);
  });

  it("times each ask out at its own deadline, tells the requester once, and treats a late reply as not pending", async () => {
    vi.useFakeTimers();
    const PERMISSION_TIMEOUT_MS = 60_000;
    const question = aQuestion();
    const room = await cursorRoom({ permissionTimeoutMs: PERMISSION_TIMEOUT_MS }, async (peer) => Promise.all([
      peer.requestPermission({
        sessionId: "cursor-session",
        toolCall: { toolCallId: "tool-call", title: "Write file" },
        options: [{ optionId: "allow", kind: "allow_once" }],
      }),
      peer.extMethod("cursor/ask_question", question.params),
    ]));
    const tokens = await room.prompted(2);
    const permission = tokens.find((token) => room.tools.messages.includes(CURSOR_DECISION_MESSAGES.permissionPrompt(token)));
    const asked = tokens.find((token) => token !== permission);

    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(DEFAULT_CURSOR_DECISION_TIMEOUT_MS - PERMISSION_TIMEOUT_MS);
    expect(await room.say(question.reply(asked!))).toBe(CURSOR_DECISION_MESSAGES.notPending(asked!));

    expect(await room.finished()).toEqual([CANCELLED, CANCELLED]);
    expect(room.tools.messages.slice(2, 4)).toEqual([
      CURSOR_DECISION_MESSAGES.timedOut("permission", permission!),
      CURSOR_DECISION_MESSAGES.timedOut("question", asked!),
    ]);
    expect(room.tools.mentions.slice(2, 4)).toEqual([[OWNER], [OWNER]]);
  });

  it("lets a reply that claimed an ask outlive its failed prompt, and ends an unclaimed one at once", async () => {
    const [claimed, unclaimed] = [aQuestion(), aQuestion()];
    const tools = new FakeTools();
    const failedPrompts = [claimed, unclaimed].map(() => tools.holdMessage(isDecisionPrompt, { error: new Error("chat delivery failed") }));
    const room = await cursorRoom(
      {},
      async (peer) => Promise.all([claimed, unclaimed].map((question) => peer.extMethod("cursor/ask_question", question.params))),
      tools,
    );
    const [[claimedPrompt]] = await Promise.all(failedPrompts.map((prompt) => prompt.sending));

    await room.say(claimed.reply(decisionToken(claimedPrompt)!));
    failedPrompts.forEach((prompt) => prompt.release());

    expect(await room.finished()).toEqual([claimed.answered, CANCELLED]);
    expect(room.tools.messages.filter(isDecisionPrompt)).toEqual([]);
  });

  it("posts no prompt for a permission whose turn was already cancelled", async () => {
    const question = aQuestion();
    const room = await cursorRoom({}, async (peer) => [await peer.extMethod("cursor/ask_question", question.params)]);
    const [token] = await room.prompted(1);

    const permission = { sessionId: "cursor-session", roomId: "room-1", toolCall: { toolCallId: "tool-call" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };
    expect(await room.adapter.resolveCursorPermission(permission as never, AbortSignal.abort("cancelled"))).toBeUndefined();
    await room.say(question.reply(token!));

    expect(await room.finished()).toEqual([question.answered]);
    expect(room.tools.messages.filter(isDecisionPrompt)).toHaveLength(1);
  });
});

function cursorMessage(content: string, senderId: string, id = "msg-1") {
  return { ...makeMessage(content), id, senderId };
}

import { describe, expect, it, vi } from "vitest";

import { CursorACPAdapter } from "../src/adapters/cursor-acp";
import { FakeTools, makeMessage } from "./testUtils";

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
    const token = tools.messages[0]!.match(/answer ([a-f0-9]{8})/)?.[1];
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
    const token = firstTools.messages[0]!.match(/answer ([a-f0-9]{8})/)?.[1];
    await adapter.onMessage(cursorMessage(`/cursor answer ${token} question=answer`, "first-requester", "decision-message"), firstTools, { roomToSession: {} }, null, null, { isSessionBootstrap: false, roomId: "room-1" });

    await Promise.all([firstTurn, queuedTurn]);
    expect(promptCount).toBe(2);
    await adapter.stop();
  });
});

function cursorMessage(content: string, senderId: string, id = "msg-1") {
  return { ...makeMessage(content), id, senderId };
}

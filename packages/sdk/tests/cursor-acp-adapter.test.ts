import { describe, expect, it, vi } from "vitest";

import { CursorACPAdapter } from "../src/adapters/cursor-acp";
import { FakeTools, makeMessage } from "./testUtils";

interface CursorClient {
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function mockConnection(prompt: () => Promise<{ stopReason: string }>) {
  const controller = new AbortController();
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "cursor-session" })),
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
            sessionId: "cursor-session",
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
});

function cursorMessage(content: string, senderId: string) {
  return { ...makeMessage(content), senderId };
}

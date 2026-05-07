import { afterEach, describe, expect, it } from "vitest";

import { HttpStatusError, OpencodeAdapter } from "../src/adapters";
import type { OpencodeSessionState } from "../src/converters";
import { FakeTools, makeMessage } from "./testUtils";

class EventQueue {
  private readonly events: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  public push(event: Record<string, unknown>): void {
    this.events.push(event);
    this.waiters.shift()?.();
  }

  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.();
    }
  }

  public async *iterate(): AsyncIterable<Record<string, unknown>> {
    while (!this.closed || this.events.length > 0) {
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

class FakeOpencodeClient {
  public readonly promptCalls: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
  public readonly permissionReplies: Array<{ sessionId: string; permissionId: string; response: string }> = [];
  public readonly questionReplies: Array<{ requestId: string; answers: string[][] }> = [];
  public readonly rejectedQuestions: string[] = [];
  public readonly aborts: string[] = [];
  public readonly registeredMcpServers: Array<{ name: string; url: string }> = [];
  public readonly deregisteredMcpServers: string[] = [];
  public readonly createdSessions: string[] = [];
  public readonly eventQueue = new EventQueue();
  private readonly missingSessions = new Set<string>();
  private sessionCounter = 0;

  public markMissing(sessionId: string): void {
    this.missingSessions.add(sessionId);
  }

  public async createSession(): Promise<Record<string, unknown>> {
    this.sessionCounter += 1;
    const sessionId = `session-${this.sessionCounter}`;
    this.createdSessions.push(sessionId);
    return { id: sessionId };
  }

  public async getSession(sessionId: string): Promise<Record<string, unknown>> {
    if (this.missingSessions.has(sessionId)) {
      throw new HttpStatusError(404, { message: "missing" });
    }
    return { id: sessionId };
  }

  public async promptAsync(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.promptCalls.push({ sessionId, payload });
  }

  public async replyPermission(
    sessionId: string,
    permissionId: string,
    input: { response: string },
  ): Promise<void> {
    this.permissionReplies.push({ sessionId, permissionId, response: input.response });
  }

  public async replyQuestion(
    requestId: string,
    input: { answers: string[][] },
  ): Promise<void> {
    this.questionReplies.push({ requestId, answers: input.answers });
  }

  public async rejectQuestion(requestId: string): Promise<void> {
    this.rejectedQuestions.push(requestId);
  }

  public async abortSession(sessionId: string): Promise<void> {
    this.aborts.push(sessionId);
  }

  public async registerMcpServer(input: { name: string; url: string }): Promise<Record<string, unknown>> {
    this.registeredMcpServers.push(input);
    return { ok: true };
  }

  public async deregisterMcpServer(name: string): Promise<void> {
    this.deregisteredMcpServers.push(name);
  }

  public iterEvents(): AsyncIterable<Record<string, unknown>> {
    return this.eventQueue.iterate();
  }

  public async close(): Promise<void> {
    this.eventQueue.close();
  }
}

function emitAssistantText(client: FakeOpencodeClient, sessionId: string, text: string): void {
  client.eventQueue.push({
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-message",
        role: "assistant",
        sessionID: sessionId,
      },
    },
  });
  client.eventQueue.push({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-1",
        messageID: "assistant-message",
        sessionID: sessionId,
        type: "text",
        text,
      },
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("OpencodeAdapter", () => {
  const createdClients: FakeOpencodeClient[] = [];
  const adapters: OpencodeAdapter[] = [];

  afterEach(async () => {
    await Promise.all(adapters.map(async (adapter) => {
      await adapter.onRuntimeStop?.();
    }));
    adapters.length = 0;
    await Promise.all(createdClients.map(async (client) => {
      await client.close();
    }));
    createdClients.length = 0;
  });

  it("creates a session, registers MCP, and relays assistant text on idle", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: async () => ({
        kind: "http",
        server: { url: "http://127.0.0.1:5555/mcp" },
        allowedTools: [],
        stop: async () => undefined,
      }),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const pending = adapter.onMessage(
      makeMessage("Help with this bug"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      "Participants update",
      "Contacts update",
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    emitAssistantText(client, sessionId, "Here is the fix.");
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });

    await pending;

    expect(client.registeredMcpServers).toEqual([
      { name: "thenvoi", url: "http://127.0.0.1:5555/mcp" },
    ]);
    expect(client.promptCalls[0]?.payload.parts).toEqual([{
      type: "text",
      text: "[System]: The Thenvoi room_id for every thenvoi_* tool call this turn is \"room-1\". Pass it as the room_id argument exactly as written; do not invent or substitute another id.\n[System]: Participants update\n[System]: Contacts update\n[User]: Help with this bug",
    }]);
    expect(tools.events[0]).toMatchObject({
      messageType: "task",
    });
    expect(tools.messages).toContain("Here is the fix.");
  });

  it("supports manual permission follow-up while the turn is still active", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: async () => ({
        kind: "http",
        server: { url: "http://127.0.0.1:5555/mcp" },
        allowedTools: [],
        stop: async () => undefined,
      }),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const firstTurn = adapter.onMessage(
      makeMessage("Need approval flow"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-2" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: sessionId,
        permission: "bash",
        patterns: ["npm test"],
      },
    });

    await firstTurn;
    expect(tools.messages.at(-1)).toContain("approve perm-1");

    await adapter.onMessage(
      makeMessage("approve perm-1", "room-2"),
      tools,
      { sessionId, roomId: "room-2", createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );

    emitAssistantText(client, sessionId, "Approved action completed.");
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });

    await waitFor(() => tools.messages.includes("Approved action completed."));
    expect(client.permissionReplies).toEqual([
      { sessionId, permissionId: "perm-1", response: "once" },
    ]);
  });

  it("recreates missing sessions and injects replay history", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    client.markMissing("old-session");
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: async () => ({
        kind: "http",
        server: { url: "http://127.0.0.1:5555/mcp" },
        allowedTools: [],
        stop: async () => undefined,
      }),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const history: OpencodeSessionState = {
      sessionId: "old-session",
      roomId: "room-3",
      createdAt: null,
      replayMessages: ["[Jane]: previous context"],
    };

    const pending = adapter.onMessage(
      makeMessage("Recover this session", "room-3"),
      tools,
      history,
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-3" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    await pending;

    expect(client.promptCalls[0]?.payload.parts).toEqual([{
      type: "text",
      text: "[System]: The Thenvoi room_id for every thenvoi_* tool call this turn is \"room-3\". Pass it as the room_id argument exactly as written; do not invent or substitute another id.\nPrevious OpenCode session state was missing. Recovered room history:\n[Jane]: previous context\n[User]: Recover this session",
    }]);
    expect(tools.messages).toContain("OpenCode completed the turn without a text reply.");
  });
});

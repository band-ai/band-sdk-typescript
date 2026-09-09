import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpStatusError, OpencodeAdapter, type OpencodeClientLike } from "../src/adapters";
import { DeliveryFailedError } from "../src/adapters/shared/deliveryFailedError";
import type { OpencodeSessionState } from "../src/converters";
import { FakeTools, expectTurnFailed, findFailureEvent, makeMessage } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";

/**
 * Posts the first reply, then fails — a chat that goes away partway through a
 * turn, which `failOn: ["sendMessage"]` cannot express because it would also
 * take out the permission prompt that opens the turn under test.
 */
class ChatLostAfterFirstReply extends FakeTools {
  public override async sendMessage(
    content: string,
    mentions?: string[] | Array<{ id: string; handle?: string }>,
  ): Promise<Record<string, unknown>> {
    if (this.messages.length > 0) {
      throw new Error("chat delivery failed");
    }
    return super.sendMessage(content, mentions);
  }
}

/** The HTTP MCP backend every OpenCode test injects; `extra` adds what one test needs. */
function httpMcpBackend(extra: Record<string, unknown> = {}) {
  return async () => ({
    kind: "http" as const,
    server: { url: "http://127.0.0.1:5555/mcp" },
    allowedTools: [],
    stop: async () => undefined,
    ...extra,
  });
}

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
  public readonly registeredMcpServers: Array<{ name: string; url: string; headers?: Record<string, string> }> = [];
  public readonly deregisteredMcpServers: string[] = [];
  public readonly createdSessions: string[] = [];
  public readonly createdSessionTitles: string[] = [];
  public readonly eventQueue = new EventQueue();
  public promptError: Error | null = null;
  /** Consumed once, like `promptError` — fails the next `createSession` call only. */
  public createSessionError: Error | null = null;
  /** Stands in for a server that accepts the abort and never answers it. */
  public abortNeverSettles = false;
  private readonly missingSessions = new Set<string>();
  private sessionCounter = 0;

  public markMissing(sessionId: string): void {
    this.missingSessions.add(sessionId);
  }

  public async createSession(input?: { title?: string }): Promise<Record<string, unknown>> {
    if (this.createSessionError) {
      const error = this.createSessionError;
      this.createSessionError = null;
      throw error;
    }
    this.sessionCounter += 1;
    const sessionId = `session-${this.sessionCounter}`;
    this.createdSessions.push(sessionId);
    this.createdSessionTitles.push(input?.title ?? "");
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
    if (this.promptError) {
      const error = this.promptError;
      this.promptError = null;
      throw error;
    }
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
    if (this.abortNeverSettles) {
      await new Promise<void>(() => undefined);
    }
  }

  public async registerMcpServer(input: { name: string; url: string; headers?: Record<string, string> }): Promise<Record<string, unknown>> {
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

/** waitFor's fake-timer counterpart: nothing here waits on the real clock. */
async function advanceFakeTimersUntil(predicate: () => boolean, maxSteps = 50): Promise<void> {
  for (let step = 0; step < maxSteps && !predicate(); step += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
  if (!predicate()) {
    throw new Error("Timed out waiting for condition under fake timers.");
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
      mcpBackendFactory: httpMcpBackend(),
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
      { name: "band", url: "http://127.0.0.1:5555/mcp" },
    ]);
    expect(client.promptCalls[0]?.payload.parts).toEqual([{
      type: "text",
      text: "[System]: Participants update\n[System]: Contacts update\n[User]: Help with this bug",
    }]);
    expect(tools.events[0]).toMatchObject({
      messageType: "task",
    });
    expect(tools.messages).toContain("Here is the fix.");
  });

  it("registers the MCP server with a bearer-token header when the backend issues an authToken", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend({ authToken: "s3cr3t-token" }),
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
      {
        name: "band",
        url: "http://127.0.0.1:5555/mcp",
        headers: { Authorization: "Bearer s3cr3t-token" },
      },
    ]);
  });

  it("supports manual permission follow-up while the turn is still active", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
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

  it.each([
    {
      interaction: "permission",
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-1",
          permission: "bash",
          patterns: ["npm test"],
        },
      },
    },
    {
      interaction: "question",
      event: {
        type: "question.asked",
        properties: {
          id: "question-1",
          questions: [{ question: "Which approach?" }],
        },
      },
    },
  ])("fails the turn recoverably when delivering an OpenCode $interaction prompt fails", async ({ interaction, event }) => {
    const tools = new FakeTools({ failOn: ["sendMessage"] });
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      // Deliberately much larger than how long this test should actually
      // take — proves releaseTurnWait fired on its own, not via this watchdog.
      config: { turnTimeoutMs: 3_000 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const startedAt = Date.now();
    const firstTurn = adapter.onMessage(
      makeMessage("Need approval flow"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-prompt-delivery-fails" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      ...event,
      properties: { ...event.properties, sessionID: sessionId },
    });

    await expect(firstTurn).rejects.toBeInstanceOf(DeliveryFailedError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(tools.messages).toEqual([]);
    await waitFor(() => interaction === "permission"
      ? client.permissionReplies.length === 1
      : client.rejectedQuestions.length === 1);
    if (interaction === "permission") {
      expect(client.permissionReplies).toEqual([
        { sessionId, permissionId: "perm-1", response: "reject" },
      ]);
    } else {
      expect(client.rejectedQuestions).toEqual(["question-1"]);
    }
  });

  it("observes a turn that outlives its request, so a failed background delivery cannot end the process", async () => {
    // A permission ask returns `onMessage` with the turn still open, so the
    // reply arrives from the background loop with no turn left to fail. The
    // promise must still be observed: unobserved, a delivery failure there is
    // an unhandled rejection, which ends the process rather than the turn.
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tools = new ChatLostAfterFirstReply();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as unknown as OpencodeClientLike,
      mcpBackendFactory: httpMcpBackend(),
      logger,
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const firstTurn = adapter.onMessage(
      makeMessage("Need approval flow"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-observed" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "permission.asked",
      properties: { id: "perm-1", sessionID: sessionId, permission: "bash", patterns: ["npm test"] },
    });

    await firstTurn;
    expect(tools.messages.at(-1)).toContain("approve perm-1");

    emitAssistantText(client, sessionId, "Approved action completed.");
    client.eventQueue.push({ type: "session.idle", properties: { sessionID: sessionId } });

    await waitFor(() => logger.error.mock.calls.length > 0);
    expect(logger.error).toHaveBeenCalledWith(
      "OpenCode turn failed after the request returned",
      expect.objectContaining({ roomId: "room-observed" }),
    );
  });

  it("still surfaces a second interactive prompt's own delivery failure after the turn has already backgrounded", async () => {
    // The turn's first permission prompt delivers fine and backgrounds the
    // turn (releaseWait is spent). A second prompt in the same turn then
    // fails to deliver: releaseWait has nothing left to carry that failure
    // to, so it must reach the turn's background observer instead of
    // vanishing silently.
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tools = new ChatLostAfterFirstReply();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as unknown as OpencodeClientLike,
      mcpBackendFactory: httpMcpBackend(),
      logger,
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const firstTurn = adapter.onMessage(
      makeMessage("Need two approvals"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-second-prompt-delivery-fails" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "permission.asked",
      properties: { id: "perm-1", sessionID: sessionId, permission: "bash", patterns: ["npm test"] },
    });

    await firstTurn;
    expect(tools.messages).toHaveLength(1);

    client.eventQueue.push({
      type: "permission.asked",
      properties: { id: "perm-2", sessionID: sessionId, permission: "bash", patterns: ["npm build"] },
    });

    await waitFor(() => logger.error.mock.calls.length > 0);
    expect(logger.error).toHaveBeenCalledWith(
      "OpenCode turn failed after the request returned",
      expect.objectContaining({ roomId: "room-second-prompt-delivery-fails" }),
    );
    await waitFor(() => client.permissionReplies.length === 1);
    expect(client.permissionReplies).toEqual([
      { sessionId, permissionId: "perm-2", response: "reject" },
    ]);
    expect(findFailureEvent(tools)).toBeUndefined();
  });

  it("resolves onMessage instead of hanging when onCleanup fires on a still-active turn, and quietly cancels its background watchdog instead of leaving it to fail later", async () => {
    // onCleanup() can race a still-active turn (e.g. the runtime tearing the
    // room down while startTurn() is still awaiting releaseWait). Its
    // background watchdog must settle through an explicit cancellation
    // outcome rather than eventually reaching its own timeout: a
    // timed-out-after-cleanup watchdog calls client.abortSession() and
    // reports a failure against whatever session id a later, unrelated turn
    // goes on to reuse for this or another room (see the dedicated test
    // below).
    vi.useFakeTimers();
    try {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const tools = new FakeTools();
      const client = new FakeOpencodeClient();
      createdClients.push(client);
      const adapter = new OpencodeAdapter({
        clientFactory: () => client as any,
        mcpBackendFactory: httpMcpBackend(),
        config: { turnTimeoutMs: 30 },
        logger,
      });
      adapters.push(adapter);

      await adapter.onStarted("OpenCode Agent", "Writes code");
      const pending = adapter.onMessage(
        makeMessage("hello"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-cleanup-race" },
      );

      await advanceFakeTimersUntil(() => client.createdSessions.length === 1);
      // The turn is active here: promptAsync resolved, but no session.idle/
      // session.error event has arrived and the watchdog hasn't fired yet.
      await adapter.onCleanup("room-cleanup-race");

      // Must resolve promptly instead of hanging forever on the now-orphaned
      // releaseWait this turn is still awaiting.
      await pending;

      // Advance exactly past the watchdog's turnTimeoutMs deadline -- it
      // must have been cancelled, not merely delayed, so nothing fires once
      // it would otherwise have timed out.
      await vi.advanceTimersByTimeAsync(60);
      expect(client.aborts).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abort a replacement turn's session when a cleaned-up turn's watchdog would otherwise reach its original deadline", async () => {
    // handleTurnTimeout reads the *current* this.client and the stale
    // roomState's own sessionId. If onCleanup only released startTurn but
    // left the watchdog running, a later turn's fresh client minting the
    // identical session id (e.g. deterministic, directory-based ids) would
    // have its live session aborted once the old watchdog's original
    // deadline arrived.
    vi.useFakeTimers();
    try {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const clients: FakeOpencodeClient[] = [];
      const adapter = new OpencodeAdapter({
        clientFactory: () => {
          const client = new FakeOpencodeClient();
          clients.push(client);
          createdClients.push(client);
          return client as any;
        },
        mcpBackendFactory: httpMcpBackend(),
        // Long enough that neither turn's own watchdog could naturally fire
        // during this test — the fix's point is that cleanup cancels the
        // first turn's watchdog immediately, not merely delays it.
        config: { turnTimeoutMs: 10_000 },
        logger,
      });
      adapters.push(adapter);
      await adapter.onStarted("OpenCode Agent", "Writes code");

      const firstTurn = adapter.onMessage(
        makeMessage("hello"),
        new FakeTools(),
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-x" },
      );
      await advanceFakeTimersUntil(() => (clients[0]?.createdSessions.length ?? 0) === 1);
      expect(clients[0]?.createdSessions).toEqual(["session-1"]);

      // room-x is the only room, so cleaning it up also shuts its client down.
      await adapter.onCleanup("room-x");
      await firstTurn;

      // room-x rejoins on a fresh client that happens to mint the identical
      // session id.
      const secondTurn = adapter.onMessage(
        makeMessage("hello again"),
        new FakeTools(),
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-x" },
      );
      await advanceFakeTimersUntil(() => (clients[1]?.createdSessions.length ?? 0) === 1);
      expect(clients[1]?.createdSessions).toEqual(["session-1"]);

      // Advance well past the first turn's cancelled watchdog deadline, then
      // confirm it never touched the replacement's client.
      await vi.advanceTimersByTimeAsync(20);
      expect(clients[1]?.aborts).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();

      clients[1]!.eventQueue.push({ type: "session.idle", properties: { sessionID: "session-1" } });
      await secondTurn;
    } finally {
      vi.useRealTimers();
    }
  });

  it("recreates missing sessions and injects replay history", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    client.markMissing("old-session");
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
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
      text: "Previous OpenCode session state was missing. Recovered room history:\n[Jane]: previous context\n[User]: Recover this session",
    }]);
    expect(tools.messages).toContain("OpenCode completed the turn without a text reply.");
  });

  it("titles new sessions with the default \"Band: \" prefix", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as unknown as OpencodeClientLike,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const pending = adapter.onMessage(
      makeMessage("Kick things off"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-title" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    await pending;

    expect(client.createdSessionTitles[0]?.startsWith("Band: ")).toBe(true);
    expect(client.createdSessionTitles[0]).toBe("Band: OpenCode Agent / room-title");
  });

  it("honors a caller-supplied sessionTitlePrefix override", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as unknown as OpencodeClientLike,
      config: { sessionTitlePrefix: "Acme" },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const pending = adapter.onMessage(
      makeMessage("Kick things off"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-override" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    await pending;

    expect(client.createdSessionTitles[0]?.startsWith("Acme: ")).toBe(true);
    expect(client.createdSessionTitles[0]).toBe("Acme: OpenCode Agent / room-override");
  });

  it("uses the mcpServerName \"band\" by default", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as unknown as OpencodeClientLike,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");

    const pending = adapter.onMessage(
      makeMessage("Register the server"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-mcp" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    await pending;

    expect(client.registeredMcpServers).toHaveLength(1);
    expect(client.registeredMcpServers[0]?.name).toBe("band");
    expect(client.registeredMcpServers.some((entry) => entry.name === "thenvoi")).toBe(false);
    expect(client.deregisteredMcpServers).not.toContain("thenvoi");
  });

  it("migrates an HttpStatusError from promptAsync to a structured sendFailure", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    client.promptError = new HttpStatusError(500, { message: "internal error" });
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Trigger a status error"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-http-error" },
      ),
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      code: "500",
      detail: { message: "internal error" },
    });
    expect(tools.messages).toHaveLength(0);
  });

  it("migrates a generic thrown error (no structured signal) to a sendFailure fallback with no code", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    client.promptError = new Error("connection reset");
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Trigger a generic error"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-generic-error" },
      ),
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      code: null,
      message: "OpenCode failed while processing the message: connection reset",
    });
  });

  it("migrates OpenCode's own per-turn timeout to sendFailure with code: timeout, and aborts the session", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout" },
      ),
    );

    const sessionId = client.createdSessions[0]!;
    expect(client.aborts).toContain(sessionId);
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      code: "timeout",
      message: "OpenCode timed out before completing the turn.",
    });
  });

  it("logs a warning instead of silently dropping it when the fire-and-forget session abort itself fails after a turn timeout", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const abortError = new Error("opencode transport unreachable");
    vi.spyOn(client, "abortSession").mockRejectedValue(abortError);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
      logger,
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-abort-fails" },
      ),
    );

    const sessionId = client.createdSessions[0]!;
    await waitFor(() => logger.warn.mock.calls.length > 0);
    expect(logger.warn).toHaveBeenCalledWith("opencode_adapter.turn_abort_failed", {
      roomId: "room-abort-fails",
      sessionId,
      error: abortError,
    });
  });

  it("fails the turn (so PlatformRuntime retries it) when the turn times out, instead of resolving as if it processed", async () => {
    // The room-failure event above is best-effort reporting; PlatformRuntime's
    // own retry tracking depends on onMessage actually rejecting.
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout-retry" },
      ),
    );
  });

  it("opens a fresh session for the next turn in a room after a timeout, instead of resuming the timed-out one", async () => {
    // The abort after a timeout is fire-and-forget (see `abandon`), so the
    // timed-out session may still be settling server-side — the next turn in
    // this room must not race a new prompt against it by resuming the same
    // session id.
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds", "room-timeout-reuse"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout-reuse" },
      ),
    );
    const timedOutSessionId = client.createdSessions[0]!;
    expect(client.aborts).toContain(timedOutSessionId);

    // client.getSession happily "restores" any session id that isn't marked
    // missing, so this next turn getting a *second* created session (not a
    // restore of the first) proves ensureSession skipped the restore path.
    // This turn also times out (no completion event is pushed for it either).
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Second message", "room-timeout-reuse"),
        new FakeTools(),
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-timeout-reuse" },
      ),
    );

    expect(client.createdSessions).toHaveLength(2);
    expect(client.createdSessions[1]).not.toBe(timedOutSessionId);
    expect(client.promptCalls.map((call) => call.sessionId)).toContain(client.createdSessions[1]);
  });

  it("replays the room's prior conversation into a forced-fresh session, not just a restored one", async () => {
    // A forced-fresh session (after a timeout) is a brand-new OpenCode session,
    // but not a new conversation from the room's perspective — the room's real
    // prior history must still reach it, the same as a missing-session restore.
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds", "room-timeout-replay"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout-replay" },
      ),
    );
    expect(client.aborts).toContain(client.createdSessions[0]);

    const pending = adapter.onMessage(
      makeMessage("Second message", "room-timeout-replay"),
      new FakeTools(),
      { sessionId: null, roomId: null, createdAt: null, replayMessages: ["[Jane]: previous context"] },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-timeout-replay" },
    );

    await waitFor(() => client.createdSessions.length === 2);
    const freshSessionId = client.createdSessions[1]!;
    client.eventQueue.push({ type: "session.idle", properties: { sessionID: freshSessionId } });
    await pending;

    expect(client.promptCalls[1]?.payload.parts).toEqual([{
      type: "text",
      text: "Previous OpenCode session state was missing. Recovered room history:\n[Jane]: previous context\n[User]: Second message",
    }]);
  });

  it("keeps forcing a fresh session for the next turn when the first replacement attempt itself fails to create", async () => {
    // ensureSession must not clear forceFreshSession until a replacement
    // session actually exists server-side -- otherwise a failed createSession
    // permanently loses the flag, and the *next* turn silently resumes the
    // very session this one was trying to abandon.
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds", "room-timeout-rearm"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout-rearm" },
      ),
    );
    const timedOutSessionId = client.createdSessions[0]!;
    expect(client.aborts).toContain(timedOutSessionId);

    client.createSessionError = new Error("transient create failure");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Second message", "room-timeout-rearm"),
        new FakeTools(),
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-timeout-rearm" },
      ),
    );
    expect(client.createdSessions).toHaveLength(1);

    const pending = adapter.onMessage(
      makeMessage("Third message", "room-timeout-rearm"),
      new FakeTools(),
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-timeout-rearm" },
    );

    await waitFor(() => client.createdSessions.length === 2);
    const freshSessionId = client.createdSessions[1]!;
    client.eventQueue.push({ type: "session.idle", properties: { sessionID: freshSessionId } });
    await pending;

    expect(client.createdSessions[1]).not.toBe(timedOutSessionId);
  });

  it("keeps forcing a fresh session with history replay when the forced-fresh session's own prompt submission fails", async () => {
    // ensureSession must not clear forceFreshSession just because the
    // replacement session was created -- until promptAsync actually submits
    // its history replay, a rejection there must leave the flag set, or the
    // *next* retry resumes the history-less fresh session as if it were
    // ordinary, silently losing the room's prior conversation for good.
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds", "room-timeout-replay-retry"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-timeout-replay-retry" },
      ),
    );
    const timedOutSessionId = client.createdSessions[0]!;
    expect(client.aborts).toContain(timedOutSessionId);

    // The forced-fresh session is created, but submitting its prompt fails.
    client.promptError = new Error("delivery hiccup");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Second message", "room-timeout-replay-retry"),
        new FakeTools(),
        { sessionId: null, roomId: null, createdAt: null, replayMessages: ["[Jane]: previous context"] },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-timeout-replay-retry" },
      ),
    );
    expect(client.createdSessions).toHaveLength(2);
    expect(client.createdSessions[1]).not.toBe(timedOutSessionId);

    // The retry must still force a fresh session (abandoning the one whose
    // prompt never went out) and still replay the room's real history into it.
    const pending = adapter.onMessage(
      makeMessage("Third message", "room-timeout-replay-retry"),
      new FakeTools(),
      { sessionId: null, roomId: null, createdAt: null, replayMessages: ["[Jane]: previous context"] },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-timeout-replay-retry" },
    );

    await waitFor(() => client.createdSessions.length === 3);
    const freshSessionId = client.createdSessions[2]!;
    client.eventQueue.push({ type: "session.idle", properties: { sessionID: freshSessionId } });
    await pending;

    expect(client.promptCalls[client.promptCalls.length - 1]?.payload.parts).toEqual([{
      type: "text",
      text: "Previous OpenCode session state was missing. Recovered room history:\n[Jane]: previous context\n[User]: Third message",
    }]);
  });

  it("reports its turn timeout without waiting on an abort the wedged server never answers", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    // A server wedged enough to blow the turn timeout is equally capable of
    // never answering the abort. Reporting the timeout is what frees the room,
    // so it cannot depend on the peer we just gave up on.
    client.abortNeverSettles = true;
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      config: { turnTimeoutMs: 30 },
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("Never responds"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-wedged-abort" },
      ),
    );

    expect(client.aborts).toEqual([client.createdSessions[0]!]);
    expect((findFailureEvent(tools)?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      code: "timeout",
    });
  });

  it("fails the turn (so PlatformRuntime retries it) on OpenCode's own session.error signal, instead of resolving as if it processed", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    const pending = adapter.onMessage(
      makeMessage("Trigger a provider-level error"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-session-error" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "ProviderError", data: { message: "The model is unavailable." } },
      },
    });

    await expectTurnFailed(pending);

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      code: null,
      message: "ProviderError: The model is unavailable.",
    });
  });

  it("fails the turn on session.error even when fallbackSendAgentText is disabled, instead of silently dropping the failure", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
      config: { fallbackSendAgentText: false },
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    const pending = adapter.onMessage(
      makeMessage("Trigger a provider-level error"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-session-error-no-fallback" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "ProviderError", data: { message: "The model is unavailable." } },
      },
    });

    await expectTurnFailed(pending);

    const failureEvent = findFailureEvent(tools);
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      message: "ProviderError: The model is unavailable.",
    });
  });

  it("fails the turn on session.error even when partial text streamed first, after delivering that partial text", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    const pending = adapter.onMessage(
      makeMessage("Trigger a provider-level error after some text"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-session-error-partial-text" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    emitAssistantText(client, sessionId, "partial progress");
    client.eventQueue.push({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "ProviderError", data: { message: "The model is unavailable." } },
      },
    });

    await expectTurnFailed(pending);

    expect(tools.messages).toContain("partial progress");
    const failureEvent = findFailureEvent(tools);
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      message: "ProviderError: The model is unavailable.",
    });
  });

  it("resolves the turn normally when a message carries its own error but the session still completes via session.idle", async () => {
    const tools = new FakeTools();
    const client = new FakeOpencodeClient();
    createdClients.push(client);
    const adapter = new OpencodeAdapter({
      clientFactory: () => client as any,
      mcpBackendFactory: httpMcpBackend(),
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    const pending = adapter.onMessage(
      makeMessage("Recover from one message's own reported error"),
      tools,
      { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-message-level-error" },
    );

    await waitFor(() => client.createdSessions.length === 1);
    const sessionId = client.createdSessions[0]!;
    client.eventQueue.push({
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-message-1",
          role: "assistant",
          sessionID: sessionId,
          error: { name: "ToolError", data: { message: "tool timed out, retrying" } },
        },
      },
    });
    emitAssistantText(client, sessionId, "recovered and finished the task");
    client.eventQueue.push({ type: "session.idle", properties: { sessionID: sessionId } });

    await pending;

    expect(tools.messages).toContain("recovered and finished the task");
    expect(findFailureEvent(tools)).toBeUndefined();
  });

  it("reports and fails the turn when client startup throws, instead of resolving as if it processed", async () => {
    const tools = new FakeTools();
    const adapter = new OpencodeAdapter({
      clientFactory: () => {
        throw new Error("boom - can't start client");
      },
    });
    adapters.push(adapter);

    await adapter.onStarted("OpenCode Agent", "Writes code");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("First message"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-client-start-error" },
      ),
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as any)?.failure).toMatchObject({
      provider: "opencode",
      message: "OpenCode failed while processing the message: boom - can't start client",
    });
  });

  describeDeliveryContract([{
    path: "assistant text flushed on session idle",
    turn: async (tools) => {
      const client = new FakeOpencodeClient();
      createdClients.push(client);
      const adapter = new OpencodeAdapter({
        clientFactory: () => client as any,
        mcpBackendFactory: httpMcpBackend(),
      });
      adapters.push(adapter);

      await adapter.onStarted("OpenCode Agent", "Writes code");
      const pending = adapter.onMessage(
        makeMessage("Deliver a reply that fails to send"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-delivery-failure" },
      );

      await waitFor(() => client.createdSessions.length === 1);
      const sessionId = client.createdSessions[0]!;
      emitAssistantText(client, sessionId, "Here is the fix.");
      client.eventQueue.push({ type: "session.idle", properties: { sessionID: sessionId } });

      await pending;
    },
  }, {
    path: "interactive approval prompt",
    turn: async (tools) => {
      const client = new FakeOpencodeClient();
      createdClients.push(client);
      const adapter = new OpencodeAdapter({
        clientFactory: () => client as any,
        mcpBackendFactory: httpMcpBackend(),
      });
      adapters.push(adapter);

      await adapter.onStarted("OpenCode Agent", "Writes code");
      const pending = adapter.onMessage(
        makeMessage("Need approval flow"),
        tools,
        { sessionId: null, roomId: null, createdAt: null, replayMessages: [] },
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-delivery-failure-permission" },
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

      await pending;
    },
  }]);
});

import type { AgentSideConnection, Agent as AcpAgent, PermissionOption, PromptRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter, type ACPClientAdapterOptions } from "../src/adapters/acp";
import { Agent } from "../src/agent/Agent";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { createDeferred } from "../src/core/deferred";
import { UnsupportedFeatureError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

const ROOM = "room-1";
const ALLOW_ONCE: PermissionOption = { kind: "allow_once", optionId: "allow", name: "Allow" };

/**
 * A real ACP agent behind the adapter. Each prompt runs `onPrompt`; a
 * `session/cancel` settles the running prompt's `cancelled`.
 */
function harness(onPrompt: (peer: AgentSideConnection, request: PromptRequest, cancelled: Promise<void>) => Promise<{ stopReason: "end_turn" | "cancelled" }>) {
  const record = { connections: 0, stops: 0, sessions: [] as string[], prompts: [] as string[], cancels: [] as string[] };
  let cancelled = createDeferred();
  const sessionHolds: Array<{ requested: () => void; answered: Promise<boolean> }> = [];
  const connectionFactory = inMemoryAgent((peer): AcpAgent => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
    authenticate: async () => ({}),
    newSession: async () => {
      const hold = sessionHolds.shift();
      hold?.requested();
      if (hold && !(await hold.answered)) {
        throw new Error("session/new failed");
      }
      const sessionId = `session-${record.sessions.length + 1}`;
      record.sessions.push(sessionId);
      return { sessionId };
    },
    cancel: async ({ sessionId }) => {
      record.cancels.push(sessionId);
      cancelled.resolve();
    },
    prompt: async (request) => {
      record.prompts.push(request.sessionId);
      cancelled = createDeferred();
      return onPrompt(peer, request, cancelled.promise);
    },
  }), () => { record.stops += 1; });
  return {
    record,
    /** Holds the next `session/new`: `requested` settles once it arrives, and it answers on `succeed` or `fail`. */
    holdNextSession: () => {
      const requested = createDeferred();
      const answered = createDeferred<boolean>();
      sessionHolds.push({ requested: () => requested.resolve(), answered: answered.promise });
      onTestFinished(() => answered.resolve(true));
      return { requested: requested.promise, succeed: () => answered.resolve(true), fail: () => answered.resolve(false) };
    },
    options: {
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: async (...args: Parameters<typeof connectionFactory>) => {
        record.connections += 1;
        return connectionFactory(...args);
      },
    } satisfies ACPClientAdapterOptions,
  };
}

async function startAgent(adapter: FrameworkAdapter) {
  const platform = BandPlatform.host([person("owner")]);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
  });
  await agent.start();
  onTestFinished(async () => { await agent.stop(); });
  return { agent, room: await platform.room(ROOM) };
}

const say = (peer: AgentSideConnection, sessionId: string, text: string) =>
  peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

const askToEdit = (peer: AgentSideConnection, sessionId: string, toolCallId: string): Promise<RequestPermissionResponse> =>
  peer.requestPermission({ sessionId, toolCall: { toolCallId, title: "Edit file" }, options: [ALLOW_ONCE] });

describe("Agent.cancelTurn", () => {
  it("cancels a running ACP turn and keeps the room's harness session for its next turn", async () => {
    const prompting = createDeferred();
    const acp = harness(async (peer, { sessionId }, cancelled) => {
      if (acp.record.prompts.length === 1) {
        await say(peer, sessionId, "partial answer");
        prompting.resolve();
        await cancelled;
        return { stopReason: "cancelled" };
      }
      await say(peer, sessionId, "second answer");
      return { stopReason: "end_turn" };
    });
    const { agent, room } = await startAgent(new ACPClientAdapter(acp.options));

    expect(await agent.cancelTurn(ROOM), "no turn has run yet").toBe(false);

    const first = await room.say("owner", "start a long task");
    await prompting.promise;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(first)).toBe("processed");
    expect(acp.record.cancels).toEqual(["session-1"]);
    expect(room.posted, "a cancelled turn posts nothing").toEqual([]);
    expect(await agent.cancelTurn(ROOM), "the turn already ended").toBe(false);

    const second = await room.say("owner", "try again");
    expect(await room.outcome(second)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["second answer"]);
    expect(acp.record).toMatchObject({
      connections: 1,
      stops: 0,
      sessions: ["session-1"],
      prompts: ["session-1", "session-1"],
    });
  });

  it("answers the turn's pending permission request cancelled", async () => {
    const asked = createDeferred();
    const reasons: unknown[] = [];
    const decisions: RequestPermissionResponse[] = [];
    const acp = harness(async (peer, { sessionId }, cancelled) => {
      decisions.push(await askToEdit(peer, sessionId, "edit"));
      await cancelled;
      return { stopReason: "cancelled" };
    });
    const adapter = new ACPClientAdapter({
      ...acp.options,
      resolvePermission: (_request, signal) => {
        const answer = createDeferred<string | undefined>();
        signal.addEventListener("abort", () => { reasons.push(signal.reason); answer.resolve(undefined); });
        asked.resolve();
        return answer.promise;
      },
    });
    const { agent, room } = await startAgent(adapter);

    const message = await room.say("owner", "edit the file");
    await asked.promise;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(message)).toBe("processed");
    expect(decisions).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(reasons).toEqual(["turn-cancelled"]);
    expect(acp.record).toMatchObject({ stops: 0, cancels: ["session-1"] });
  });

  it.each([
    { approver: "a resolver", withResolver: true },
    { approver: "the automatic choice", withResolver: false },
  ])("refuses a permission request made after the cancel, without asking $approver, and approves again on the next turn", async ({ withResolver }) => {
    const prompting = createDeferred();
    const decisions: string[] = [];
    const resolverAsked: string[] = [];
    const acp = harness(async (peer, { sessionId }, cancelled) => {
      const turn = acp.record.prompts.length;
      if (turn === 1) {
        prompting.resolve();
        await cancelled;
      }
      decisions.push((await askToEdit(peer, sessionId, `edit-${turn}`)).outcome.outcome);
      if (turn === 1) {
        return { stopReason: "cancelled" };
      }
      await say(peer, sessionId, "edited");
      return { stopReason: "end_turn" };
    });
    const adapter = new ACPClientAdapter({
      ...acp.options,
      ...(withResolver
        ? { resolvePermission: async ({ toolCall }) => { resolverAsked.push(toolCall.toolCallId); return ALLOW_ONCE.optionId; } }
        : {}),
    });
    const { agent, room } = await startAgent(adapter);

    const first = await room.say("owner", "edit the file");
    await prompting.promise;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(first)).toBe("processed");
    expect(room.posted, "the refused request is not announced").toEqual([]);

    const second = await room.say("owner", "edit it now");
    expect(await room.outcome(second)).toBe("processed");
    expect(decisions).toEqual(["cancelled", "selected"]);
    expect(resolverAsked).toEqual(withResolver ? ["edit-2"] : []);
    expect(acp.record).toMatchObject({ stops: 0, sessions: ["session-1"], prompts: ["session-1", "session-1"] });
  });

  it("refuses an automatic approval that a cancel overtakes", async () => {
    const decisions: string[] = [];
    const acp = harness(async (peer, { sessionId }, cancelled) => {
      decisions.push((await askToEdit(peer, sessionId, "edit")).outcome.outcome);
      await cancelled;
      return { stopReason: "cancelled" };
    });
    const { agent, room } = await startAgent(new ACPClientAdapter(acp.options));
    const announcement = room.holdEvent((content) => content.startsWith("Permission requested"));

    const message = await room.say("owner", "edit the file");
    await announcement.sending;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    announcement.release();
    expect(await room.outcome(message)).toBe("processed");
    expect(decisions).toEqual(["cancelled"]);
  });

  it("ends a turn cancelled while session/new is unanswered, and keeps that session for the next turn", async () => {
    const acp = harness(async (peer, { sessionId }) => {
      await say(peer, sessionId, "answer");
      return { stopReason: "end_turn" };
    });
    const session = acp.holdNextSession();
    const { agent, room } = await startAgent(new ACPClientAdapter(acp.options));

    const first = await room.say("owner", "first");
    await session.requested;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(first), "settled while session/new is still unanswered").toBe("processed");
    expect(acp.record.sessions).toEqual([]);

    const second = await room.say("owner", "second");
    session.succeed();
    expect(await room.outcome(second)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["answer"]);
    expect(acp.record).toMatchObject({ connections: 1, stops: 0, sessions: ["session-1"], prompts: ["session-1"], cancels: [] });
  });

  it("leaves a cancelled turn settled when its session/new fails afterwards", async () => {
    const lateFailure = createDeferred<unknown>();
    const acp = harness(async (peer, { sessionId }) => {
      await say(peer, sessionId, "answer");
      return { stopReason: "end_turn" };
    });
    const session = acp.holdNextSession();
    const adapter = new ACPClientAdapter({
      ...acp.options,
      logger: {
        debug: () => {},
        info: () => {},
        error: () => {},
        warn: (message, context) => {
          if (message === "acp_client.cancelled_turn_wait_failed") lateFailure.resolve(context);
        },
      },
    });
    const { agent, room } = await startAgent(adapter);

    const first = await room.say("owner", "first");
    await session.requested;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    expect(await room.outcome(first)).toBe("processed");
    session.fail();
    expect(await lateFailure.promise).toMatchObject({ roomId: ROOM, error: expect.stringContaining("session/new failed") });

    const second = await room.say("owner", "second");
    expect(await room.outcome(second)).toBe("processed");
    expect(room.outcomes(first), "the late failure does not settle the message again").toEqual(["processed"]);
    expect(room.failures).toEqual([]);
    expect(acp.record).toMatchObject({ connections: 1, stops: 0, sessions: ["session-1"], prompts: ["session-1"] });
  });

  it("rejects for an adapter that cannot cancel a turn", async () => {
    const adapter: FrameworkAdapter = {
      onEvent: async () => {},
      onCleanup: async () => {},
      onStarted: async () => {},
    };
    const agent = Agent.create({ adapter, agentId: AGENT_ID, apiKey: AGENT_API_KEY });
    await expect(agent.cancelTurn(ROOM)).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});

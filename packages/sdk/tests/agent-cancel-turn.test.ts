import type { AgentSideConnection, Agent as AcpAgent, PromptRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
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

/**
 * A real ACP agent behind the adapter. Each prompt runs `onPrompt`; a
 * `session/cancel` settles the running prompt's `cancelled`.
 */
function harness(onPrompt: (peer: AgentSideConnection, request: PromptRequest, cancelled: Promise<void>) => Promise<{ stopReason: "end_turn" | "cancelled" }>) {
  const record = { connections: 0, stops: 0, sessions: [] as string[], prompts: [] as string[], cancels: [] as string[] };
  let cancelled = createDeferred();
  const sessionHolds: Array<{ requested: () => void; released: Promise<void> }> = [];
  const connectionFactory = inMemoryAgent((peer): AcpAgent => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
    authenticate: async () => ({}),
    newSession: async () => {
      const hold = sessionHolds.shift();
      hold?.requested();
      await hold?.released;
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
    /** Holds the next `session/new`: `requested` settles once it arrives, and it answers after `release`. */
    holdNextSession: () => {
      const requested = createDeferred();
      const released = createDeferred();
      sessionHolds.push({ requested: () => requested.resolve(), released: released.promise });
      onTestFinished(() => released.resolve());
      return { requested: requested.promise, release: () => released.resolve() };
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
      decisions.push(await peer.requestPermission({
        sessionId,
        toolCall: { toolCallId: "edit", title: "Edit file" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }],
      }));
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

  it("never sends a prompt cancelled while its session is still being established", async () => {
    const acp = harness(async (peer, { sessionId }) => {
      await say(peer, sessionId, "answer");
      return { stopReason: "end_turn" };
    });
    const session = acp.holdNextSession();
    const { agent, room } = await startAgent(new ACPClientAdapter(acp.options));

    const first = await room.say("owner", "first");
    await session.requested;
    expect(await agent.cancelTurn(ROOM)).toBe(true);
    session.release();
    expect(await room.outcome(first)).toBe("processed");
    expect(acp.record.prompts, "the cancelled turn's prompt was never sent").toEqual([]);
    expect(room.posted).toEqual([]);

    const second = await room.say("owner", "second");
    expect(await room.outcome(second)).toBe("processed");
    expect(acp.record).toMatchObject({ stops: 0, sessions: ["session-1"], prompts: ["session-1"], cancels: [] });
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

import { AgentSideConnection, ndJsonStream, ClientSideConnection, type Agent, type AnyMessage, type Client } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ACPClientAdapter } from "../src/adapters/acp/ACPClientAdapter";
import { createSubprocessConnection } from "../src/adapters/acp/ACPRoomAgent";
import { BandPlatform, person } from "./flows/support/bandPlatform";
import { activitySequence, recordRuntimeActivity } from "./support/activityReports";
import { activityWhileProviderFails } from "./support/providerFailure";
import { BandACPClient, type PromptActivity } from "../src/adapters/acp/client";
import { observeNativeToolCalls } from "../src/adapters/acp/toolCalls";
import { MCP_SERVER_NAME } from "../src/contracts/toolSchemas";
import { createDeferred } from "../src/core/deferred";
import { trackNativeActivity } from "../src/runtime/workingState";
import { CallHolds, makeLoggerSpy, RecordLog, tmpRoot } from "./testUtils";
import { scopedActivity } from "./support/scopedActivity";
import type { RecordingRestApi } from "./flows/support/bandPlatform";
import type { CollectedChunk } from "../src/adapters/acp/types";
import { fileURLToPath } from "node:url";

const fakeAcpAgentPath = fileURLToPath(new URL("./fixtures/fakeAcpAgent.mjs", import.meta.url));
const ALLOW = { outcome: { outcome: "selected", optionId: "allow" } } as const;
const ASK = { options: [{ kind: "allow_once" as const, optionId: "allow", name: "Allow" }] };

/** What a prompt told its activity, in order, with `written` marking each response that reached the pipe. */
function activityLog() {
  const log = new RecordLog<string>();
  const activity: PromptActivity = {
    observe: (chunk) => log.record(`observed:${String(chunk.metadata.tool_call_id)}`),
    permission: (waiting) => log.record(waiting ? "permission" : "permission-ended"),
    end: () => log.record("ended"),
  };
  return { log, activity };
}

/**
 * A real ACP agent peer over an in-memory pipe, with the client's
 * responses observable and holdable at the pipe.
 */
function acpPeer(client: BandACPClient, served: Agent, log: RecordLog<string>, forward: Client = client) {
  let closeToPeer!: () => void;
  let closeToClient!: () => void;
  const toPeer = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeToPeer = () => controller.terminate(); } });
  const toClient = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeToClient = () => controller.terminate(); } });
  const agent = new AgentSideConnection(() => served, ndJsonStream(toClient.writable, toPeer.readable));
  const pipe = ndJsonStream(toPeer.writable, toClient.readable);
  const writer = pipe.writable.getWriter();
  const holds = new CallHolds<[id: string]>();
  const connection = new ClientSideConnection(() => forward, client.observeStream({
    readable: pipe.readable,
    writable: new WritableStream<AnyMessage>({ write: async (message) => {
      const isResponse = !("method" in message);
      if (isResponse) await holds.pass(String(message.id));
      await writer.write(message);
      if (isResponse) log.record("written");
    } }),
  }));
  onTestFinished(async () => {
    closeToPeer();
    closeToClient();
    await Promise.all([connection.closed, agent.closed]);
  });
  return { agent, connection, holds };
}

const idleAgent = (prompt: Agent["prompt"] = async () => ({ stopReason: "end_turn" })): Agent => ({
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
  authenticate: async () => ({}),
  newSession: async () => ({ sessionId: "session" }),
  cancel: async () => {},
  prompt,
});

const toolCallFrame = (metadata: CollectedChunk["metadata"], chunkType: CollectedChunk["chunkType"] = "tool_call", content = ""): CollectedChunk =>
  ({ chunkType, content, metadata, streamed: false });

describe("ACP activity at the real JSON-RPC boundary", () => {
  it("keeps idle extension notifications ownerless when their handler finishes during the next prompt", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const delivered = createDeferred();
    const { log, activity } = activityLog();
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }), {
      extNotification: async () => {
        entered.resolve();
        await release.promise;
        return [toolCallFrame({ tool_call_id: "idle-call", kind: "execute", status: "in_progress" }, "tool_call", "old command")];
      },
    });
    client.beginSession("session");
    const peer = acpPeer(client, idleAgent(async () => {
      await delivered.promise;
      return { stopReason: "end_turn" };
    }), log, {
      requestPermission: (params) => client.requestPermission(params),
      sessionUpdate: (params) => client.sessionUpdate(params),
      extNotification: async (method, params) => {
        try { await client.extNotification(method, params); }
        finally { delivered.resolve(); }
      },
    });
    onTestFinished(() => release.resolve());
    await peer.agent.extNotification("_vendor/native_tools", { sessionId: "session" });
    await entered.promise;
    const owner = client.enterPromptSession("session", activity);
    const prompt = owner.run(() => peer.connection.prompt({ sessionId: "session", prompt: [{ type: "text", text: "next request" }] }));
    release.resolve();
    await prompt;
    expect(log.entries).toEqual(["ended"]);
    expect(client.takeCollectedChunks("session")).toMatchObject([{ metadata: { tool_call_id: "idle-call" } }]);
  });

  async function buffersInWireOrder(
    client: BandACPClient,
    emit: (agent: AgentSideConnection, observing: Promise<void>) => Promise<void>,
  ) {
    const observing = createDeferred();
    const { log } = activityLog();
    client.beginSession("session");
    const owner = client.enterPromptSession("session", {
      observe: () => observing.resolve(),
      permission: () => {},
      end: () => {},
    });
    const peer = acpPeer(client, idleAgent(async () => {
      await emit(peer.agent, observing.promise);
      await observing.promise;
      return { stopReason: "end_turn" };
    }), log);
    await owner.run(() => peer.connection.prompt({ sessionId: "session", prompt: [{ type: "text", text: "run" }] }));
    const flushed = client.takeCollectedChunks("session");
    expect(client.takeCollectedChunks("session")).toEqual([]);
    return flushed.map(({ chunkType }) => chunkType);
  }

  it("buffers native notifications in wire order before the prompt resolves", async () => {
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }));
    expect(await buffersInWireOrder(client, async (agent, observing) => {
      await agent.sessionUpdate({ sessionId: "session", update: { sessionUpdate: "tool_call", toolCallId: "native", title: "Bash", kind: "execute", status: "in_progress" } });
      await observing;
      await agent.sessionUpdate({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
    })).toEqual(["tool_call", "text"]);
  });

  it("buffers extension notifications in wire order before the prompt resolves", async () => {
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }), {
      extNotification: async () => [
        toolCallFrame({ tool_call_id: "native", status: "in_progress", kind: "execute" }, "tool_call", "Bash"),
        { chunkType: "text", content: "Done.", metadata: {}, streamed: true },
      ],
    });
    expect(await buffersInWireOrder(client, async (agent) => {
      await agent.extNotification("_cursor/native_tools", { sessionId: "session" });
    })).toEqual(["tool_call", "text"]);
  });

  it("keeps a human wait through each response write", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const secondAsked = createDeferred();
    const provider = createDeferred();
    const { log, activity } = activityLog();
    const client = new BandACPClient("room", async ({ toolCall }) => {
      if (toolCall.toolCallId === "two") secondAsked.resolve();
      await (toolCall.toolCallId === "one" ? first : second).promise;
      return ALLOW;
    }, undefined, () => true);
    client.beginSession("session");
    const work = client.enterPromptSession("session", activity).run(() => provider.promise);
    const peer = acpPeer(client, idleAgent(), log);
    const heldOne = peer.holds.hold(() => true);
    const heldTwo = peer.holds.hold(() => true);
    onTestFinished(() => { first.resolve(); second.resolve(); provider.resolve(); heldOne.release(); heldTwo.release(); });
    const ask = (id: string) => peer.agent.requestPermission({ sessionId: "session", toolCall: { toolCallId: id, title: "approval" }, ...ASK });
    const answers = [ask("one"), ask("two")];
    await secondAsked.promise;
    first.resolve();
    await heldOne.sending;
    expect(log.entries).toEqual(["permission"]);
    heldOne.release();
    await log.next((entry) => entry === "written");
    expect(log.entries).toEqual(["permission", "written"]);
    second.resolve();
    await heldTwo.sending;
    heldTwo.release();
    await log.next((entry) => entry === "permission-ended");
    expect(log.entries).toEqual(["permission", "written", "written", "permission-ended"]);
    expect(await Promise.all(answers)).toEqual([ALLOW, ALLOW]);
    provider.resolve();
    await work;
  });

  it("reports no wait for an automatic decision", async () => {
    const { log, activity } = activityLog();
    const client = new BandACPClient("room", async () => ALLOW, undefined, () => false);
    client.beginSession("session");
    const owner = client.enterPromptSession("session", activity);
    const peer = acpPeer(client, idleAgent(), log);
    const work = owner.run(() => peer.agent.requestPermission({ sessionId: "session", toolCall: { toolCallId: "auto", title: "approval" }, ...ASK }));
    expect(await work).toEqual(ALLOW);
    await log.next((entry) => entry === "written");
    expect(log.entries.filter((entry) => entry.startsWith("permission"))).toEqual([]);
  });

  it("ends the wait a prompt left open when it stops waiting for the agent", async () => {
    const asked = createDeferred();
    const unanswered = createDeferred();
    const provider = createDeferred();
    const { log, activity } = activityLog();
    const client = new BandACPClient("room", async () => {
      asked.resolve();
      await unanswered.promise;
      return ALLOW;
    }, undefined, () => true);
    client.beginSession("session");
    const owner = client.enterPromptSession("session", activity);
    const work = owner.run(() => provider.promise);
    const peer = acpPeer(client, idleAgent(), log);
    onTestFinished(() => { unanswered.resolve(); provider.resolve(); });
    const answer = peer.agent.requestPermission({ sessionId: "session", toolCall: { toolCallId: "ask", title: "approval" }, ...ASK });
    await asked.promise;
    owner.release();
    expect(log.entries).toEqual(["permission", "permission-ended", "ended"]);
    unanswered.resolve();
    await answer;
    provider.resolve();
    await work;
  });

  it("ends a prompt's open activity when the engine retires the client", async () => {
    const { log, activity } = activityLog();
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }));
    const owner = client.enterPromptSession("session", activity);
    client.retire();
    expect(log.entries).toEqual(["ended"]);
    owner.release();
    expect(log.entries).toEqual(["ended"]);
  });

  it("does not report a call id an earlier prompt of the session already owned", async () => {
    const observed: string[] = [];
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }));
    const prompt = (name: string): PromptActivity => ({ observe: () => { observed.push(name); }, permission: () => {}, end: () => {} });
    const update = (id: string) => client.sessionUpdate({ sessionId: "first", update: {
      sessionUpdate: "tool_call", toolCallId: id, title: "Bash", kind: "execute", status: "in_progress",
    } });
    client.beginSession("first");
    await client.enterPromptSession("first", prompt("old")).run(() => update("known"));
    await client.enterPromptSession("first", prompt("replacement")).run(async () => {
      await update("known");
      await update("new");
    });
    expect(observed).toEqual(["old", "replacement"]);
  });

  it("stops reporting a session while an abandoned prompt still runs, and resumes once it settles", async () => {
    const observed: string[] = [];
    const logger = makeLoggerSpy();
    const settle = createDeferred();
    const client = new BandACPClient("room", async () => ({ outcome: { outcome: "cancelled" } }), undefined, undefined, logger);
    const prompt = (name: string): PromptActivity => ({ observe: () => { observed.push(name); }, permission: () => {}, end: () => {} });
    const update = (sessionId: string, id: string) => client.sessionUpdate({ sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: id, title: "Bash", kind: "execute", status: "in_progress",
    } });
    client.beginSession("first");
    client.beginSession("fresh");
    const abandoned = client.enterPromptSession("first", prompt("abandoned"));
    const settled = abandoned.run(() => settle.promise);
    abandoned.release();
    await client.enterPromptSession("first", prompt("ambiguous")).run(() => update("first", "unseen"));
    await client.enterPromptSession("fresh", prompt("fresh")).run(() => update("fresh", "unseen"));
    settle.resolve();
    await settled;
    await client.enterPromptSession("first", prompt("resumed")).run(() => update("first", "later"));
    expect(observed).toEqual(["fresh", "resumed"]);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("acp_client.prompt_abandoned_in_flight", { roomId: "room", sessionId: "first" });
  });
});

describe("native tool call observation", () => {
  /** What a prompt's native frames publish, delivering each before the next so none coalesce. */
  async function published(frames: readonly CollectedChunk[], bandToolsAreLocal = false) {
    await using scope = await scopedActivity();
    const observe = observeNativeToolCalls(trackNativeActivity(scope.tools, new Set()), bandToolsAreLocal);
    for (const frame of frames) {
      observe(frame);
      await scope.lease.flush();
    }
    return [...scope.reports.entries];
  }
  const start = toolCallFrame({ tool_call_id: "call", kind: "execute", status: "in_progress" });
  const bandCall = toolCallFrame({ tool_call_id: "band", status: "in_progress", raw_input: { server: MCP_SERVER_NAME, tool: "band_send_message", arguments: {} } });

  it.each(["completed", "failed"])("ends a call on %s", async (status) => {
    expect(await published([start, toolCallFrame({ tool_call_id: "call", status }, "tool_result")]))
      .toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "execute" }, { kind: "reasoning" }]);
  });

  it("does not restart a call after its terminal status", async () => {
    expect(await published([
      start,
      toolCallFrame({ tool_call_id: "call", status: "completed" }, "tool_result"),
      toolCallFrame({ tool_call_id: "call", status: "in_progress" }, "tool_result"),
    ])).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "execute" }, { kind: "reasoning" }]);
  });

  it("reports nothing for a call that names no tool or category", async () => {
    expect(await published([toolCallFrame({ tool_call_id: "call", status: "in_progress" }, "tool_call", "private command")]))
      .toEqual([{ kind: "reasoning" }]);
  });

  it("keeps a running call published when another call that never started ends", async () => {
    expect(await published([start, toolCallFrame({ tool_call_id: "other", status: "completed" }, "tool_result")]))
      .toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "execute" }]);
  });

  it("leaves a Band tool to its own execution when Band runs it", async () => {
    expect(await published([bandCall, toolCallFrame({ tool_call_id: "band", status: "completed" }, "tool_result")], true))
      .toEqual([{ kind: "reasoning" }]);
  });

  it("reports a Band tool the runtime runs on its own", async () => {
    expect(await published([bandCall])).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: `${MCP_SERVER_NAME}-band_send_message` }]);
  });
});

/** A connection factory serving `served` over in-memory pipes, to the adapter's own client. */
function inMemoryAgent(served: (peer: AgentSideConnection) => Agent, onStop: () => void = () => {}) {
  return async (client: Client) => {
    let closeOutgoing!: () => void;
    let closeIncoming!: () => void;
    const outgoing = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeOutgoing = () => controller.terminate(); } });
    const incoming = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => { closeIncoming = () => controller.terminate(); } });
    const peer = new AgentSideConnection(served, ndJsonStream(incoming.writable, outgoing.readable));
    const connection = new ClientSideConnection(() => client, ndJsonStream(outgoing.writable, incoming.readable));
    return { connection, stop: async () => {
      onStop(); closeOutgoing(); closeIncoming();
      await Promise.all([connection.closed, peer.closed]);
    } };
  };
}

/** Starts `adapter` on a platform with one room, and returns how to send it a message. */
async function startAdapter(adapter: ACPClientAdapter, rest?: RecordingRestApi, config?: Parameters<typeof BandPlatform.start>[3]) {
  const platform = await BandPlatform.start(adapter, [person("owner")], rest, config);
  onTestFinished(() => platform[Symbol.asyncDispose]());
  const room = await platform.room("room-1");
  return { room, say: () => room.say("owner", "run it") };
}

const nativeToolStart = { sessionUpdate: "tool_call", toolCallId: "native-call", title: "private command sentinel", status: "pending" } as const;

describe("ACP native activity through the adapter", () => {
  it.each([
    { source: "initial", frame: { kind: "execute" as const }, before: [] },
    { source: "late", frame: {}, before: [] },
    { source: "changed", frame: { kind: "fetch" as const }, before: [{ kind: "tool_call", name: "fetch" }] },
  ])("observes native categories supplied in $source frames", async ({ frame, before }) => {
    const reports = recordRuntimeActivity();
    const adapter = new ACPClientAdapter({ command: ["native-fixture"], cwd: tmpRoot(), enableMcpTools: false,
      connectionFactory: inMemoryAgent((agent) => idleAgent(async ({ sessionId }) => {
        await agent.sessionUpdate({ sessionId, update: { ...nativeToolStart, ...frame } });
        if (before.length > 0) await reports.next((entry) => entry.activity?.kind === "tool_call");
        await agent.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "native-call", kind: "execute", status: "in_progress" } });
        await reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === "execute");
        await agent.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "native-call", status: "completed" } });
        await agent.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
        return { stopReason: "end_turn" };
      })),
    });
    const { room, say } = await startAdapter(adapter);
    expect(await room.outcome(await say())).toBe("processed");
    expect(activitySequence(reports)).toEqual([{ kind: "reasoning" }, ...before, { kind: "tool_call", name: "execute" }, { kind: "reasoning" }, false]);
    expect(JSON.stringify(reports.entries)).not.toContain("private command sentinel");
  });

  it("ends a native call the agent never finished before the turn timeout's failure is delivered", async () => {
    const hang = createDeferred();
    onTestFinished(() => hang.resolve());
    const adapter = new ACPClientAdapter({ command: ["native-fixture"], cwd: tmpRoot(), enableMcpTools: false, turnTimeoutMs: 50,
      connectionFactory: inMemoryAgent((agent) => idleAgent(async ({ sessionId }) => {
        await agent.sessionUpdate({ sessionId, update: { ...nativeToolStart, kind: "execute", status: "in_progress" } });
        await hang.promise;
        return { stopReason: "end_turn" };
      }), () => hang.resolve()),
    });
    expect(await activityWhileProviderFails(adapter)).toEqual({ kind: "reasoning" });
  });
});

describe("ACP permission wait through a real agent process", () => {
  it("holds the wait until the response is on the pipe", async () => {
    const reports = recordRuntimeActivity();
    const answer = createDeferred<string | undefined>();
    const writes = new CallHolds<[id: string]>();
    const held = writes.hold(() => true);
    onTestFinished(() => { answer.resolve("allow"); held.release(); });
    const adapter = new ACPClientAdapter({
      command: [process.execPath, fakeAcpAgentPath], cwd: tmpRoot(), enableMcpTools: false,
      env: { FAKE_ACP_ASK_PERMISSION: "1" },
      resolvePermission: () => answer.promise,
      connectionFactory: async (given, options) => {
        const client = given as BandACPClient;
        const observe = client.observeStream.bind(client);
        vi.spyOn(client, "observeStream").mockImplementation((stream) => {
          const writer = stream.writable.getWriter();
          return observe({ readable: stream.readable, writable: new WritableStream<AnyMessage>({
            write: async (message) => {
              if (!("method" in message)) await writes.pass(String(message.id));
              await writer.write(message);
            },
            close: () => writer.close(),
            abort: (reason: unknown) => writer.abort(reason),
          }) });
        });
        return await createSubprocessConnection(client, options);
      },
    });
    const { room, say } = await startAdapter(adapter, undefined, { enableWorkingState: true, workingKeepAliveSeconds: 0.02, workingRequestTimeoutSeconds: 0.01 });
    const message = await say();
    await reports.next((entry) => entry.activity?.kind === "permission");
    answer.resolve("allow");
    await held.sending;
    const heartbeat = await reports.next(() => true, reports.entries.length);
    expect(heartbeat.activity).toEqual({ kind: "permission" });
    held.release();
    expect(await room.outcome(message)).toBe("processed");
    expect(activitySequence(reports).slice(-2)).toEqual([{ kind: "reasoning" }, false]);
  });
});
